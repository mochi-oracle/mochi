import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Hex } from "viem";

/** Hashes regular files by relative path, then hashes the concatenated binary per-file digests. */
export async function hashWeightsDirectory(directory: string): Promise<Hex> {
  const files: string[] = [];
  async function collect(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await collect(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await collect(directory);
  files.sort((a, b) => {
    const left = relative(directory, a).split(sep).join("/");
    const right = relative(directory, b).split(sep).join("/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const combined = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 * 1024 })) digest.update(chunk);
    combined.update(digest.digest());
  }
  return `0x${combined.digest("hex")}` as Hex;
}
