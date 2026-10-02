import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { canonicalJson, computeQueryId, privatePayloadHash, ZERO32 } from "@mochi/core";
import { aad, payerCommit, recipientKeyHash, type PrivateResultPlain } from "@mochi/protocol";
import { createReceiptSigner, buildAnchorBatch, type VerdictReceiptInput } from "@mochi/receipts";
import { MockTeeProvider, MockQuoteVerifier, seal } from "@mochi/tee";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex, type WalletClient } from "viem";
import type { Deployment } from "@mochi/chain";
import { ChainConfigError, GatewayMismatchError, IntakeBindingError, MochiClient } from "../src/client.ts";
import { chainQuote, fakeChain, fakeIntakeReply, honestOpenData, honestQuery, honestQueryId, TEST_CHAIN_ID, TEST_DISCLOSURES, TEST_ESCROW, type IntakeReplyOptions, type OnChainVerdictRecord } from "./fake-intake.ts";

const measurement = `0x${"11".repeat(32)}` as Hex;
const root = privateKeyToAccount(`0x${"22".repeat(32)}`);
const intake = new MockTeeProvider({ seed: `0x${"33".repeat(32)}`, measurement, mockRoot: root });
const rogue = new MockTeeProvider({ seed: `0x${"34".repeat(32)}`, measurement, mockRoot: root });
const intakeAddress = intake.signer().address as Address;
const sender = "0x0000000000000000000000000000000000000001" as Address;
const upload = { schema: 3, document: { bytes: new Uint8Array([1]), contentType: "text/plain" }, isPublic: false, sender } as const;

type Chain = ReturnType<typeof fakeChain>;
type Handler = (url: string, init?: RequestInit) => unknown | Promise<unknown>;

/** A client behind a fake gateway; `chain: null` configures no chain. The intake reply can be tampered per test. */
function fixture(handler?: Handler, options: { chain?: Chain | null; reply?: IntakeReplyOptions; extra?: Record<string, unknown> } = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const chain = options.chain === null ? undefined : options.chain ?? fakeChain({ activeIntakes: [intakeAddress] });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    let data: unknown;
    if (url.endsWith("/v1/intake/attestation")) data = { role: "INTAKE", address: intakeAddress.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement, quote: await intake.quote() };
    else if (url.includes("/v1/intake/")) data = await fakeIntakeReply(intake, String(init?.body), options.reply);
    else data = await handler?.(url, init) ?? {};
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new MochiClient({
    gatewayUrl: "https://gateway.test", indexerUrl: "https://indexer.test", fetch: fetcher, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }),
    intakeMeasurement: measurement, ...(chain ? { chain: { deployment: chain.deployment, publicClient: chain.publicClient } } : {}), ...options.extra,
  } as never);
  return { requests, client, chain: chain! };
}
const gateway: Handler = (url, init) => url.endsWith("/v1/query") ? honestQuery(init) : {};
const lastBody = (requests: Array<{ url: string; init?: RequestInit }>, suffix: string) => JSON.parse(String(requests.filter((r) => r.url.endsWith(suffix)).at(-1)?.init?.body));

describe("MochiClient", () => {
  test("validates intake measurement and report binding before sealing", async () => {
    const good = fixture();
    expect((await good.client.intakeAttestation()).role).toBe("INTAKE");
    const badFetch = (async () => {
      const q = await intake.quote();
      return Response.json({ role: "INTAKE", address: intakeAddress.toLowerCase(), encryptionPubKey: intake.encryptionPublicKey(), measurement, quote: { ...q, measurement: `0x${"99".repeat(32)}` } });
    }) as unknown as typeof fetch;
    const bad = new MochiClient({ gatewayUrl: "https://gateway.test", fetch: badFetch, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement });
    await expect(bad.intakeAttestation()).rejects.toThrow("measurement field mismatch");
    const wrongBinding = new MochiClient({ gatewayUrl: "https://gateway.test", fetch: (async () => {
      const quote = await intake.quote();
      return Response.json({ role: "INTAKE", address: intakeAddress.toLowerCase(), encryptionPubKey: `0x${"99".repeat(32)}`, measurement, quote });
    }) as unknown as typeof fetch, quoteVerifier: new MockQuoteVerifier({ mockRootAddress: root.address }), intakeMeasurement: measurement });
    await expect(wrongBinding.intakeAttestation()).rejects.toThrow("unexpected reportData");
  });

  test("prepares public and private envelopes without putting the private key in HTTP bodies", async () => {
    const { client, requests } = fixture(gateway);
    const pub = await client.prepareQuery({ schema: "EARNINGS", document: { bytes: new Uint8Array([7, 8]), contentType: "application/pdf" }, isPublic: true, sender });
    expect(pub.secrets.salt).toBe(ZERO32);
    const priv = await client.prepareQuery({ schema: 3, document: { url: "https://docs.test/x.pdf" }, isPublic: false, sender });
    expect(priv.secrets.salt).not.toBe(pub.secrets.salt);
    expect(priv.secrets.resultPrivateKey).toBeDefined();
    const qBody = lastBody(requests, "/v1/query");
    expect(qBody.payerResultPubKey).toBeDefined();
    const checksummed = "0x986ffc020874b2A6442Fc5264a17FBB43251DB50";
    await client.prepareQuery({ schema: 3, document: { url: "https://docs.test/y.pdf" }, isPublic: true, sender: checksummed, refundTo: checksummed });
    const lowered = lastBody(requests, "/v1/query");
    expect(lowered.intake.provenance.opener).toBe(checksummed.toLowerCase());
    expect(lowered.refundTo).toBe(checksummed.toLowerCase());
    expect(JSON.stringify(requests.map((r) => r.init?.body))).not.toContain(priv.secrets.resultPrivateKey);
    const envelope = JSON.parse(String(requests.find((r) => r.url.includes("/v1/intake/url"))?.init?.body)).envelope;
    const opened = JSON.parse(new TextDecoder().decode(intake.decryptEnvelope(envelope, aad.intake())));
    // The open binding travels sealed with the document: opener, result-key commitment, consent and queryId nonce.
    expect(opened).toMatchObject({ schemaId: 3, salt: priv.secrets.salt, url: "https://docs.test/x.pdf", open: { opener: sender, payerCommit: payerCommit(qBody.payerResultPubKey), isPublic: false, allowPanelDisclosure: false } });
  });

  test("derives queryId, calldata and price from the grant and the chain, never from the gateway", async () => {
    const { client, requests } = fixture(async (url, init) => url.endsWith("/v1/query") ? { ...honestQuery(init), quote: { jurorFees: "1", protocolFee: "0" } } : {});
    const prepared = await client.prepareQuery({ ...upload, n: 5 });
    const body = String(requests.find((r) => r.url.endsWith("/v1/query"))?.init?.body);
    const prov = JSON.parse(body).intake.provenance;
    expect(prepared.queryId).toBe(computeQueryId({ chainId: TEST_CHAIN_ID, escrow: TEST_ESCROW, opener: prov.opener, docCommit: prov.docCommit, nonce: BigInt(prov.nonce) }));
    expect(prepared.tx).toEqual({ to: TEST_ESCROW.toLowerCase() as Address, data: honestOpenData(body) });
    // The gateway's (understated) price is ignored: the quote is QueryEscrow.quote(schemaId, n, tokensK).
    const [jurorFees, protocolFee] = chainQuote(5, prov.tokensK);
    expect(prepared.quote).toEqual({ jurorFees: jurorFees.toString(), protocolFee: protocolFee.toString() });
  });

  test("rejects a substituted queryId or calldata from the gateway", async () => {
    const substituted = fixture(async (url, init) => url.endsWith("/v1/query") ? { ...honestQuery(init), queryId: `0x${"77".repeat(32)}` } : {});
    await expect(substituted.client.prepareQuery(upload)).rejects.toBeInstanceOf(GatewayMismatchError);
    const tampered = fixture(async (url, init) => url.endsWith("/v1/query") ? { ...honestQuery(init), data: "0x1234" } : {});
    await expect(tampered.client.prepareQuery(upload)).rejects.toThrow("unexpected query transaction");
    const otherEscrow = fixture(async (url, init) => url.endsWith("/v1/query") ? { ...honestQuery(init), to: "0x00000000000000000000000000000000000000ee" } : {});
    await expect(otherEscrow.client.prepareQuery(upload)).rejects.toThrow("unexpected query transaction");
  });

  test("rejects an intake grant that differs from the sealed binding", async () => {
    for (const tamper of [{ opener: "0x00000000000000000000000000000000000000ad" }, { payerCommit: `0x${"ad".repeat(32)}` }, { allowPanelDisclosure: true }, { nonce: "1" }]) {
      const { client } = fixture(gateway, { reply: { tamper } });
      await expect(client.prepareQuery(upload)).rejects.toBeInstanceOf(IntakeBindingError);
    }
  });

  test("always requires a valid signature from an active intake key, and a chain to check it against", async () => {
    const none = fixture(gateway, { chain: null });
    await expect(none.client.prepareQuery(upload)).rejects.toBeInstanceOf(ChainConfigError);
    expect(none.requests).toHaveLength(0);
    const wrongNetwork = fixture(gateway, { chain: fakeChain({ activeIntakes: [intakeAddress], rpcChainId: 1 }) });
    await expect(wrongNetwork.client.prepareQuery(upload)).rejects.toBeInstanceOf(ChainConfigError);
    const cases: Array<[IntakeReplyOptions, string]> = [
      [{ result: { intakeSig: "0x" } }, "signature is invalid"], // unsigned
      [{ signer: rogue }, "signature is invalid"], // forged: another enclave's key, naming the attested intake
      [{ escrow: "0x00000000000000000000000000000000000000ee" }, "signature is invalid"], // another deployment's domain
    ];
    for (const [reply, message] of cases) {
      const { client, requests } = fixture(gateway, { reply });
      await expect(client.prepareQuery(upload)).rejects.toThrow(message);
      expect(requests.some((r) => r.url.endsWith("/v1/query"))).toBe(false);
    }
    const retired = fixture(gateway, { chain: fakeChain({ activeIntakes: [] }) });
    await expect(retired.client.prepareQuery(upload)).rejects.toThrow("not an active INTAKE");
  });

  test("checks paramsHash locally and docCommit against its own salt, also for URL grants", async () => {
    const params = { question: "What is printed?", answer_type: "STRING" };
    const ok = fixture(gateway);
    await ok.client.prepareQuery({ schema: 7, params, document: { url: "https://docs.test/a" }, isPublic: false, sender });
    const fixedParams = fixture(gateway, { reply: { tamper: { paramsHash: `0x${"66".repeat(32)}` } } });
    await expect(fixedParams.client.prepareQuery({ ...upload, schema: 7, params })).rejects.toThrow("params hash");
    // The gateway seals its own request (its URL, params and salt) under the user's binding and returns that grant.
    const own = { substitute: (plain: Record<string, any>) => ({ ...plain, url: "https://docs.test/evil", salt: `0x${"ee".repeat(32)}` }) };
    const swapped = fixture(gateway, { reply: own });
    await expect(swapped.client.prepareQuery({ schema: 7, params, document: { url: "https://docs.test/a" }, isPublic: false, sender })).rejects.toThrow("document commitment mismatch");
    const swappedParams = fixture(gateway, { reply: { substitute: (plain) => ({ ...plain, params: { ...params, question: "Something else?" } }) } });
    await expect(swappedParams.client.prepareQuery({ schema: 7, params, document: { url: "https://docs.test/a" }, isPublic: false, sender })).rejects.toThrow("params hash");
    const swappedDoc = fixture(gateway, { reply: { substitute: (plain) => ({ ...plain, docB64: Buffer.from("other").toString("base64") }) } });
    await expect(swappedDoc.client.prepareQuery(upload)).rejects.toThrow("document commitment mismatch");
    // URL grants need the intake's masked docHash, and must be FETCHED.
    const noHash = fixture(gateway, { reply: { result: { maskedDocHash: undefined } } });
    await expect(noHash.client.prepareQuery({ schema: 3, document: { url: "https://docs.test/a" }, isPublic: false, sender })).rejects.toThrow("no document hash");
    const kind = fixture(gateway, { reply: { tamper: { kind: 0 } } });
    await expect(kind.client.prepareQuery({ schema: 3, document: { url: "https://docs.test/a" }, isPublic: false, sender })).rejects.toThrow("kind");
  });

  describe("waitForVerdict reads the verdict id and query status from the chain", () => {
    const queryId = `0x${"77".repeat(32)}` as Hex;
    const onChainId = `0x${"88".repeat(32)}` as Hex;
    const forgedId = `0x${"66".repeat(32)}` as Hex;
    /** A gateway that reports its own latestVerdictId and a final status for the query. */
    const lyingGateway = (url: string) => {
      if (url.endsWith(`/v1/queries/${queryId}`)) return { query: { status: 3 }, latestVerdictId: forgedId };
      const id = url.split("/v1/verdict/")[1];
      return id ? { verdictId: id } : {};
    };
    function waitFixture(served = new Set<string>([onChainId, forgedId])) {
      const chain = fakeChain({ activeIntakes: [intakeAddress] });
      const f = fixture(lyingGateway, { chain });
      // The gateway serves (200) only the verdicts in `served`, else 404: whether it can serve one is all it is asked.
      const fetcher = (f.client as unknown as { fetcher: typeof fetch }).fetcher;
      (f.client as unknown as { fetcher: typeof fetch }).fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const id = url.split("/v1/verdict/")[1];
        if (id && !served.has(id)) return new Response("{}", { status: 404 });
        return fetcher(input, init);
      }) as typeof fetch;
      return { ...f, chain };
    }

    test("requires the chain", async () => {
      const { client } = fixture(gateway, { chain: null });
      await expect(client.waitForVerdict(queryId, { pollMs: 1, timeoutMs: 20 })).rejects.toBeInstanceOf(ChainConfigError);
    });

    test("ignores the gateway's latestVerdictId and status: nothing on chain means no verdict", async () => {
      const { client, requests } = waitFixture();
      await expect(client.waitForVerdict(queryId, { final: false, pollMs: 1, timeoutMs: 30 })).rejects.toThrow("Timed out");
      expect(requests.some((r) => r.url.includes(`/v1/verdict/${forgedId}`) || r.url.includes("/v1/queries/"))).toBe(false);
    });

    test("returns the on-chain id once the query is final and the gateway serves it; non-final returns the first", async () => {
      const served = new Set<string>([forgedId]);
      const { client, chain } = waitFixture(served);
      chain.latest.set(queryId, onChainId);
      chain.queryStatus.set(queryId, 2);
      // Recorded but not final (SEALED → HUNG within grace): only a non-final wait returns, and only once it is served.
      await expect(client.waitForVerdict(queryId, { final: false, pollMs: 1, timeoutMs: 30 })).rejects.toThrow("Timed out");
      served.add(onChainId);
      expect(await client.waitForVerdict(queryId, { final: false, pollMs: 1, timeoutMs: 100 })).toBe(onChainId);
      chain.queryStatus.set(queryId, 4);
      await expect(client.waitForVerdict(queryId, { pollMs: 1, timeoutMs: 30, hungGraceMs: 10_000 })).rejects.toThrow("Timed out");
      expect(await client.waitForVerdict(queryId, { pollMs: 1, timeoutMs: 200, hungGraceMs: 5 })).toBe(onChainId);
      for (const status of [3, 5]) {
        chain.queryStatus.set(queryId, status);
        expect(await client.waitForVerdict(queryId, { pollMs: 1, timeoutMs: 100 })).toBe(onChainId);
      }
      expect(chain.reads).toContain("latestVerdictOf");
      expect(chain.reads).toContain("getQuery");
    });

    test("chainVerdict reads status, schema, agreement and masks from MochiVerdicts", async () => {
      const { client, chain } = waitFixture();
      chain.verdicts.set(onChainId, { queryId, isPublic: false, answerHash: `0x${"01".repeat(32)}`, payloadHash: `0x${"02".repeat(32)}`, status: 2, round: 1, schemaId: 7, agreementBps: 6_666, dissentMask: 1, timeoutMask: 4 });
      expect(await client.chainVerdict(onChainId)).toMatchObject({ verdictId: onChainId, queryId, status: 2, round: 1, schemaId: 7, agreementBps: 6_666, dissentMask: 1, timeoutMask: 4, isPublic: false });
      await expect(client.chainVerdict(forgedId)).rejects.toThrow("not recorded on chain");
    });
  });

  test("ask sends the locally derived transaction and waits for one confirmation", async () => {
    const hash = `0x${"89".repeat(32)}` as Hex;
    const chain = fakeChain({ activeIntakes: [intakeAddress] });
    (chain.publicClient as unknown as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt = async (args: { confirmations: number }) => { expect(args.confirmations).toBe(1); return { status: "success" }; };
    let honest: ReturnType<typeof honestQuery> | undefined;
    const { client } = fixture(async (_url, init) => (honest = honestQuery(init)), { chain });
    let sent: unknown;
    const wallet = { account: root, chain: null, sendTransaction: async (args: unknown) => { sent = args; return hash; } } as never;
    const result = await client.ask({ schema: 3, document: { url: "https://docs.test/doc" }, isPublic: true, sender }, wallet);
    expect(sent).toMatchObject({ to: TEST_ESCROW.toLowerCase(), data: honest!.data });
    expect(result).toMatchObject({ queryId: honest!.queryId, txHash: hash });
  });

  describe("shielded-pool ask", () => {
    const txHash = `0x${"99".repeat(32)}` as Hex;
    const relayerAddress = "0x0000000000000000000000000000000000000004";
    const privacy = { entrypoint: "0x0000000000000000000000000000000000000002", pool: sender, adapter: "0x0000000000000000000000000000000000000003", scope: "123" } as unknown as Deployment["privacy"];
    const newNote = { nullifier: 9n, secret: 10n, label: 11n, value: 12n };
    const pay = { path: "shielded-pool", note: { nullifier: 1n, secret: 2n }, depositInfo: { deposit: { commitment: 3n, label: 4n, value: 200n }, pool: sender } } as const;
    const opts = { schema: "SPLIT", document: { bytes: new Uint8Array([4]), contentType: "text/plain" }, isPublic: false, sender: root.address as Address, pay } as const;
    function shielded(override: { query?: (init?: RequestInit) => unknown; relay?: (queryId: Hex) => unknown } = {}) {
      const proofs: Array<{ amount: bigint; data: string }> = [];
      let grantQueryId: Hex | undefined;
      const helper = async (args: any) => {
        proofs.push({ amount: args.withdrawnValue, data: args.withdrawal.data });
        expect(args.withdrawal.processooor).toBe(privacy!.adapter);
        return { proof: { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], pubSignals: [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n] }, newNote, seconds: 0.7 };
      };
      const f = fixture(async (url, init) => {
        if (url.endsWith("/v1/relayer")) return { address: relayerAddress };
        if (url.endsWith("/v1/query")) { grantQueryId = honestQueryId(String(init?.body)); return override.query ? override.query(init) : { queryId: grantQueryId, quote: { jurorFees: "1", protocolFee: "0" } }; }
        if (url.endsWith("/v1/relay/open-shielded")) return override.relay ? override.relay(grantQueryId!) : { queryId: grantQueryId, txHash };
        return {};
      }, { chain: fakeChain({ activeIntakes: [intakeAddress], privacy }), extra: { buildShieldedProof: helper } });
      return { ...f, proofs, grantQueryId: () => grantQueryId! };
    }
    const wallet = { account: root, chain: null } as never;

    test("quotes as the relayer, proves the chain price for the grant's queryId, and relays without wallet submission", async () => {
      const s = shielded();
      const result = await s.client.ask(opts, wallet);
      const relay = lastBody(s.requests, "/v1/relay/open-shielded");
      expect(relay.intake.provenance.opener).toBe(relayerAddress);
      // The gateway's quote (1) is ignored: the proof withdraws exactly QueryEscrow.quote(schemaId, 3, tokensK).
      const [jurorFees, protocolFee] = chainQuote(3, relay.intake.provenance.tokensK);
      expect(s.proofs).toHaveLength(1);
      expect(s.proofs[0]!.amount).toBe(jurorFees + protocolFee);
      expect(s.proofs[0]!.data).toContain(s.grantQueryId().slice(2));
      expect(result).toMatchObject({ queryId: s.grantQueryId(), txHash, changeNote: newNote, proofSeconds: 0.7, quote: { jurorFees: jurorFees.toString(), protocolFee: protocolFee.toString() } });
      expect(relay).toMatchObject({ nullifier: `0x${"00".repeat(31)}01` });
      expect(relay.pay).toBeUndefined();
      expect(relay.proof).toMatch(/^0x[0-9a-f]+$/);
    });

    test("never proves a payment for a query the gateway substitutes", async () => {
      const substituted = shielded({ query: () => ({ queryId: `0x${"77".repeat(32)}`, quote: { jurorFees: "100", protocolFee: "20" } }) });
      await expect(substituted.client.ask(opts, wallet)).rejects.toBeInstanceOf(GatewayMismatchError);
      expect(substituted.proofs).toHaveLength(0);
      expect(substituted.requests.some((r) => r.url.endsWith("/v1/relay/open-shielded"))).toBe(false);
      const relayedOther = shielded({ relay: () => ({ queryId: `0x${"77".repeat(32)}`, txHash }) });
      await expect(relayedOther.client.ask(opts, wallet)).rejects.toBeInstanceOf(GatewayMismatchError);
    });
  });

  describe("private results", () => {
    const verdictId = `0x${"aa".repeat(32)}` as Hex;
    const queryId = `0x${"ab".repeat(32)}` as Hex;
    const salt = `0x${"5e".repeat(32)}` as Hex;
    const payload = encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [`0x${"01".repeat(32)}`, 100n, "0x"]);
    const answerJson = canonicalJson({ salt, schemaId: 3, schemaVersion: 1, fields: { x: 1 } });
    const pair = x25519.keygen();
    const sealedResult = (plain: Record<string, unknown>, key: Uint8Array = pair.publicKey) =>
      toHex(new TextEncoder().encode(JSON.stringify(seal(toHex(key), new TextEncoder().encode(canonicalJson(plain)), aad.result(verdictId)))));
    const honestPlain = { v: 1, verdictId, salt, answerJson, payload, fields: [] };
    const record = (plain: { salt: Hex; answerJson: string; payload: Hex } = honestPlain, over: Partial<OnChainVerdictRecord> = {}): OnChainVerdictRecord =>
      ({ queryId, isPublic: false, answerHash: keccak256(toHex(plain.answerJson)), payloadHash: privatePayloadHash(plain.salt, plain.payload), ...over });
    const keys = { queryId, salt, resultPrivateKey: toHex(pair.secretKey) };
    /** The gateway serves `ciphertext` and claims `gatewayChain` as the chain record; the chain holds `onChain`. */
    function privateFixture(ciphertext: Hex, onChain?: OnChainVerdictRecord, gatewayChain?: Record<string, unknown>) {
      const f = fixture(async (url) => url.endsWith(`/v1/verdict/${verdictId}`) ? { status: "VERDICT", ciphertext, ...(gatewayChain ? { chain: gatewayChain } : {}) } : {});
      if (onChain) f.chain.verdicts.set(verdictId, onChain);
      return f;
    }

    test("decrypts a private result only when it matches the on-chain verdict of this query and its salt", async () => {
      const ok = privateFixture(sealedResult(honestPlain), record());
      expect((await ok.client.decryptPrivateResult(verdictId, keys)).answerJson).toBe(answerJson);
      expect(ok.chain.reads).toContain("getVerdict");
      // An unsalted keccak256(payload) is not what a private verdict commits to.
      const unsalted = privateFixture(sealedResult(honestPlain), record(honestPlain, { payloadHash: keccak256(payload) }));
      await expect(unsalted.client.decryptPrivateResult(verdictId, keys)).rejects.toThrow("payloadHash mismatch");
      const otherQuery = privateFixture(sealedResult(honestPlain), record(honestPlain, { queryId: `0x${"ac".repeat(32)}` }));
      await expect(otherQuery.client.decryptPrivateResult(verdictId, keys)).rejects.toThrow("another query");
      const notOnChain = privateFixture(sealedResult(honestPlain));
      await expect(notOnChain.client.decryptPrivateResult(verdictId, keys)).rejects.toThrow("not recorded on chain");
      const publicVerdict = privateFixture(sealedResult(honestPlain), record(honestPlain, { isPublic: true }));
      await expect(publicVerdict.client.decryptPrivateResult(verdictId, keys)).rejects.toThrow("public");
    });

    test("rejects a result forged by the gateway even when it supplies matching chain hashes", async () => {
      // x25519 sealing is unauthenticated: the gateway seals its own answer to the payer's public key and reports
      // chain hashes that match it. Only the real on-chain record counts.
      const forged = { ...honestPlain, answerJson: canonicalJson({ salt, schemaId: 3, schemaVersion: 1, fields: { x: 99 } }) };
      const f = privateFixture(sealedResult(forged), record(), { answerHash: keccak256(toHex(forged.answerJson)), payloadHash: privatePayloadHash(salt, payload) });
      await expect(f.client.decryptPrivateResult(verdictId, keys)).rejects.toThrow("answerHash mismatch");
      // A result carrying another salt is refused even if the chain record were built from it.
      const otherSalt = { ...honestPlain, salt: `0x${"5f".repeat(32)}` as Hex };
      const g = privateFixture(sealedResult(otherSalt), record(otherSalt));
      await expect(g.client.decryptPrivateResult(verdictId, keys)).rejects.toThrow("salt mismatch");
    });

    test("needs a chain and the query's keys, not just the result key", async () => {
      const noChain = fixture(async () => ({ ciphertext: sealedResult(honestPlain) }), { chain: null });
      await expect(noChain.client.decryptPrivateResult(verdictId, keys)).rejects.toBeInstanceOf(ChainConfigError);
      const f = privateFixture(sealedResult(honestPlain), record());
      await expect(f.client.decryptPrivateResult(verdictId, toHex(pair.secretKey) as never)).rejects.toThrow("queryId");
      await expect(f.client.decryptPrivateResult(verdictId, { queryId, salt: ZERO32, resultPrivateKey: keys.resultPrivateKey })).rejects.toThrow("salt");
    });
  });

  test("verifies receipt signature and anchor and reports unknown keys", async () => {
    const signer = createReceiptSigner();
    const receipt: VerdictReceiptInput = {
      verdictId: `0x${"01".repeat(32)}`, chainId: 31337, contract: sender, txHash: `0x${"02".repeat(32)}`, queryId: `0x${"03".repeat(32)}`,
      round: 0, status: "VERDICT", agreementBps: 10000, dissentMask: 0, timeoutMask: 0, schemaId: 3, schemaVersion: 1,
      docCommit: `0x${"04".repeat(32)}`, answerHash: `0x${"05".repeat(32)}`, payloadHash: `0x${"06".repeat(32)}`, evidenceRoot: `0x${"07".repeat(32)}`,
      attestationRoot: `0x${"08".repeat(32)}`, modelSetHash: `0x${"09".repeat(32)}`, provenanceKind: "SUBMITTED", originId: `0x${"00".repeat(32)}`,
      isPublic: true, escalated: false, jurors: [], answer_json: "{}", payload: "0x",
    };
    const { buildVerdictReceipt } = await import("@mochi/receipts");
    const item = buildVerdictReceipt(receipt, { keyId: signer.keyId });
    const signature = signer.sign(item);
    const batch = buildAnchorBatch([item]);
    const { client } = fixture(async (url) => url.includes("/.well-known/") ? { key_id: signer.keyId, public_key_pem: signer.publicKeyPem } : { receipt: item, signature, anchor: { root: batch.root, proof: batch.proofs.get(batch.leaves[0]!) } });
    expect(await client.verifyReceipt(receipt.verdictId as Hex)).toMatchObject({ valid: true, anchored: true });
    const invalid = fixture(async (url) => url.includes("/.well-known/") ? { key_id: signer.keyId, public_key_pem: signer.publicKeyPem } : { receipt: item, signature: "AAAA" }).client;
    expect(await invalid.verifyReceipt(receipt.verdictId as Hex)).toMatchObject({ valid: false, reason: "invalid_signature" });
    const unknown = fixture(async (url) => url.includes("/.well-known/") ? { key_id: "unknown", public_key_pem: signer.publicKeyPem } : { receipt: item, signature }).client;
    expect(await unknown.verifyReceipt(receipt.verdictId as Hex)).toMatchObject({ valid: false, reason: "unknown_key" });
  });

  test("decodes feed payloads, seals disclosures only for the auditor, and checks them against the chain", async () => {
    const verdictId = `0x${"ab".repeat(32)}` as Hex;
    const salt = `0x${"5e".repeat(32)}` as Hex;
    const result = { v: 1 as const, verdictId, salt, answerJson: canonicalJson({ salt, answer: 42 }), payload: "0x" as Hex, fields: [] };
    const auditor = x25519.keygen();
    const payer = x25519.keygen();
    const feedBody = encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [
      `0x${"01".repeat(32)}`, 100n,
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" }], [`0x${"02".repeat(32)}`, 200n, 3, 2]),
    ]);
    let disclosureEnvelope: unknown;
    const { client, chain } = fixture(async (url, init) => {
      if (url.includes("/v1/feeds/")) return { verdictId, asOf: "200", updatedAt: "201", schemaId: 2, payload: feedBody };
      if (url.endsWith("/v1/disclosures")) {
        const req = JSON.parse(String(init?.body));
        disclosureEnvelope = req.envelope;
        return { recipientKeyHash: req.recipientPubKey };
      }
      if (url.includes("/v1/disclosures/")) return { envelope: disclosureEnvelope };
      // The gateway's copy of the chain record is never consulted.
      if (url.endsWith(`/v1/verdict/${verdictId}`)) return { chain: { answerHash: `0x${"01".repeat(32)}`, payloadHash: ZERO32 } };
      return {};
    });
    chain.verdicts.set(verdictId, { queryId: `0x${"cd".repeat(32)}`, isPublic: false, answerHash: keccak256(toHex(result.answerJson)), payloadHash: ZERO32 });
    expect((await client.feed("split-feed", `0x${"03".repeat(32)}`)).body).toHaveProperty("body.ratioNum", 3);
    await client.disclose({ verdictId, result, auditorPublicKey: toHex(auditor.publicKey) });
    expect((await client.readDisclosure(verdictId, toHex(auditor.secretKey))).answerJson).toBe(result.answerJson);
    const parsedEnvelope = disclosureEnvelope as Parameters<typeof import("@mochi/tee").open>[1];
    await expect(Promise.resolve().then(() => import("@mochi/tee").then(({ open }) => open(payer.secretKey, parsedEnvelope, aad.disclosure(verdictId, toHex(auditor.publicKey)))))).rejects.toThrow();
    // A disclosure sealed to the auditor by anyone else, with another answer, does not match the chain.
    await client.disclose({ verdictId, result: { ...result, answerJson: canonicalJson({ salt, answer: 41 }) }, auditorPublicKey: toHex(auditor.publicKey) });
    await expect(client.readDisclosure(verdictId, toHex(auditor.secretKey))).rejects.toThrow("Disclosure answerHash mismatch");
    const noChain = fixture(async () => ({ envelope: disclosureEnvelope }), { chain: null });
    await expect(noChain.client.readDisclosure(verdictId, toHex(auditor.secretKey))).rejects.toBeInstanceOf(ChainConfigError);
  });
});

describe("MochiClient.readDisclosure", () => {
  const verdictId = `0x${"ab".repeat(32)}` as Hex;
  const queryId = `0x${"cd".repeat(32)}` as Hex;
  const salt = `0x${"5e".repeat(32)}` as Hex;
  const payer = "0x00000000000000000000000000000000000000a1" as Address;
  const squatter = "0x00000000000000000000000000000000000000b2" as Address;
  const auditor = x25519.keygen();
  const auditorPub = toHex(auditor.publicKey);
  const auditorKey = toHex(auditor.secretKey);
  const keyHash = recipientKeyHash(auditorPub);
  const field = (agreeBps: number) => ({ field: "answer", required: true, agreeBps, hung: false, value: 42, dissent: {} });
  const result: PrivateResultPlain = { v: 1, verdictId, salt, answerJson: canonicalJson({ salt, answer: 42 }), payload: "0x", fields: [field(10_000)] };
  const sealFor = (plain: unknown) => seal(auditorPub, new TextEncoder().encode(canonicalJson(plain)), aad.disclosure(verdictId, auditorPub));
  const hashOf = (envelope: unknown) => keccak256(toHex(canonicalJson(envelope)));
  // What a squatter can post for the auditor's key: junk that does not open, a sealed result with another answer, and
  // (if it knows the result) the right answer with forged details, which the chain's answerHash cannot tell apart.
  const junk = { v: 1, epk: toHex(x25519.keygen().publicKey), nonce: `0x${"00".repeat(12)}`, ct: `0x${"ab".repeat(40)}` };
  const wrongAnswer = sealFor({ ...result, answerJson: canonicalJson({ salt, answer: 41 }) });
  const forgedFields = sealFor({ ...result, fields: [field(1)] });

  /**
   * A private verdict on the fake chain with `payer` as its query's payer, behind a gateway disclosure store like
   * services/gateway's: every distinct envelope under keccak256(canonical JSON), oldest first. Its plain GET always
   * serves the oldest inline (as with no anchor, or a gateway that ignores one); `serve` can swap what a hash returns.
   */
  function disclosureFixture(options: { chain?: ReturnType<typeof fakeChain>; serve?: (hash: Hex, stored: unknown) => unknown } = {}) {
    const stored: Array<{ hash: Hex; envelope: unknown }> = [];
    const post = (envelope: unknown) => {
      const hash = hashOf(envelope);
      if (!stored.some((s) => s.hash === hash)) stored.push({ hash, envelope });
      return hash;
    };
    const notFound = () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Disclosure not found" } }), { status: 404 });
    const f = fixture((url, init) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === "/v1/disclosures") {
        const body = JSON.parse(String(init?.body));
        return { recipientKeyHash: recipientKeyHash(body.recipientPubKey), envelopeHash: post(body.envelope) };
      }
      if (pathname !== `/v1/disclosures/${verdictId}/${keyHash}`) return notFound();
      const wanted = searchParams.get("envelopeHash");
      if (wanted !== null) {
        const hit = stored.find((s) => s.hash === wanted);
        return hit ? { envelope: options.serve ? options.serve(hit.hash, hit.envelope) : hit.envelope, envelopeHash: hit.hash } : notFound();
      }
      const oldest = stored[0];
      if (!oldest) return notFound();
      return {
        envelope: oldest.envelope, envelopeHash: oldest.hash, anchoredBy: null, total: stored.length,
        envelopes: stored.map((s) => ({ envelopeHash: s.hash, createdAt: "2026-01-01T00:00:00.000Z" })),
      };
    }, { chain: options.chain ?? fakeChain({ activeIntakes: [intakeAddress] }) });
    f.chain.verdicts.set(verdictId, { queryId, isPublic: false, answerHash: keccak256(toHex(result.answerJson)), payloadHash: ZERO32 });
    f.chain.queryPayer.set(queryId, payer);
    /** The query strings of the disclosure reads readDisclosure made. */
    const reads = () => f.requests.filter((r) => new URL(r.url).pathname.startsWith("/v1/disclosures/")).map((r) => new URL(r.url).search);
    return { ...f, post, stored, reads };
  }
  /** A wallet whose DisclosureRegistry.disclose lands in the fake chain under `address`. */
  const walletOf = (chain: ReturnType<typeof fakeChain>, address: Address) => ({
    account: { address, type: "json-rpc" }, chain: undefined,
    writeContract: async ({ address: registry, functionName, args }: { address: Address; functionName: string; args: [Hex, Hex, Hex] }) => {
      if (registry !== TEST_DISCLOSURES || functionName !== "disclose") throw new Error("unexpected write");
      chain.anchor(args[0], args[1], address, args[2]);
      return `0x${"77".repeat(32)}`;
    },
  }) as unknown as WalletClient;

  test("a squatter's envelopes served first are rejected: the payer's anchored envelope is chosen", async () => {
    const f = disclosureFixture();
    for (const envelope of [junk, wrongAnswer, forgedFields]) f.post(envelope);
    // The squatter anchoring its own envelope under its own address changes nothing: only the payer's slot is read.
    f.chain.anchor(verdictId, keyHash, squatter, hashOf(forgedFields));
    const disclosed = await f.client.disclose({ verdictId, result, auditorPublicKey: auditorPub, wallet: walletOf(f.chain, payer), disclosureRegistry: TEST_DISCLOSURES });
    expect(disclosed.envelopeHash).toBe(f.stored.at(-1)!.hash);
    const read = await f.client.readDisclosure(verdictId, auditorKey);
    expect(read.fields).toEqual(result.fields);
    expect(read.disclosure).toEqual({ anchored: true, envelopeHash: disclosed.envelopeHash, discloser: payer, disclosedAt: 1_700_000_001 });
    // Fetched by the anchored hash alone; the gateway's default pick (the squatter's oldest) is never opened.
    expect(f.reads()).toEqual([`?envelopeHash=${disclosed.envelopeHash}`]);
    expect(f.chain.reads).toEqual(expect.arrayContaining(["getVerdict", "getQuery", "disclosureOf"]));
  });

  test("an explicitly named discloser's anchor is used instead of the payer's slot", async () => {
    // A relayed (shielded) query: the on-chain payer is the relayer, and the user discloses from its own wallet.
    const user = "0x00000000000000000000000000000000000000c3" as Address;
    const f = disclosureFixture();
    f.post(forgedFields);
    const { envelopeHash } = await f.client.disclose({ verdictId, result, auditorPublicKey: auditorPub, wallet: walletOf(f.chain, user), disclosureRegistry: TEST_DISCLOSURES });
    // Without `discloser` the payer has no anchor, so the oldest envelope matching the chain wins: the forged details.
    const fallback = await f.client.readDisclosure(verdictId, auditorKey);
    expect(fallback.disclosure).toEqual({ anchored: false, envelopeHash: hashOf(forgedFields), discloser: payer, tried: 1 });
    expect(fallback.fields).toEqual([field(1)]);
    const named = await f.client.readDisclosure(verdictId, auditorKey, { discloser: user });
    expect(named.disclosure).toMatchObject({ anchored: true, envelopeHash, discloser: user });
    expect(named.fields).toEqual(result.fields);
    // A read result can be disclosed onward as is: only the PrivateResultPlain is sealed.
    const onward = await f.client.disclose({ verdictId, result: named, auditorPublicKey: auditorPub });
    const sealed = f.stored.find((s) => s.hash === onward.envelopeHash)!.envelope;
    const { open } = await import("@mochi/tee");
    expect(JSON.parse(new TextDecoder().decode(open(auditor.secretKey, sealed as never, aad.disclosure(verdictId, auditorPub))))).toEqual(result);
  });

  test("with no anchor, every stored envelope is tried and only one that opens and matches the chain is accepted", async () => {
    const f = disclosureFixture();
    f.post(junk);
    f.post(wrongAnswer);
    const { envelopeHash } = await f.client.disclose({ verdictId, result, auditorPublicKey: auditorPub }); // posted, not anchored
    const read = await f.client.readDisclosure(verdictId, auditorKey);
    expect(read.answerJson).toBe(result.answerJson);
    expect(read.disclosure).toEqual({ anchored: false, envelopeHash, discloser: payer, tried: 3 });
    // The oldest came inline; the rest were fetched by hash, each checked against it.
    expect(f.reads()).toEqual(["", `?envelopeHash=${hashOf(wrongAnswer)}`, `?envelopeHash=${envelopeHash}`]);

    // A deployment without a DisclosureRegistry reads no anchor at all, and cannot honour a named discloser.
    const bare = disclosureFixture({ chain: fakeChain({ activeIntakes: [intakeAddress], disclosureRegistry: false }) });
    for (const envelope of [junk, sealFor(result)]) bare.post(envelope);
    expect((await bare.client.readDisclosure(verdictId, auditorKey)).disclosure).toMatchObject({ anchored: false, discloser: null, tried: 2 });
    expect(bare.chain.reads).not.toContain("disclosureOf");
    await expect(bare.client.readDisclosure(verdictId, auditorKey, { discloser: payer })).rejects.toBeInstanceOf(ChainConfigError);

    // Nothing that matches the chain: refused, naming why.
    const none = disclosureFixture();
    for (const envelope of [junk, wrongAnswer]) none.post(envelope);
    await expect(none.client.readDisclosure(verdictId, auditorKey)).rejects.toThrow(/tried 2 of 2.*answerHash mismatch/);
  });

  test("a hash mismatch is rejected, and an anchored envelope is never replaced by another one", async () => {
    // The gateway answers the payer's anchored hash with another envelope, one that even opens and matches the chain.
    let anchoredHash: Hex | undefined;
    const swapped = disclosureFixture({ serve: (hash, stored) => hash === anchoredHash ? forgedFields : stored });
    swapped.post(forgedFields);
    anchoredHash = (await swapped.client.disclose({ verdictId, result, auditorPublicKey: auditorPub, wallet: walletOf(swapped.chain, payer), disclosureRegistry: TEST_DISCLOSURES })).envelopeHash;
    const mismatch = swapped.client.readDisclosure(verdictId, auditorKey);
    await expect(mismatch).rejects.toBeInstanceOf(GatewayMismatchError);
    await expect(swapped.client.readDisclosure(verdictId, auditorKey)).rejects.toThrow("Disclosure envelope hash mismatch");

    // The anchored envelope is withheld (never posted here): no fallback to the other, valid-looking envelopes.
    const withheld = disclosureFixture();
    withheld.post(sealFor(result));
    withheld.chain.anchor(verdictId, keyHash, payer, hashOf(sealFor(result)));
    await expect(withheld.client.readDisclosure(verdictId, auditorKey)).rejects.toThrow("anchored on chain");

    // The payer anchored an envelope that does not match the chain: refused, though a matching one is stored too.
    const bad = disclosureFixture();
    bad.post(sealFor(result));
    bad.chain.anchor(verdictId, keyHash, payer, bad.post(wrongAnswer));
    await expect(bad.client.readDisclosure(verdictId, auditorKey)).rejects.toThrow("Disclosure answerHash mismatch");

    // Without an anchor, an envelope served under another hash is skipped like any other bad candidate.
    const genuine = sealFor(result);
    const unanchored = disclosureFixture({ serve: (hash, stored) => hash === hashOf(genuine) ? forgedFields : stored });
    unanchored.post(junk);
    unanchored.post(genuine);
    await expect(unanchored.client.readDisclosure(verdictId, auditorKey)).rejects.toThrow(/tried 2 of 2.*Disclosure envelope hash mismatch/);

    // disclose refuses to anchor when the gateway stored the envelope under another hash.
    let wrote = false;
    const lying = fixture((url) => url.endsWith("/v1/disclosures") ? { recipientKeyHash: keyHash, envelopeHash: `0x${"99".repeat(32)}` } : {});
    const wallet = { account: { address: payer }, writeContract: async () => { wrote = true; return ZERO32; } } as unknown as WalletClient;
    await expect(lying.client.disclose({ verdictId, result, auditorPublicKey: auditorPub, wallet, disclosureRegistry: TEST_DISCLOSURES })).rejects.toBeInstanceOf(GatewayMismatchError);
    expect(wrote).toBe(false);
  });
});
