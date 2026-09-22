#!/usr/bin/env bun
/** Public-source identity and credential scanner. Findings never include matched text. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

export const NEUTRAL_IDENTITY = { name: "Mochi Project", email: "source@mochi.invalid" } as const;
export type Mode = "staged" | "all" | "history";
export type Finding = { file: string; line: number; rule: string };
export type Entry = { path: string; data: Uint8Array; mode?: string; source?: string };

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TEST_EMAIL = /(?:@example\.(?:com|org|net)|@localhost|@test\b|@[a-z0-9-]+\.invalid)$/i;
const CONTENT: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/i, "private-key-header"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/i, "github-token"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/i, "api-token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws-access-key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/i, "slack-token"],
  [/\/Users\/(?!runner\/|Shared\/)[A-Za-z0-9._-]+\//, "mac-home-path"],
  [/\/home\/(?!runner\/|user\/|node\/|bun\/)[A-Za-z0-9._-]+\//, "linux-home-path"],
];
const KEY_ASSIGN = /(?:private[_-]?key|priv[_-]?key|secret[_-]?key|\bpk\b|mnemonic|seed[_-]?phrase|api[_-]?key)["'`]?\s*[:=]\s*["'`]?(?:0x)?([0-9a-f]{64})\b/i;
const ENV_TEMPLATE = /(^|\/)\.env\.(?:example|sample|template)$/i;
const BAD_FILE: Array<[RegExp, string]> = [
  [/(^|\/)\.env(?:\..*)?$/i, "env-file"],
  [/\.(?:pem|key|p12|pfx|keystore)$/i, "key-file"],
  [/(^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:\.pub)?$/i, "ssh-key-file"],
  [/(^|\/)[^/]*(?:deployer|relayer|owner|guardian)[^/]*\.json$/i, "wallet-key-file"],
];
const PUBLIC_TEST_KEY_PATH = /^test\/fixtures\/public-test-keys(?:\.[^/]*)?$/;
const THIRD_PARTY_ATTRIBUTION_PATH = /^(?:contracts\/(?:lib|vendor)\/|vendor\/)/i;
const THIRD_PARTY_SOURCE_FIXTURE_EMAIL_PATH = /^services\/feed-runners\/test\/fixtures\/edgar-atom-nvda-real\.xml$/;
const KNOWN_PUBLIC_AUDIT_PDF = "contracts/lib/openzeppelin-contracts/audits/2018-10.pdf";
const KNOWN_PUBLIC_AUDIT_PDF_SHA256 = "77fd9b78c458eba19bde1f4bfa5a2a0437d65596b3365740860ab0071c2a4c03";
// Foundry's published local-only development accounts; accepted only in the dedicated fixture above.
const PUBLIC_TEST_KEYS = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
]);
const TARGET = { owner: "mochi-oracle", repo: "mochi" };

export function isNeutralIdentity(name: string, email: string): boolean {
  return name.toLowerCase() === NEUTRAL_IDENTITY.name.toLowerCase() && email.toLowerCase() === NEUTRAL_IDENTITY.email.toLowerCase();
}

export function run(command: string, args: string[], cwd: string, input?: Uint8Array): Uint8Array {
  const r = spawnSync(command, args, { cwd, input, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed${r.status === null ? " to start" : ` (exit ${r.status})`}`);
  return r.stdout;
}
function git(cwd: string, ...args: string[]): Uint8Array { return run("git", args, cwd); }
function str(data: Uint8Array): string { return Buffer.from(data).toString("utf8"); }
function nul(data: Uint8Array): string[] { return str(data).split("\0").filter(Boolean); }
function gitRoot(cwd: string): string { return str(git(cwd, "rev-parse", "--show-toplevel")).trim(); }
function gitPath(cwd: string, path: string): string { return resolve(cwd, path); }
function readDenylist(root: string): string[] {
  const gd = str(git(root, "rev-parse", "--git-dir")).trim();
  const file = resolve(root, gd, "info", "identity-denylist");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith("#"));
}
function fileRules(path: string): Finding[] {
  if (ENV_TEMPLATE.test(path)) return [];
  return BAD_FILE.filter(([rx]) => rx.test(path)).map(([, rule]) => ({ file: path, line: 0, rule }));
}

/** Scan raw bytes through a one-byte mapping so ASCII patterns still work on binary assets. */
export function scanEntry(entry: Entry, denylist: string[] = []): Finding[] {
  const findings = fileRules(entry.path);
  for (const value of denylist) if (value.length >= 3 && entry.path.toLowerCase().includes(value.toLowerCase())) findings.push({ file: entry.path, line: 0, rule: "denylisted-identity-path" });
  const bytes = Buffer.from(entry.data);
  const binary = bytes.includes(0) || !isUtf8(bytes);
  const knownPublicAudit = entry.path === KNOWN_PUBLIC_AUDIT_PDF && createHash("sha256").update(bytes).digest("hex") === KNOWN_PUBLIC_AUDIT_PDF_SHA256;
  const text = bytes.toString("latin1");
  const isDedicatedPublicFixture = PUBLIC_TEST_KEY_PATH.test(entry.path);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [rx, rule] of CONTENT) {
      if (rx.test(line) && !(knownPublicAudit && (rule === "mac-home-path" || rule === "linux-home-path"))) findings.push({ file: entry.path, line: i + 1, rule });
    }
    for (const m of line.matchAll(EMAIL)) {
      const email = m[0];
      if (binary) continue;
      const approved = TEST_EMAIL.test(email) || THIRD_PARTY_ATTRIBUTION_PATH.test(entry.path) || THIRD_PARTY_SOURCE_FIXTURE_EMAIL_PATH.test(entry.path);
      if (!approved) findings.push({ file: entry.path, line: i + 1, rule: "email-address" });
    }
    const key = KEY_ASSIGN.exec(line)?.[1]?.toLowerCase();
    if (key && !(isDedicatedPublicFixture && PUBLIC_TEST_KEYS.has(key))) findings.push({ file: entry.path, line: i + 1, rule: "private-key-assignment" });
    for (const value of denylist) if (value.length >= 3 && line.toLowerCase().includes(value.toLowerCase())) findings.push({ file: entry.path, line: i + 1, rule: "denylisted-identity" });
  });
  const privatePath = findings.some(f => f.rule === "denylisted-identity-path");
  return privatePath ? findings.map(f => ({ ...f, file: "(denylisted path)" })) : findings;
}

function isUtf8(data: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; }
  catch { return false; }
}

function trackedEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  for (const item of nul(git(root, "ls-files", "--stage", "-z"))) {
    const tab = item.indexOf("\t");
    const [mode, oid, stage] = item.slice(0, tab).split(" ");
    const path = item.slice(tab + 1);
    if (stage !== "0") throw new Error(`unmerged index entry: ${path}`);
    if (mode === "160000") throw new Error(`gitlink requires explicit public submodule policy: ${path}`);
    if (!oid || !mode) throw new Error(`invalid index entry: ${path}`);
    // Read the index blob. This covers tracked content even when a checkout file is missing or dirty.
    entries.push({ path, data: git(root, "cat-file", "blob", oid), mode, source: "index" });
  }
  return entries;
}
function stagedEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  for (const item of nul(git(root, "ls-files", "--stage", "-z"))) {
    const tab = item.indexOf("\t"); const [mode, oid, stage] = item.slice(0, tab).split(" "); const path = item.slice(tab + 1);
    if (stage !== "0") throw new Error(`unmerged index entry: ${path}`);
    if (mode === "160000") throw new Error(`gitlink requires explicit public submodule policy: ${path}`);
    if (!oid) throw new Error(`invalid index entry: ${path}`);
    entries.push({ path, data: git(root, "cat-file", "blob", oid), mode, source: "index" });
  }
  return entries;
}
function untrackedEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  for (const path of nul(git(root, "ls-files", "--others", "--exclude-standard", "-z"))) {
    const fullPath = resolve(root, path);
    const stat = lstatSync(fullPath);
    const data = stat.isSymbolicLink() ? Buffer.from(readlinkSync(fullPath)) : readFileSync(fullPath);
    entries.push({ path, data, source: "working-tree" });
  }
  return entries;
}
function checkIdentity(root: string): Finding[] {
  const out: Finding[] = [];
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const ident = str(git(root, "var", variable)).trim();
    const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(ident);
    if (!match || !isNeutralIdentity(match[1] ?? "", match[2] ?? "")) out.push({ file: `(${variable})`, line: 0, rule: "first-party-identity-mismatch" });
  }
  return out;
}
function checkRemoteAndConfig(root: string): Finding[] {
  const out: Finding[] = [];
  const remotes = str(git(root, "remote", "-v")).split(/\r?\n/).filter(Boolean);
  if (!remotes.length) out.push({ file: "(.git/config)", line: 0, rule: "missing-public-remote" });
  const remoteNames = new Set(remotes.map(row => row.split(/\s+/)[0]));
  if (remoteNames.size > 1 || [...remoteNames].some(name => name !== "origin")) out.push({ file: "(.git/config)", line: 0, rule: "unexpected-remotes" });
  const fetchUrl = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  const pushUrl = spawnSync("git", ["remote", "get-url", "--push", "origin"], { cwd: root, encoding: "utf8" });
  for (const result of [fetchUrl, pushUrl]) {
    if (result.status === 0 && result.stdout.trim() !== `https://github.com/${TARGET.owner}/${TARGET.repo}.git`) out.push({ file: "(.git/config)", line: 0, rule: "remote-url-rewrite" });
  }
  if (fetchUrl.status !== 0 && remotes.length || pushUrl.status !== 0 && remotes.length) throw new Error("could not resolve configured public remote");
  // Check effective config (system, global, and local) for prefixes that rewrite this target.
  const rewrites = spawnSync("git", ["config", "--null", "--show-origin", "--get-regexp", "^url\\..*\\.(insteadOf|pushInsteadOf)$"], { cwd: root, encoding: "buffer" });
  if (rewrites.status === 0) {
    const values = Buffer.from(rewrites.stdout).toString("utf8").split("\0").filter(Boolean);
    for (const entry of values) {
      const split = entry.indexOf("\n");
      const setting = entry.slice(split + 1);
      const value = setting.slice(setting.indexOf(" ") + 1);
      if (value && `https://github.com/${TARGET.owner}/${TARGET.repo}.git`.startsWith(value)) {
        out.push({ file: "(Git config)", line: 0, rule: "remote-url-rewrite" });
        break;
      }
    }
  } else if (rewrites.status !== 1) throw new Error("could not inspect effective URL rewrite configuration");
  for (const row of remotes) {
    const fields = row.split(/\s+/); const remoteUrl = fields[1] ?? "";
    let url: URL;
    try { if (remoteUrl.includes(":") && !remoteUrl.includes("://")) throw new Error(); url = new URL(remoteUrl); }
    catch { out.push({ file: "(.git/config)", line: 0, rule: "unsupported-or-ssh-remote" }); continue; }
    const path = url.pathname.replace(/^\/+|\.git$/g, "").split("/");
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || path[0]?.toLowerCase() !== TARGET.owner || path[1]?.toLowerCase() !== TARGET.repo) out.push({ file: "(.git/config)", line: 0, rule: "public-remote-mismatch" });
  }
  const mirror = spawnSync("git", ["config", "--bool", "--get", "remote.origin.mirror"], { cwd: root, encoding: "utf8" });
  if (mirror.status === 0 && mirror.stdout.trim().toLowerCase() === "true") out.push({ file: "(.git/config)", line: 0, rule: "mirror-push-configured" });
  else if (mirror.status !== 0 && mirror.status !== 1) throw new Error("could not inspect mirror-push configuration");
  const extraHeader = spawnSync("git", ["config", "--get-urlmatch", "http.extraheader", `https://github.com/${TARGET.owner}/${TARGET.repo}.git`], { cwd: root, encoding: "buffer" });
  if (extraHeader.status === 0 && extraHeader.stdout.length) out.push({ file: "(Git config)", line: 0, rule: "http-extra-header-configured" });
  else if (extraHeader.status !== 0 && extraHeader.status !== 1) throw new Error("could not inspect effective HTTP authentication configuration");
  return out;
}
function scanEntries(entries: Entry[], deny: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const e of entries) findings.push(...scanEntry(e, deny));
  return findings;
}

function historyEntries(root: string): { findings: Finding[]; entries: number } {
  const findings: Finding[] = []; let entries = 0;
  const deny = readDenylist(root);
  const commits = str(git(root, "rev-list", "--all", "--reflog", "--reverse")).split(/\r?\n/).filter(Boolean);
  if (!commits.length) return { findings, entries: 0 };
  if (str(git(root, "rev-parse", "--is-shallow-repository")).trim() !== "false") throw new Error("history scan requires a complete, non-shallow repository");
  if (str(git(root, "replace", "-l")).trim()) throw new Error("history scan refuses replacement objects");
  const grafts = str(git(root, "rev-parse", "--git-path", "info/grafts")).trim();
  if (grafts && existsSync(resolve(root, grafts)) && readFileSync(resolve(root, grafts), "utf8").trim()) throw new Error("history scan refuses grafted history");
  const seenVersions = new Set<string>();
  for (const oid of commits) {
    const commitBody = git(root, "cat-file", "commit", oid);
    const fields = str(git(root, "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%G?", oid)).replace(/\n$/, "").split("\0");
    if (fields.length < 4 || !isNeutralIdentity(fields[0] ?? "", fields[1] ?? "") || !isNeutralIdentity(fields[2] ?? "", fields[3] ?? "")) findings.push({ file: `commit:${oid.slice(0, 12)}`, line: 0, rule: "historical-commit-identity-mismatch" });
    if (fields[4] && fields[4] !== "N") findings.push({ file: `commit:${oid.slice(0, 12)}`, line: 0, rule: "signed-commit-requires-review" });
    findings.push(...scanEntry({ path: `commit:${oid.slice(0, 12)}`, data: commitBody }, deny));
    const treeEntries = nul(git(root, "ls-tree", "-r", "-z", "--full-tree", oid));
    for (const item of treeEntries) {
      const tab = item.indexOf("\t");
      const [mode, type, blobOid] = item.slice(0, tab).split(" ");
      const path = item.slice(tab + 1);
      if (mode === "160000" || type === "commit") { findings.push({ file: path, line: 0, rule: "historical-gitlink" }); continue; }
      if (type !== "blob" || !blobOid) throw new Error(`invalid historical tree entry: ${path}`);
      const version = `${path}\0${blobOid}`;
      if (seenVersions.has(version)) continue;
      seenVersions.add(version);
      findings.push(...scanEntry({ path, data: git(root, "cat-file", "blob", blobOid), source: oid }, deny));
      entries++;
    }
  }
  for (const ref of str(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)", "refs/tags")).split("\n").filter(Boolean)) {
    const [name, oid, kind] = ref.split("\0");
    if (kind !== "tag" || !oid) continue;
    const body = str(git(root, "cat-file", "tag", oid));
    const tagger = /^tagger (.*) <([^>]*)> \d+ [+-]\d{4}$/m.exec(body);
    if (!tagger || !isNeutralIdentity(tagger[1] ?? "", tagger[2] ?? "")) findings.push({ file: `tag:${name}`, line: 0, rule: "historical-tag-identity-mismatch" });
    findings.push(...scanEntry({ path: `tag:${name}`, data: Buffer.from(body) }, deny));
    const sig = /-----BEGIN PGP SIGNATURE-----/;
    if (sig.test(body)) findings.push({ file: `tag:${name}`, line: 0, rule: "signed-tag-requires-review" });
  }
  return { findings, entries };
}

export function scan(root: string, mode: Mode, allowMissingRemote = false): { findings: Finding[]; entries: number } {
  root = gitRoot(resolve(root));
  const deny = readDenylist(root);
  if (mode === "history") return historyEntries(root);
  const entries = mode === "staged" ? stagedEntries(root) : trackedEntries(root);
  if (mode === "all" && allowMissingRemote) entries.push(...untrackedEntries(root));
  const findings = scanEntries(entries, deny);
  if (mode === "staged") findings.push(...checkIdentity(root));
  findings.push(...checkRemoteAndConfig(root).filter(f =>
    !((allowMissingRemote || mode === "staged") && f.rule === "missing-public-remote")
  ));
  const localName = spawnSync("git", ["config", "--local", "--get", "user.name"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
  const localEmail = spawnSync("git", ["config", "--local", "--get", "user.email"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
  if (!isNeutralIdentity(localName, localEmail)) findings.push({ file: "(.git/config)", line: 0, rule: "local-git-identity-mismatch" });
  return { findings, entries: entries.length };
}

export function formatFindings(findings: Finding[]): string[] { return findings.map(f => `${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}`); }
function main(): void {
  const args = process.argv.slice(2);
  let mode: Mode = "staged";
  if (args.includes("--all")) mode = "all";
  else if (args.includes("--history")) mode = "history";
  else if (args[0] === "--mode" && ["staged", "all", "history"].includes(args[1] ?? "")) mode = args[1] as Mode;
  else if (args.length) throw new Error("usage: bun scripts/identity-guard.ts [--mode staged|all|history|--all|--history]");
  const result = scan(process.cwd(), mode);
  if (!result.findings.length) { console.log(`identity-guard: ${mode} scan clean (${result.entries} entries)`); return; }
  for (const line of formatFindings(result.findings)) console.error(line);
  console.error(`identity-guard: ${result.findings.length} finding(s)`);
  process.exitCode = 1;
}
if (import.meta.main) { try { main(); } catch (error) { console.error(`identity-guard: ${error instanceof Error ? error.message : "scan failed"}`); process.exitCode = 2; } }
