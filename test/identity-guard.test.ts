import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNeutralIdentity, scan, scanEntry, type Finding } from "../scripts/identity-guard";
import { parsePublishArgs, verifyAuthenticatedActor } from "../scripts/publish-public";

const IDENTITY = { name: "Mochi Project", email: "source@mochi.invalid" };
const dirs: string[] = [];

function command(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`fixture git ${args[0]} failed`);
  return result.stdout.toString().trim();
}
function fixture(withRemote = true): string {
  const root = mkdtempSync(join(tmpdir(), "mochi-neutral-identity-test-"));
  dirs.push(root);
  command(root, ["init", "-q"]);
  command(root, ["config", "--local", "user.name", IDENTITY.name]);
  command(root, ["config", "--local", "user.email", IDENTITY.email]);
  command(root, ["config", "--local", "credential.helper", ""]);
  if (withRemote) command(root, ["remote", "add", "origin", "https://github.com/mochi-oracle/mochi.git"]);
  return root;
}
function commit(root: string, message: string, extraEnv: NodeJS.ProcessEnv = {}): void {
  command(root, ["add", "-A"]);
  command(root, ["commit", "-m", message], {
    ...process.env,
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    ...extraEnv,
  });
}
function rules(findings: Finding[]): string[] { return findings.map(f => f.rule); }
function hookMocks(root: string, mockGit = true): string {
  const bin = join(root, ".git", "mock-bin");
  mkdirSync(bin);
  for (const name of mockGit ? ["gh", "git"] : ["gh"]) {
    const marker = join(root, ".git", `${name}-was-called`);
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf called > "${marker}"\nexit 0\n`);
    chmodSync(join(bin, name), 0o700);
  }
  return bin;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("neutral identity scanner and guarded publication", () => {
  test("accepts only the neutral first-party identity pair", () => {
    expect(isNeutralIdentity("Mochi Project", "source@mochi.invalid")).toBe(true);
    expect(isNeutralIdentity("mochi project", "SOURCE@MOCHI.INVALID")).toBe(true);
    expect(isNeutralIdentity("Mochi Project", "other@mochi.invalid")).toBe(false);
    expect(isNeutralIdentity("Fictional Contributor", "fake" + "@users." + "noreply.github.com")).toBe(false);
  });

  test("scans staged index blobs rather than later working-tree edits", () => {
    const root = fixture();
    writeFileSync(join(root, "staged.txt"), `token=ghp_${"A".repeat(36)}\n`);
    command(root, ["add", "staged.txt"]);
    writeFileSync(join(root, "staged.txt"), "safe after staging\n");
    expect(rules(scan(root, "staged").findings)).toContain("github-token");
  });

  test("checks credentials and denylisted fragments in binary bytes and paths", () => {
    const finding = scanEntry({ path: "assets/private-fixture.bin", data: Buffer.from([0, 255, ...Buffer.from(`ghp_${"B".repeat(36)} blocked-fragment`), 0]) }, ["blocked-fragment"]);
    expect(rules(finding)).toContain("github-token");
    expect(rules(finding)).toContain("denylisted-identity");
    expect(rules(scanEntry({ path: "blocked-fragment/file.txt", data: Buffer.from("clean") }, ["blocked-fragment"]))).toContain("denylisted-identity-path");
    expect(JSON.stringify(finding)).not.toContain("ghp_");
    expect(JSON.stringify(scanEntry({ path: "blocked-fragment/file.txt", data: Buffer.from("clean") }, ["blocked-fragment"]))).not.toContain("blocked-fragment");
  });

  test("keeps the known local test-key exception narrow", () => {
    const known = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const content = `const privateKey = "${known}";`;
    expect(rules(scanEntry({ path: "test/fixtures/public-test-keys.ts", data: Buffer.from(content) }))).not.toContain("private-key-assignment");
    expect(rules(scanEntry({ path: "test/fixtures/other.ts", data: Buffer.from(content) }))).toContain("private-key-assignment");
  });

  test("preserves third-party attribution while rejecting unrelated email identities", () => {
    const attribution = "Maintainer <maintainer@" + "third-party.dev>";
    expect(rules(scanEntry({ path: "contracts/lib/tool/LICENSE", data: Buffer.from(attribution) }))).not.toContain("email-address");
    expect(rules(scanEntry({ path: "src/config.ts", data: Buffer.from(attribution) }))).toContain("email-address");
  });

  test("accepts neutral history and rejects a generic previously allowlisted personal actor", () => {
    const neutral = fixture();
    writeFileSync(join(neutral, "safe.txt"), "safe\n");
    commit(neutral, "neutral commit");
    command(neutral, ["tag", "-a", "neutral", "-m", "neutral tag"]);
    expect(rules(scan(neutral, "history").findings)).not.toContain("historical-commit-identity-mismatch");
    expect(rules(scan(neutral, "history").findings)).not.toContain("historical-tag-identity-mismatch");

    const personalFixture = fixture();
    writeFileSync(join(personalFixture, "old-attribution.txt"), "historical fixture\n");
    commit(personalFixture, "fictional historical contributor", {
      GIT_AUTHOR_NAME: "Fictional Contributor",
      GIT_AUTHOR_EMAIL: "24680+fictional-contributor" + "@users." + "noreply.github.com",
      GIT_COMMITTER_NAME: "Fictional Contributor",
      GIT_COMMITTER_EMAIL: "24680+fictional-contributor" + "@users." + "noreply.github.com",
    });
    expect(rules(scan(personalFixture, "history").findings)).toContain("historical-commit-identity-mismatch");
  });

  test("staged neutral initial snapshot needs no remote", () => {
    const root = fixture(false);
    writeFileSync(join(root, "safe.txt"), "safe\n");
    command(root, ["add", "safe.txt"]);
    expect(scan(root, "staged").findings).toEqual([]);
  });

  test("allowing a missing remote still rejects an unsafe configured remote", () => {
    const root = fixture(false);
    command(root, ["remote", "add", "origin", "https://github.com/fictional-owner/fixture.git"]);
    expect(rules(scan(root, "all", true).findings)).toContain("public-remote-mismatch");
  });

  test("local check scans an untracked snapshot without an origin or network tools", () => {
    const root = fixture(false);
    writeFileSync(join(root, "candidate.txt"), "neutral local snapshot\n");
    const script = fileURLToPath(new URL("../scripts/publish-public.ts", import.meta.url));
    const bin = hookMocks(root, false);
    const result = spawnSync(process.execPath, [script, "--check"], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`local check failed: ${result.stderr}`);
    expect(result.stdout).toContain("1 snapshot entries");
    expect(result.stderr).toBe("");
  });

  test("missing local publisher approval fails before accessing GitHub credentials", () => {
    const root = fixture(false);
    const script = fileURLToPath(new URL("../scripts/publish-public.ts", import.meta.url));
    const bin = hookMocks(root, false);
    const result = spawnSync(process.execPath, [script, "main"], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MOCHI_PUBLISH_WRAPPER: "1" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("git config failed");
    expect(result.stderr).not.toContain("credential");
    expect(existsSync(join(root, ".git", "gh-was-called"))).toBe(false);
    expect(existsSync(join(root, ".git", "git-was-called"))).toBe(false);
  });

  test("pre-push refuses immediately even if the former wrapper marker is present", () => {
    const root = fixture(false);
    const hook = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
    const bin = hookMocks(root);
    const result = spawnSync(hook, ["origin", "https://github.com/mochi-oracle/mochi.git"], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MOCHI_PUBLISH_WRAPPER: "1" },
      input: `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"0".repeat(40)}\n`,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("verified publisher transport is required");
    expect(existsSync(join(root, ".git", "gh-was-called"))).toBe(false);
    expect(existsSync(join(root, ".git", "git-was-called"))).toBe(false);
  });

  test("transport account approval is independent of neutral commit metadata", () => {
    const expected = { login: "fictional-publisher", id: "12345" };
    expect(verifyAuthenticatedActor(expected, "fictional-publisher", "12345")).toBe(true);
    expect(verifyAuthenticatedActor(expected, "someone-else", "12345")).toBe(false);
    expect(verifyAuthenticatedActor(expected, "fictional-publisher", "99999")).toBe(false);
  });

  test("publisher argument parser distinguishes check from any push branch", () => {
    expect(parsePublishArgs(["--check"])).toEqual({ checkOnly: true });
    expect(parsePublishArgs(["main"])).toEqual({ checkOnly: false, branch: "main" });
    expect(() => parsePublishArgs(["main", "refs/tags/v1"])).toThrow();
  });
});
