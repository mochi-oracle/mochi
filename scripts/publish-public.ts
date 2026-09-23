#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNeutralIdentity, scan } from "./identity-guard";

type Publisher = { login: string; id: string };
export function verifyAuthenticatedActor(expected: Publisher, login: string, id: string): boolean {
  return expected.login.toLowerCase() === login.toLowerCase() && expected.id === id;
}

const REMOTE = "https://github.com/mochi-oracle/mochi.git";
const ZERO = "0000000000000000000000000000000000000000";

export function parsePublishArgs(args: string[]): { checkOnly: true; branch?: never } | { checkOnly: false; branch: string } {
  const checkOnly = args.length === 1 && args[0] === "--check";
  if (!checkOnly && (args.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(args[0]!) || args[0]!.startsWith("-") || args[0]!.includes(".."))) throw new Error("usage: bun scripts/publish-public.ts --check | <branch>");
  return checkOnly ? { checkOnly: true } : { checkOnly: false, branch: args[0]! };
}

function call(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv } ): string {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed`);
  return result.stdout.trim();
}
function safeGitIdentity(cwd: string): void {
  const name = call("git", ["config", "--local", "--get", "user.name"], { cwd });
  const email = call("git", ["config", "--local", "--get", "user.email"], { cwd });
  if (!isNeutralIdentity(name, email)) throw new Error("neutral repository-local author identity is required");
}
function approvedPublisher(cwd: string): Publisher {
  const login = call("git", ["config", "--local", "--get", "mochi.publisherLogin"], { cwd });
  const id = call("git", ["config", "--local", "--get", "mochi.publisherId"], { cwd });
  if (!/^[a-zA-Z0-9-]+$/.test(login) || !/^[0-9]+$/.test(id)) throw new Error("configure an explicitly approved publisher in local Git config");
  return { login, id };
}
function authenticatedToken(cwd: string, identity: Publisher): string {
  const authEnv = { ...process.env };
  delete authEnv.GH_TOKEN;
  delete authEnv.GITHUB_TOKEN;
  const token = call("gh", ["auth", "token", "--user", identity.login], { cwd, env: authEnv });
  if (!token || /\s/.test(token)) throw new Error("GitHub CLI has no usable token for the approved account");
  const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const verified = call("gh", ["api", "user", "--jq", "[.login, (.id|tostring)] | @tsv"], { cwd, env });
  const [login, id] = verified.split("\t");
  if (!verifyAuthenticatedActor(identity, login ?? "", id ?? "")) throw new Error("the selected GitHub credential does not match the repository-local approved identity");
  return token;
}
function checkRemote(cwd: string): void {
  const url = call("git", ["remote", "get-url", "origin"], { cwd });
  if (url !== REMOTE) throw new Error("origin must be the approved HTTPS public repository URL");
}

function main(): void {
  const args = process.argv.slice(2);
  const parsed = parsePublishArgs(args);
  const checkOnly = parsed.checkOnly;
  const cwd = call("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  safeGitIdentity(cwd);
  const publisher = checkOnly ? undefined : approvedPublisher(cwd);
  // Readiness check is also the required gate before creating the public remote repository.
  const result = scan(cwd, "history", true);
  if (result.findings.length) throw new Error(`identity scan failed with ${result.findings.length} finding(s); run the identity guard for path and rule details`);
  const currentTree = scan(cwd, "all", true);
  if (currentTree.findings.length) throw new Error(`repository guard failed with ${currentTree.findings.length} finding(s); run the identity guard for path and rule details`);
  if (checkOnly) {
    console.log(`Local checks passed (${result.entries} historical file versions, ${currentTree.entries} snapshot entries).`);
    return;
  }
  const status = call("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  if (status) throw new Error("working tree and index must be clean before publication");
  // Pin the selected credential to the account before any repository-creation or push step.
  const token = authenticatedToken(cwd, publisher!);
  checkRemote(cwd);
  const branch = parsed.branch!;
  if (spawnSync("git", ["check-ref-format", "--branch", branch], { cwd }).status !== 0) throw new Error("invalid branch name");
  const current = call("git", ["branch", "--show-current"], { cwd });
  if (current !== branch) throw new Error("the requested branch must be the checked-out branch");
  const askpassDir = mkdtempSync(join(tmpdir(), "mochi-publish-"));
  const askpass = join(askpassDir, "askpass.sh");
  writeFileSync(askpass, "#!/bin/sh\ncase \"$1\" in *sername*) printf '%s\\n' x-access-token ;; *) printf '%s\\n' \"$MOCHI_PUSH_TOKEN\" ;; esac\n", { mode: 0o700 });
  try {
    const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GIT_ASKPASS: askpass, GIT_ASKPASS_REQUIRE: "force", GIT_TERMINAL_PROMPT: "0", MOCHI_PUSH_TOKEN: token, MOCHI_PUBLISH_WRAPPER: "1" };
    const remoteLine = call("git", ["-c", "credential.helper=", "ls-remote", "origin", `refs/heads/${branch}`], { cwd, env });
    if (remoteLine) {
      const remoteOid = remoteLine.split(/\s+/)[0] ?? "";
      const localOid = call("git", ["rev-parse", branch], { cwd, env });
      if (!remoteOid || remoteOid === ZERO || spawnSync("git", ["merge-base", "--is-ancestor", remoteOid, localOid], { cwd }).status !== 0) throw new Error("push would not be a fast-forward");
    }
    // A single explicit refspec, no mirror/all/force options. Empty helper resets configured credential stores.
    const resultPush = spawnSync("git", ["-c", "credential.helper=", "push", "--no-follow-tags", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (resultPush.status !== 0) throw new Error("GitHub rejected the explicit fast-forward push");
    console.log(`Pushed ${branch} to the approved public repository.`);
  } finally {
    rmSync(askpassDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { main(); }
  catch (error) { console.error(`publish-public: ${error instanceof Error ? error.message : "publication check failed"}`); process.exitCode = 1; }
}
