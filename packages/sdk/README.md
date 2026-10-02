# @mochi/sdk

```ts
import { MochiClient, askClaimReview, prepareClaimReview, waitForClaimReview } from "@mochi/sdk";
import { loadDeployment } from "@mochi/chain";
import { MockQuoteVerifier } from "@mochi/tee";

const client = new MochiClient({
  gatewayUrl: "https://gateway.example",
  indexerUrl: "https://indexer.example",
  quoteVerifier: new MockQuoteVerifier({ mockRootAddress: "0x0000000000000000000000000000000000000000" }),
  intakeMeasurement: "0x0000000000000000000000000000000000000000000000000000000000000000",
  // Required to prepare, ask, wait for verdicts, decrypt or read disclosures: grants, prices, verdict ids and results
  // are checked against (or read from) the chain.
  chain: { deployment: loadDeployment("deployments/local.json") /*, publicClient */ },
});
const wallet = /* configured viem WalletClient */ null as never;

// A claim review can be prepared privately for inspection without sending a transaction.
// Claim and evidence excerpts are uploaded as SUBMITTED user content; the adapter does not
// fetch source URLs or imply that they were independently verified.
const claimInput = {
  claim: "The board approved the transaction.",
  evidence: [{
    id: "minutes-1", title: "Meeting minutes", url: "https://issuer.example/minutes",
    excerpt: "The board approved the transaction at its meeting.",
  }],
  sender: "0x0000000000000000000000000000000000000001",
};
const preparedClaim = await prepareClaimReview(client, claimInput);
// Inspect preparedClaim.prepared.quote and .tx before explicitly submitting.
// const submittedClaim = await askClaimReview(client, claimInput, wallet);

// Public ask: document bytes are sealed to the attested intake key.
const publicAsk = await client.ask({
  schema: "EARNINGS", document: { bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" },
  isPublic: true, sender: "0x0000000000000000000000000000000000000001",
}, wallet);
const verdictId = await client.waitForVerdict(publicAsk.queryId); // MochiVerdicts.latestVerdictOf, from the chain
console.log(await client.chainVerdict(verdictId)); // the on-chain record: status, agreement, answerHash, payloadHash
console.log(await client.getVerdict(verdictId)); // the gateway's copy (decoded payload), not checked against the chain

// Private ask: retain the result private key locally and decrypt after the verdict arrives.
const privateAsk = await client.ask({
  schema: "INVOICE", document: { url: "https://example.com/invoice.pdf" },
  isPublic: false, sender: "0x0000000000000000000000000000000000000001",
}, wallet);
const privateVerdictId = await client.waitForVerdict(privateAsk.queryId);
// The verdict must be on chain for this query, and the result must carry this query's salt.
const result = await client.decryptPrivateResult(privateVerdictId, { queryId: privateAsk.queryId, ...privateAsk.secrets });

// Verify a signed receipt and read a decoded feed value.
const receipt = await client.verifyReceipt(verdictId, { checkAnchorOnChain: true });
const latest = await client.feed("earnings@RHC", "0x" + "00".repeat(32));
console.log({ receipt, result, latest });
```

`prepareClaimReview(client, input)` creates an inspectable private `FREEFORM_FACT` query using the four-answer enum
`supported | contradicted | missing_context | insufficient_evidence`. It packages the exact claim and bounded user-supplied
evidence excerpts into deterministic text bytes. Source URLs are metadata only: the adapter never fetches them and marks
their provenance `SUBMITTED`. It defaults to private results and panel disclosure off. Preparation performs attested
intake and requests a quote, but sends no wallet transaction and collects no payment. Call
`askClaimReview(client, input, wallet)` explicitly to submit through the existing `MochiClient.ask` payment and escrow
path. `waitForClaimReview(client, queryId, secrets)` (the `secrets` from prepare/ask: `{ salt, resultPrivateKey }`) waits
for the query's verdict on chain; a `HUNG` outcome remains `HUNG`, and a prepared/local preview is never interpreted as a
verdict. The verdict id, status, schema, `agreementBps`, `dissentMask` and `timeoutMask` are read from `MochiVerdicts`
and the outcome is labeled `execution: "chain_derived"`; a `VERDICT` answer is decrypted with
`MochiClient.decryptPrivateResult`, which accepts it only against the on-chain `answerHash` and salted `payloadHash`.
`interpretClaimReviewVerdict(record)` reads a gateway record instead and labels its outcome `gateway_reported`. Keep the
secrets local if you need to inspect the full private result and source spans.

Opening is bound to the request. `sender` is the wallet that will send the open transaction (for `shielded-pool` payments,
the gateway relayer). The SDK seals `{ opener, payerCommit, isPublic, allowPanelDisclosure, nonce }` to the intake together
with the document, and the intake signs it into the EIP-712 provenance with the schema version, params hash and a
15-minute expiry. QueryEscrow accepts that grant only from `opener`, only before expiry, and only once. The intake issues
at most one grant per binding (per `(opener, nonce)`, and per `payerCommit` for a private query): an identical retry gets
the same grant back, and any other request naming the binding is refused (HTTP 409 `GRANT_EXISTS`). The SDK uses a fresh
random nonce and result key for every `prepareQuery`/`ask`, so a refused or expired grant just means asking again.

The gateway is an untrusted relay, so the SDK takes nothing that decides what is paid for, or what a result says, from it.
`chain: { deployment, publicClient? }` is required for `prepareQuery`, `ask`, `waitForVerdict`, `chainVerdict`,
`decryptPrivateResult` and `readDisclosure` (they throw `ChainConfigError` without it, and refuse an RPC on another chain
id). Before a grant is used to open:

- it must name exactly the sealed binding and schema, with the `paramsHash` the SDK computes from its own params;
- its `docCommit` must commit to this request's salt: from the bytes for an upload, or in URL mode from the intake's
  `maskedDocHash` (docHash masked with the salt), so a grant the relay obtained for its own URL, params or salt is refused;
- its kind must match the request (SUBMITTED upload, FETCHED URL);
- its EIP-712 signature (this deployment's QueryEscrow domain) must recover to the attested intake, and that key must be an
  active INTAKE in the JurorRegistry.

The `queryId` is computed locally (`computeQueryId` in `@mochi/core`, as `QueryEscrow.computeQueryId`), the price is read
from `QueryEscrow.quote`, and the gateway's `/v1/query` reply must agree on the `queryId` and calldata (`GatewayMismatchError`
or `TypeError` otherwise). For `shielded-pool` payments the withdrawal proof is built for that local `queryId` and the
chain price, so a relay cannot redirect a proof to another query.

`waitForVerdict(queryId)` reads the verdict id from `MochiVerdicts.latestVerdictOf(queryId)` and the query status from
`QueryEscrow.getQuery`; the gateway is only asked whether it can serve that verdict yet, so it cannot substitute another
verdict or finish a query early. `chainVerdict(verdictId)` returns the on-chain record (status, schema, agreement, masks,
`answerHash`, `payloadHash`); `getVerdict` returns the gateway's copy, which is unchecked.

`decryptPrivateResult(verdictId, { queryId, salt, resultPrivateKey })` reads the verdict from `MochiVerdicts.getVerdict`
(never the gateway's copy): it must belong to `queryId` and be private, the decrypted result must name the verdict and carry
the query's `salt`, and `keccak256(answerJson)` and the salted private `payloadHash` must match the chain. x25519 sealing is
unauthenticated, so this is what stops a relay from sealing its own result to your key. `readDisclosure` checks a disclosed
result against the same on-chain record.

Disclosures:

```ts
// Payer: seal the result to the auditor's x25519 key, post it, and anchor its hash from the paying wallet.
const { envelopeHash } = await client.disclose({
  verdictId: privateVerdictId, result, auditorPublicKey, wallet, disclosureRegistry: deployment.contracts.disclosureRegistry,
});
// Auditor: open the envelope the payer (or `discloser`) anchored on chain, checked against the on-chain verdict.
const disclosed = await client.readDisclosure(privateVerdictId, auditorPrivateKey /*, { discloser, disclosureRegistry } */);
disclosed.answerJson; // the PrivateResultPlain members
disclosed.disclosure; // { anchored: true, envelopeHash, discloser, disclosedAt } or { anchored: false, envelopeHash, discloser, tried }
```

`disclose` returns `envelopeHash` = keccak256 of the envelope's canonical JSON, the key the gateway stores it under and,
with `wallet` and `disclosureRegistry`, the hash it records in `DisclosureRegistry` under the wallet's address (it refuses
to anchor if the gateway reports another hash). `result` is sealed as a `PrivateResultPlain`, so a `readDisclosure` result
can be disclosed onward as is.

The gateway keeps every envelope anyone posts for a recipient key, and anyone can post one, so `readDisclosure` lets the
chain decide which to open. The trusted discloser is `opts.discloser`, else the query's payer
(`QueryEscrow.getQuery(verdict.queryId).payer`, read on chain); for a relayed shielded query the payer is the relayer, so
name the wallet that disclosed. If `DisclosureRegistry.disclosureOf(verdictId, recipientKeyHash, discloser)` holds a hash,
only that envelope is accepted: it is fetched with `?envelopeHash=`, its keccak256(canonical JSON) must equal the record
(`GatewayMismatchError` otherwise), and it must open and match the on-chain `answerHash` and `payloadHash`. Any failure
throws; it never falls back to another envelope. With no such record, each stored envelope (the gateway's inline pick,
then every listed hash, oldest first, at most 256) is opened and checked, and the first that matches is returned with
`disclosure.anchored: false` and the number `tried`. The chain commits only to `answerJson` and the payload, so such a
result's other members (`fields`) are as whoever posted it sealed them: require `disclosure.anchored` when they matter.
The registry is `opts.disclosureRegistry`, else `deployment.contracts.disclosureRegistry`; without either, no anchor is
read (`discloser: null`), and naming a `discloser` throws `ChainConfigError`.

API changes: `readDisclosure` takes an optional third argument `{ discloser?, disclosureRegistry? }` and returns a
`DisclosedResult` (the `PrivateResultPlain` plus `disclosure`), so existing callers keep working. It now also reads
`QueryEscrow.getQuery` and `DisclosureRegistry.disclosureOf` when a registry is configured, and refuses a public verdict
before fetching anything. `disclose` also returns `envelopeHash` and validates `result` against `PrivateResultPlainSchema`.

Public URL-mode queries (salt 0) are covered too, though the docCommit check alone cannot tell the requested URL from
another allow-listed document: the relay learns the binding only from the grant for the SDK's own sealed request, and the
intake then refuses to sign anything else under it, so a grant that names the SDK's binding is the one for its request. A
private URL grant also carries only a salted `transcriptHash`, so the chain does not let anyone confirm a guessed URL and
document.

Limits: claim 4,000 UTF-8 bytes; 1–5 evidence items; 18,000 bytes per excerpt; 64,000 aggregate excerpt bytes; 80,000 bytes
for the complete uploaded package; title and URL metadata at most 2,048 bytes each. URLs must be public HTTPS metadata,
but no request is made to them. This produces a structured protocol verdict over user-submitted evidence, not independent
source verification.
