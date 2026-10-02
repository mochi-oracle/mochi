// Local anvil for tests and rehearsals: an OS-assigned free high port, a listener proven to be the anvil we spawned, and
// the chain id we asked for, before anything is sent. Other local projects run their own chains on this machine (for
// example a Hardhat node on 18545), so fixed ports are never used.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ROOT = resolve(import.meta.dir, "../..");
export const ANVIL = [join(homedir(), ".foundry/bin/anvil"), Bun.which("anvil") ?? ""].find((p) => p && existsSync(p));
export const ARTIFACTS = existsSync(join(ROOT, "contracts/out/Entrypoint.sol/Entrypoint.json"));
/** Ports another local project may use; never start on or talk to them. */
export const RESERVED_PORTS = new Set([8545, 18545]);
const LSOF = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);

/** PIDs listening on <port> (undefined when lsof is unavailable). */
export function listenerPids(port: number): number[] | undefined {
  if (!LSOF) return undefined;
  const out = Bun.spawnSync([LSOF, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
  return out.stdout.toString().split("\n").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
}

/** An OS-assigned high port that nothing listens on. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((ok) => server.close(() => ok()));
    if (port >= 20_000 && !RESERVED_PORTS.has(port) && (listenerPids(port)?.length ?? 0) === 0) return port;
  }
  throw new Error("no free high port");
}

export type LocalAnvil = { rpc: string; port: number; proc: ChildProcess; stop(): Promise<void> };

/**
 * Starts our own anvil and proves the endpoint is ours before anything is sent: the port was free, the listener PID is
 * the anvil we spawned (when lsof exists), the process is alive, and eth_chainId is the one we asked for.
 */
export async function startAnvil(chainId: number, extraArgs: string[] = []): Promise<LocalAnvil> {
  if (!ANVIL) throw new Error("anvil not found (install Foundry)");
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const proc = spawn(ANVIL, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent", ...extraArgs], { stdio: "ignore" });
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    await Promise.race([new Promise<void>((ok) => proc.once("exit", () => ok())), Bun.sleep(3_000)]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  };
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) {
        const reported = Number.parseInt((await r.json() as { result: string }).result, 16);
        const pids = listenerPids(port);
        if (proc.exitCode !== null || reported !== chainId || (pids !== undefined && (pids.length !== 1 || pids[0] !== proc.pid))) {
          await stop();
          throw new Error(`127.0.0.1:${port} is not our anvil (chain ${reported}, listeners ${JSON.stringify(pids)}, ours ${proc.pid}); nothing sent`);
        }
        return { rpc, port, proc, stop };
      }
    } catch (error) { if (error instanceof Error && error.message.includes("is not our anvil")) throw error; }
    await Bun.sleep(100);
  }
  await stop();
  throw new Error("anvil did not start");
}

/** A JSON key file (mode 600) as the launch tools expect it. */
export function writeKey(dir: string, name: string, key: Hex): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ address: privateKeyToAccount(key).address, privateKey: key }), { mode: 0o600 });
  return file;
}

export type RunResult = { code: number; signal: string | null; stdout: string; stderr: string };

/**
 * Runs `bun <args>` in the repository with a minimal environment (PATH, HOME and `env`). `onStdout` sees output as it
 * arrives (to act while the child waits).
 */
export async function runBun(args: string[], opts: { env?: Record<string, string>; onStdout?: (text: string) => void; timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : undefined;
  let stdout = "";
  const readOut = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) { const text = decoder.decode(chunk, { stream: true }); stdout += text; opts.onStdout?.(stdout); }
  })();
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), readOut]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, signal: proc.signalCode ?? null, stdout, stderr };
}

/** Raw JSON-RPC to a loopback test chain (anvil_* / evm_* methods). */
export async function rpcCall<T = unknown>(rpc: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await r.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
