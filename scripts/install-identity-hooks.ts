#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

function git(args: string[], allowMissing = false): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0 && !(allowMissing && result.status === 1)) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

try {
  const root = git(["rev-parse", "--show-toplevel"]);
  const hooks = git(["rev-parse", "--git-path", "hooks"]);
  git(["config", "--local", "core.hooksPath", `${root}/.githooks`]);
  git(["config", "--local", "user.name", "Mochi Project"]);
  git(["config", "--local", "user.email", "source@mochi.invalid"]);
  git(["config", "--local", "commit.gpgsign", "false"]);
  git(["config", "--local", "tag.gpgsign", "false"]);
  git(["config", "--local", "--replace-all", "credential.helper", ""]);
  if (git(["config", "--local", "--get", "user.signingkey"], true)) git(["config", "--local", "--unset", "user.signingkey"]);
  console.log(`Neutral local Git identity and hooks enabled for ${root}.`);
  console.log(`Git will use repository hooks at ${root}/.githooks (Git's resolved hooks dir: ${hooks}).`);
} catch (error) {
  console.error(`Could not install identity hooks: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
