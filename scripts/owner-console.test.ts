import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { buildPhalaBatch } from "./phala-batch.ts";
import { createOwnerConsole, loadDeployment, loadSteps, parseArgs, stepStatus, type ChainReader } from "./owner-console.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const m = `0x${"12".repeat(32)}` as Hex;
const deployment = loadDeployment({ chainId: 4663, owner: a(200), rpcUrl: "https://rpc.example", contracts: { timelock: a(101), jurorRegistry: a(102), queryEscrow: a(103), receiptAnchor: a(104), panel: a(106), mochiToken: a(107), usdg: a(108) }, privacy: { entrypoint: a(105) } });
const identity = (n: number) => ({ address: a(n), operator: a(100), measurement: m });
const input = { salt: m, intake: identity(1), consensus: identity(2), jurors: [0, 0, 1, 1, 2, 2, 3, 4, 4].map((cls, i) => ({ ...identity(i + 3), class: cls })), attestor: a(110), feedRunner: a(111), orchestrator: a(112), indexer: a(113), postman: a(114) };
const html = readFileSync(new URL("./owner-console.html", import.meta.url), "utf8");

test("timelock batches decode every inner call by contract and function, with role names", () => {
  const steps = loadSteps(deployment, buildPhalaBatch(deployment as never, input, "schedule", "configure"), "configure.json", "b1");
  expect(steps).toHaveLength(1);
  expect(steps[0]!.kind).toBe("timelock-schedule");
  expect(steps[0]!.details.some((d) => d.startsWith("jurorRegistry.registerServiceKey("))).toBe(true);
  expect(steps[0]!.details.some((d) => d.startsWith("queryEscrow.grantRole(FEED_RUNNER_ROLE"))).toBe(true);
  expect(steps[0]!.details.some((d) => d.startsWith("privacy.entrypoint.grantRole(ASP_POSTMAN_ROLE"))).toBe(true);
  expect(steps[0]!.details.at(-1)).toBe("Waiting period after scheduling: 86400 seconds");
  const activate = loadSteps(deployment, buildPhalaBatch(deployment as never, input, "execute", "activate"), "activate.json", "b2");
  expect(activate[0]!.kind).toBe("timelock-execute");
  expect(activate[0]!.details).toEqual(["queryEscrow.unpause()"]);
});

test("tampered batches, foreign targets, value transfers and wrong chains are refused at load", () => {
  const batch = buildPhalaBatch(deployment as never, input, "schedule", "configure");
  const swapped = { ...batch, payloads: [...batch.payloads].reverse() };
  expect(() => loadSteps(deployment, swapped, "f", "x")).toThrow("does not match the listed");
  expect(() => loadSteps(deployment, { ...batch, operationId: `0x${"00".repeat(32)}` }, "f", "x")).toThrow("operationId does not match");
  expect(() => loadSteps(deployment, { ...batch, to: a(999) }, "f", "x")).toThrow("must target the deployment timelock");
  const approve = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), args: [a(102), 9n * 10n ** 18n] });
  expect(() => loadSteps(deployment, { chainId: 4663, transactions: [{ to: a(999), data: approve, value: "0" }] }, "f", "x")).toThrow("not a contract in this deployment");
  expect(() => loadSteps(deployment, { chainId: 4663, transactions: [{ to: a(107), data: approve, value: "1" }] }, "f", "x")).toThrow("sends value");
  expect(() => loadSteps(deployment, { chainId: 46630, transactions: [{ to: a(107), data: approve, value: "0" }] }, "f", "x")).toThrow("does not match the deployment");
  expect(() => loadSteps(deployment, { chainId: 4663, transactions: [{ to: a(102), data: "0xdeadbeef", value: "0" }] }, "f", "x")).toThrow("cannot decode");
  const tx = loadSteps(deployment, { chainId: 4663, transactions: [{ to: a(107), data: approve, value: "0", purpose: "approve bonds" }] }, "f", "x");
  expect(tx[0]!.details[0]).toBe(`mochiToken.approve(${a(102)} (jurorRegistry), 9000000000000000000 (9 tokens))`);
  expect(() => loadDeployment({ ...deployment, chainId: 46630 })).toThrow("rehearsal");
  expect(loadDeployment({ ...deployment, chainId: 46630, rehearsal: true }).chainId).toBe(46630);
});

test("status comes from the timelock: unscheduled, pending, ready, done, or unavailable", async () => {
  const [step] = loadSteps(deployment, buildPhalaBatch(deployment as never, input, "execute", "configure"), "f", "x");
  const reader = (scheduled: bigint): ChainReader => ({ operationTimestamp: async () => scheduled, latestTimestamp: async () => 1_000n });
  expect(await stepStatus(step!, a(101), reader(0n))).toBe("unscheduled");
  expect(await stepStatus(step!, a(101), reader(2_000n))).toBe("pending");
  expect(await stepStatus(step!, a(101), reader(900n))).toBe("ready");
  expect(await stepStatus(step!, a(101), reader(1n))).toBe("done");
  expect(await stepStatus(step!, a(101), { operationTimestamp: async () => { throw new Error("rpc down"); }, latestTimestamp: async () => 0n })).toBe("unavailable");
  expect(await stepStatus(step!, a(101), undefined)).toBe("unavailable");
});

test("server serves the page with a strict policy, records only same-origin well-formed results to a private file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-console-"));
  const logPath = join(dir, "log.jsonl");
  const steps = loadSteps(deployment, buildPhalaBatch(deployment as never, input, "schedule", "configure"), "f", "b1");
  const handler = createOwnerConsole({ deployment, steps, expectFrom: a(200), logPath, html });
  const origin = "http://127.0.0.1:4455";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler(r, origin) });
  try {
    expect(server.hostname).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const listed = await (await fetch(`${base}/api/steps`)).json() as { steps: Array<{ status: string }>; expectFrom: string };
    expect(listed.steps[0]!.status).toBe("unavailable");
    expect(listed.expectFrom).toBe(a(200));
    const record = (body: unknown, from = origin) => fetch(`${base}/api/record`, { method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify(body) });
    const good = { stepId: "b1", txHash: `0x${"ab".repeat(32)}`, from: a(200), chainId: 4663, outcome: "sent" };
    expect((await record(good, "https://evil.example")).status).toBe(403);
    expect((await record({ ...good, from: a(201) })).status).toBe(400);
    expect((await record({ ...good, chainId: 1 })).status).toBe(400);
    expect((await record({ ...good, stepId: "nope" })).status).toBe(400);
    expect((await record(good)).status).toBe(200);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath, "utf8")).toContain(good.txHash);
    expect((await fetch(`${base}/anything`)).status).toBe(404);
  } finally { server.stop(true); }
});

test("the page loads nothing from the network and the CLI needs a deployment and a batch", () => {
  const urls = html.match(/https?:\/\/[^\s'"`<>)]+/g) ?? [];
  expect(urls.sort()).toEqual(["https://rpc.mainnet.chain.robinhood.com", "https://rpc.testnet.chain.robinhood.com"]);
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
  expect(() => parseArgs(["--deployment", "d.json"])).toThrow("usage");
  expect(parseArgs(["--deployment", "d.json", "--batch", "a.json", "--batch", "b.json"]).batches).toEqual(["a.json", "b.json"]);
});
