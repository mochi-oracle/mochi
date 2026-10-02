import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Redactor, TxRefused, assertYesAllowed, checkServiceUrl, describeHead, describeTx, headAgeSec, fetchJsonBounded, fetchLogsChunked, guardTransaction, intakeAddressFrom, loadKeyFile,
  operatorFrom, parseCli, redactRpc, resolveRpc, scrubText, sendDecision, sendGuardedTx, serviceSignersFrom, writePrivateJson, type ConfirmIO, type TxIntent,
} from "./common.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex; // anvil dev key #1, public
const ACCOUNT = privateKeyToAccount(KEY);
const DRPC_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

test("redactRpc keeps deploy-local.ts behaviour (same expressions, same results)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "deploy-local.ts"), "utf8");
  const ours = readFileSync(join(import.meta.dir, "common.ts"), "utf8");
  for (const pattern of [String.raw`.replace(/([?&](?:dkey|key|apikey|api_key|token)=)[^&#]+/gi, "$1<redacted>")`, String.raw`.replace(/(\/)[A-Za-z0-9_-]{20,}(?=\/?$|[?#])/, "$1<redacted>")`]) {
    expect(source).toContain(pattern);
    expect(ours).toContain(pattern);
  }
  expect(redactRpc(`https://lb.drpc.org/ogrpc?network=robinhood&dkey=${DRPC_KEY}`)).toBe("https://lb.drpc.org/ogrpc?network=robinhood&dkey=<redacted>");
  expect(redactRpc(`https://robinhood.drpc.org/${DRPC_KEY}`)).toBe("https://robinhood.drpc.org/<redacted>");
  expect(redactRpc("https://rpc.testnet.chain.robinhood.com/rpc")).toBe("https://rpc.testnet.chain.robinhood.com/rpc");
});

test("scrubText removes exact secrets, keyed URLs inside free text and raw private keys", () => {
  const url = `https://lb.drpc.org/ogrpc?network=robinhood&dkey=${DRPC_KEY}`;
  const viemStyle = `HTTP request failed.\n\nURL: ${url}\nRequest body: {"method":"eth_chainId"}\nDetails: fetch failed`;
  const scrubbed = scrubText(viemStyle, []);
  expect(scrubbed).not.toContain(DRPC_KEY);
  expect(scrubbed).toContain("dkey=<redacted>");
  expect(scrubText(`key file said ${DRPC_KEY}`, [DRPC_KEY])).toBe("key file said <redacted>");
  expect(scrubText(`{"privateKey":"${KEY}"}`)).not.toContain(KEY.slice(2));
  const redactor = new Redactor([url, DRPC_KEY]);
  expect(redactor.error(new Error(`boom at ${url}\nline2\nline3\nline4\nline5\nline6\nline7 ${DRPC_KEY}`))).not.toContain(DRPC_KEY);
  expect(redactor.error(new Error("a\nb\nc\nd\ne\nf\ng")).split("\n")).toHaveLength(6);
});

test("parseCli is strict", () => {
  const spec = { flags: ["--yes"], options: ["--out"], positionals: 0 };
  expect(parseCli(["--yes", "--out", "x"], spec).options.get("--out")).toBe("x");
  expect(() => parseCli(["--nope"], spec)).toThrow("unknown option --nope");
  expect(() => parseCli(["--out"], spec)).toThrow("missing value for --out");
  expect(() => parseCli(["--out", "--yes"], spec)).toThrow("missing value for --out");
  expect(() => parseCli(["--out", "a", "--out", "b"], spec)).toThrow("given twice");
  expect(() => parseCli(["stray"], spec)).toThrow("unexpected argument stray");
});

test("resolveRpc: key file (mode 600, key only) builds a redacted dRPC URL; keys never come from argv", () => {
  const readFile = () => `${DRPC_KEY}\n`;
  const rpc = resolveRpc({ rpcKeyFile: "/k", readFile, statMode: () => 0o100600, env: {} });
  expect(rpc.url).toBe(`https://lb.drpc.org/ogrpc?network=robinhood&dkey=${DRPC_KEY}`);
  expect(rpc.display).not.toContain(DRPC_KEY);
  expect(rpc.secrets).toContain(DRPC_KEY);
  expect(() => resolveRpc({ rpcKeyFile: "/k", readFile, statMode: () => 0o100644, env: {} })).toThrow("chmod 600");
  expect(() => resolveRpc({ rpcKeyFile: "/k", readFile: () => "not a key!", statMode: () => 0o100600 })).toThrow("only the dRPC key");
  expect(() => resolveRpc({ rpcFlag: `https://x/?dkey=${DRPC_KEY}` })).toThrow("--rpc must not contain an API key");
  const fromEnv = resolveRpc({ env: { RPC_URL: `https://x/?dkey=${DRPC_KEY}` } });
  expect(fromEnv.display).toBe("https://x/?dkey=<redacted>");
  expect(fromEnv.secrets).toEqual([`https://x/?dkey=${DRPC_KEY}`]);
  expect(() => resolveRpc({ deploymentRpc: `https://x/?key=${DRPC_KEY}` })).toThrow("carries a key");
  expect(resolveRpc({ chainId: 46630 }).url).toBe("https://rpc.testnet.chain.robinhood.com/rpc");
  expect(() => resolveRpc({ chainId: 1 })).toThrow("no RPC");
});

test("loadKeyFile: mode 600 only, address must match, contents never echoed", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-ops-key-"));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ address: ACCOUNT.address, privateKey: KEY }), { mode: 0o600 });
  expect(loadKeyFile(good, "payer").address).toBe(ACCOUNT.address);
  const open = join(dir, "open.json");
  writeFileSync(open, JSON.stringify({ privateKey: KEY }), { mode: 0o644 });
  expect(() => loadKeyFile(open, "payer")).toThrow("chmod 600");
  const wrong = join(dir, "wrong.json");
  writeFileSync(wrong, JSON.stringify({ address: a(1), privateKey: KEY }), { mode: 0o600 });
  expect(() => loadKeyFile(wrong, "payer")).toThrow("does not match its key");
  const broken = join(dir, "broken.json");
  writeFileSync(broken, `{"privateKey":"${KEY}"`, { mode: 0o600 });
  let message = "";
  try { loadKeyFile(broken, "payer"); } catch (error) { message = String(error); }
  expect(message).toContain("not valid JSON");
  expect(message).not.toContain(KEY.slice(2, 20));
});

test("send policy: mainnet always needs a typed yes at a terminal; --yes is testnet/anvil only", () => {
  expect(sendDecision(4663, { yes: true }, true)).toEqual({ kind: "refuse", reason: "--yes is not accepted on chain 4663" });
  expect(sendDecision(4663, { yes: false }, false).kind).toBe("refuse");
  expect(sendDecision(4663, { yes: false }, true)).toEqual({ kind: "ask" });
  expect(sendDecision(46630, { yes: true }, false)).toEqual({ kind: "auto" });
  expect(sendDecision(31337, { yes: true }, false)).toEqual({ kind: "auto" });
  expect(sendDecision(46630, { yes: false }, false).kind).toBe("refuse");
  expect(sendDecision(46630, { yes: false }, true)).toEqual({ kind: "ask" });
  expect(sendDecision(1, { yes: true }, true).kind).toBe("refuse");
  expect(() => assertYesAllowed(4663, true)).toThrow("--yes is not accepted on chain 4663");
  expect(() => assertYesAllowed(46630, true)).not.toThrow();
});

const intent = (chainId: number): TxIntent => ({ chainId, signer: ACCOUNT.address, to: a(9), functionName: "approve(spender=QueryEscrow, amount=0.10 USDG)", value: 0n, amount: "0.100000 USDG approved", purpose: "test", data: "0x1234" });
function io(answer: string, interactive = true): ConfirmIO & { lines: string[]; asked: number } {
  const state = { lines: [] as string[], asked: 0 };
  return Object.assign(state, { interactive, ask: async () => { state.asked++; return answer; }, print: (line: string) => { state.lines.push(line); } });
}

test("guardTransaction prints to, function, value, signer, chain and amount, and accepts only an exact yes on 4663", async () => {
  const ok = io("yes");
  await guardTransaction(intent(4663), { yes: false }, ok);
  const shown = ok.lines.join("\n");
  for (const part of ["MAINNET", "chain    : 4663", `signer   : ${ACCOUNT.address}`, `to       : ${a(9)}`, "function : approve", "value    : 0 ETH", "amount   : 0.100000 USDG approved"]) expect(shown).toContain(part);
  for (const answer of ["y", "YES", "", "yes please", "no"]) await expect(guardTransaction(intent(4663), { yes: false }, io(answer))).rejects.toBeInstanceOf(TxRefused);
  const piped = io("yes", false);
  await expect(guardTransaction(intent(4663), { yes: false }, piped)).rejects.toThrow("interactive terminal");
  expect(piped.asked).toBe(0);
  const auto = io("", false);
  await guardTransaction(intent(46630), { yes: true }, auto);
  expect(auto.asked).toBe(0);
  expect(describeTx({ ...intent(46630), value: 10n ** 15n })).toContain("  value    : 0.001 ETH");
});

function fakeClients(opts: { rpcChain?: number; walletChain?: number; account?: Address; revert?: boolean; status?: "success" | "reverted" } = {}) {
  const sent: unknown[] = [];
  return {
    sent,
    clients: {
      publicClient: {
        getChainId: async () => opts.rpcChain ?? 4663,
        call: async () => { if (opts.revert) throw new Error("execution reverted: Paused\nURL: https://x/?dkey=secret"); return {}; },
        waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: opts.status ?? "success", gasUsed: 21_000n, effectiveGasPrice: 10n ** 7n, blockNumber: 7n, transactionHash: hash, logs: [] }),
      },
      walletClient: { chain: { id: opts.walletChain ?? opts.rpcChain ?? 4663 }, account: { address: opts.account ?? ACCOUNT.address }, sendTransaction: async (args: unknown) => { sent.push(args); return `0x${"ab".repeat(32)}` as Hex; } },
    },
  };
}

test("sendGuardedTx never sends on 4663 without a typed yes, and checks chain, signer and simulation first", async () => {
  for (const [label, setup, policy, answer, interactive, message] of [
    ["4663 non-interactive", {}, { yes: false }, "yes", false, "interactive terminal"],
    ["4663 with --yes", {}, { yes: true }, "yes", true, "--yes is not accepted"],
    ["4663 declined", {}, { yes: false }, "nope", true, "not confirmed"],
    ["rpc on another chain", { rpcChain: 46630 }, { yes: true }, "yes", true, "RPC reports chain 46630"],
    ["wallet pinned elsewhere", { walletChain: 46630 }, { yes: false }, "yes", true, "not pinned"],
    ["wrong signer", { account: a(5) }, { yes: false }, "yes", true, "declared signer"],
    ["simulation revert", { revert: true }, { yes: false }, "yes", true, "simulation reverted"],
  ] as const) {
    const fake = fakeClients(setup);
    const prompt = io(answer, interactive);
    await expect(sendGuardedTx(fake.clients as never, intent(4663), policy, prompt), label).rejects.toThrow(message);
    expect(fake.sent, label).toHaveLength(0);
    if (label === "simulation revert") expect(prompt.asked).toBe(0);
  }
  const fake = fakeClients();
  let notified: Hex | undefined;
  const sent = await sendGuardedTx(fake.clients as never, intent(4663), { yes: false }, io("yes"), (hash) => { notified = hash; });
  expect(fake.sent).toHaveLength(1);
  expect(notified).toBe(sent.hash);
  expect(sent.gasCostWei).toBe(21_000n * 10n ** 7n);
  const testnet = fakeClients({ rpcChain: 46630 });
  await sendGuardedTx(testnet.clients as never, intent(46630), { yes: true }, io("", false));
  expect(testnet.sent).toHaveLength(1);
  await expect(sendGuardedTx(fakeClients({ rpcChain: 46630, status: "reverted" }).clients as never, intent(46630), { yes: true }, io("", false))).rejects.toThrow("reverted");
});

test("service signers, operator and intake come from launch identities or a verified report", () => {
  const flat = { attestor: a(1), feedRunner: a(2), orchestrator: a(3), indexer: a(4), postman: a(5), intake: { address: a(6) }, jurors: [{ operator: a(7) }, { operator: a(7).toUpperCase().replace("0X", "0x") }] };
  expect(serviceSignersFrom(flat)).toEqual({ attestor: a(1), feedRunner: a(2), orchestrator: a(3), indexer: a(4), postman: a(5) });
  expect(operatorFrom(flat)?.toLowerCase()).toBe(a(7));
  expect(intakeAddressFrom(flat)).toBe(a(6));
  const report = { serviceSigners: [{ name: "attestor", address: a(1) }, { name: "indexer", address: a(4) }, { name: "orchestrator", address: a(3) }, { name: "feed-runner", address: a(2) }, { name: "postman", address: a(5) }], identities: [{ name: "intake", address: a(6) }] };
  expect(serviceSignersFrom(report)).toEqual(serviceSignersFrom(flat));
  expect(intakeAddressFrom(report)).toBe(a(6));
  expect(() => serviceSignersFrom({ serviceSigners: [{ name: "attestor", address: a(1) }] })).toThrow("lacks service signers");
  expect(operatorFrom({ jurors: [{ operator: a(1) }, { operator: a(2) }] })).toBeUndefined();
});

test("service URLs are public HTTPS (loopback HTTP for tests) without credentials", () => {
  expect(checkServiceUrl("https://h.example/", "u")).toBe("https://h.example");
  expect(checkServiceUrl("http://127.0.0.1:8080", "u")).toBe("http://127.0.0.1:8080");
  for (const bad of ["http://h.example", "https://u:p@example.com", "https://h.example/?token=1", "ftp://h"]) expect(() => checkServiceUrl(bad, "u")).toThrow();
});

test("private JSON files are mode 600 in mode 700 directories", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "launch-ops-out-")), "nested");
  const file = join(dir, "x.json");
  writePrivateJson(file, { big: 10n ** 30n });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(file, "utf8")).big).toBe("1000000000000000000000000000000");
});

test("fetchJsonBounded never returns a raw failing body", async () => {
  const ok = await fetchJsonBounded("https://x", { fetcher: (async () => new Response('{"a":1}')) as unknown as typeof fetch });
  expect(ok).toMatchObject({ ok: true, json: { a: 1 } });
  const html = await fetchJsonBounded("https://x", { fetcher: (async () => new Response("<html>secret</html>", { status: 502 })) as unknown as typeof fetch });
  expect(html).toMatchObject({ ok: false, error: "response is not JSON" });
  expect(JSON.stringify(html)).not.toContain("secret");
  const big = await fetchJsonBounded("https://x", { maxBytes: 4, fetcher: (async () => new Response('{"a":12345}')) as unknown as typeof fetch });
  expect(big.error).toBe("response too large");
  const down = await fetchJsonBounded("https://x", { fetcher: (async () => { throw new TypeError("fetch failed https://x?dkey=abc"); }) as unknown as typeof fetch });
  expect(down).toMatchObject({ ok: false, status: 0, error: "unreachable" });
});

test("fetchLogsChunked halves the range when a provider rejects it", async () => {
  const ranges: Array<[number, number]> = [];
  const client = { request: async ({ params }: { params: [unknown] }) => {
    const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
    const from = Number(fromBlock); const to = Number(toBlock);
    if (to - from + 1 > 1000) throw new Error("range too large");
    ranges.push([from, to]);
    return [{ blockNumber: fromBlock }];
  } };
  const logs = await fetchLogsChunked(client as never, { address: a(1), topics: [] }, 1n, 3000n, 4000n, 250n);
  expect(ranges[0]).toEqual([1, 1000]);
  expect(ranges.at(-1)![1]).toBe(3000);
  expect(logs.length).toBe(ranges.length);
  await expect(fetchLogsChunked({ request: async () => { throw new Error("down"); } } as never, { address: a(1), topics: [] }, 1n, 10n, 500n, 250n)).rejects.toThrow("down");
});

test("chain head age is reported, with a note when the head is old", async () => {
  expect(headAgeSec(100n, 160_000)).toBe(60);
  expect(headAgeSec(200n, 160_000)).toBe(0);
  const client = (ts: bigint) => ({ getBlock: async () => ({ number: 7n, timestamp: ts }) });
  expect(await describeHead(client(100n), 160_000)).toBe("chain head 7 is 60s old");
  expect(await describeHead(client(100n), 1_000_000)).toContain("check the sender's nonce before any retry");
});
