import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { concat, fromHex, sha256, toHex } from "viem";
import type { TeeProvider } from "./provider.ts";
import { seal, type Envelope } from "./envelope.ts";

export interface SealedStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  /**
   * Atomic first-write-wins: stores `value` only if `key` has no entry, and reports whether it wrote. Unlike
   * get-then-put, two writers (including separate processes sharing a store directory) can never both win, and a
   * reader never observes a partially written entry.
   */
  putIfAbsent?(key: string, value: Uint8Array): Promise<boolean>;
  has(key: string): Promise<boolean>;
  /** Marks an entry as in use so the retention sweeper keeps it for the retained lifetime (no-op without retention). */
  retain?(key: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/**
 * Optional retention for stores that accept untrusted public writes (intake uploads). Without it, entries are kept
 * forever, which is the required behavior for consensus and juror state.
 *
 * An entry is either unretained (written, never retained: an upload no query has used yet) or retained (`retain()`
 * marked it in use). Each kind has its own lifetime and byte cap, so free writes cannot crowd out retained entries and
 * retained entries cannot pin the disk forever. Byte counts are disk use: whole 4 KiB blocks per file (`diskBytes`).
 */
export interface SealedStoreRetention {
  /** Unretained entries are purged this many seconds after their last write. */
  ttlSec: number;
  /**
   * Retained entries are purged this many seconds after their last `retain()` (each call restarts the clock). Without
   * it, retained entries are kept until deleted.
   */
  retainedTtlSec?: number;
  /** Disk bytes of all entries above which new writes are refused instead of filling the shared disk. */
  maxBytes?: number;
  /** Disk bytes of unretained entries above which new writes are refused. */
  maxUnretainedBytes?: number;
  /** Disk bytes of retained entries above which `retain()` refuses (the entry stays unretained). */
  maxRetainedBytes?: number;
  /** Treat a successful get() as retention (the caller reads an entry only once it is in use). Default false. */
  retainOnRead?: boolean;
  /** Background sweep period; 0 disables the timer (call sweep() directly). Default 10 minutes. */
  sweepIntervalMs?: number;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

/** Thrown when a retention-bounded store is full even after purging expired entries. */
export class SealedStoreFullError extends Error {
  constructor(readonly pool: "unretained" | "retained" | "total" = "total") { super("sealed store capacity reached"); this.name = "SealedStoreFullError"; }
}

export class MemorySealedStore implements SealedStore {
  private readonly entries = new Map<string, Uint8Array>();
  async get(key: string) { const value = this.entries.get(key); return value === undefined ? undefined : value.slice(); }
  async put(key: string, value: Uint8Array) { this.entries.set(key, value.slice()); }
  async putIfAbsent(key: string, value: Uint8Array) {
    if (this.entries.has(key)) return false;
    this.entries.set(key, value.slice());
    return true;
  }
  async has(key: string) { return this.entries.has(key); }
  async retain(_key: string) {}
  async delete(key: string) { this.entries.delete(key); }
}

const hasCode = (error: unknown, code: string) => !!error && typeof error === "object" && "code" in error && error.code === code;
const isMissing = (error: unknown) => hasCode(error, "ENOENT");
/** Entries: binary (`.bin`), or the hex-in-JSON envelopes written before it (`.json`, still read and swept). */
const ENTRY = /^0x[0-9a-f]{64}\.(?:bin|json)$/;
/** putIfAbsent staging files; a crash can leave one behind, which the retention sweep removes after the TTL. */
const STAGED = /^\.0x[0-9a-f]{64}\.[0-9a-f]{16}\.tmp$/;
/** Binary entry: "MSS" and format 1, then the envelope's 32-byte ephemeral key, 12-byte nonce and ciphertext+tag. */
const MAGIC = new Uint8Array([0x4d, 0x53, 0x53, 0x01]);
const HEADER = MAGIC.length + 32 + 12;
const BLOCK = 4096;
/** Disk use of a file of `size` bytes: whole filesystem blocks, at least one (its inode and directory entry). */
export const diskBytes = (size: number) => Math.max(1, Math.ceil(size / BLOCK)) * BLOCK;
const MARKER_BYTES = diskBytes(0);
const isBinary = (data: Uint8Array) => data.byteLength >= HEADER + 16 && MAGIC.every((byte, i) => data[i] === byte);
const fileInfo = (path: string) => stat(path).then((info) => info, (error) => { if (isMissing(error)) return undefined; throw error; });

/**
 * File-backed store encrypting every value to the provider's enclave key before writing ciphertext. Entries are
 * binary (the sealed envelope's raw bytes, not hex inside JSON, which doubled every byte); entries written in the
 * earlier JSON format are still read. With a retention policy, an unretained entry expires `ttlSec` after its last
 * write (file mtime); `retain()` adds a `<name>.keep` marker whose mtime starts the retained lifetime
 * (`retainedTtlSec`); a periodic sweep deletes what has expired and recounts disk use.
 */
export class FileSealedStore implements SealedStore {
  /** Disk bytes of unretained and retained entries on disk (undefined until the first sweep). */
  private unretainedBytes: number | undefined;
  private retainedBytes = 0;
  /** Disk bytes reserved by writes in flight (not yet visible to a sweep). */
  private pendingBytes = 0;
  private sweeping: Promise<number> | undefined;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly dir: string, private readonly provider: TeeProvider, private readonly retention?: SealedStoreRetention) {
    if (retention) {
      if (!Number.isFinite(retention.ttlSec) || retention.ttlSec <= 0) throw new Error("sealed store ttlSec must be positive");
      if (retention.retainedTtlSec !== undefined && (!Number.isFinite(retention.retainedTtlSec) || retention.retainedTtlSec <= 0)) throw new Error("sealed store retainedTtlSec must be positive");
      for (const cap of [retention.maxBytes, retention.maxUnretainedBytes, retention.maxRetainedBytes]) {
        if (cap !== undefined && (!Number.isSafeInteger(cap) || cap <= 0)) throw new Error("sealed store byte caps must be positive integers");
      }
      const interval = retention.sweepIntervalMs ?? 600_000;
      if (interval > 0) {
        this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, interval);
        this.timer.unref?.();
        void this.sweep().catch(() => {});
      }
    }
  }
  private name(key: string): string { return sha256(toHex(new TextEncoder().encode(key))); }
  private file(key: string): string { return join(this.dir, `${this.name(key)}.bin`); }
  private legacyFile(key: string): string { return join(this.dir, `${this.name(key)}.json`); }
  private marker(key: string): string { return join(this.dir, `${this.name(key)}.keep`); }
  private now(): number { return this.retention?.now?.() ?? Date.now(); }

  private encode(key: string, value: Uint8Array): Uint8Array {
    const envelope = seal(this.provider.encryptionPublicKey(), value, new TextEncoder().encode(key));
    return concat([MAGIC, fromHex(envelope.epk, "bytes"), fromHex(envelope.nonce, "bytes"), fromHex(envelope.ct, "bytes")]);
  }
  private decode(key: string, data: Uint8Array, legacy: boolean): Uint8Array {
    let envelope: Envelope;
    if (!legacy && isBinary(data)) {
      envelope = { v: 1, epk: toHex(data.subarray(MAGIC.length, MAGIC.length + 32)), nonce: toHex(data.subarray(MAGIC.length + 32, HEADER)), ct: toHex(data.subarray(HEADER)) };
    } else if (legacy) {
      try { envelope = JSON.parse(new TextDecoder().decode(data)) as Envelope; } catch { throw new Error("sealed store entry is corrupt"); }
    } else throw new Error("sealed store entry is corrupt");
    return this.provider.decryptEnvelope(envelope, new TextEncoder().encode(key));
  }
  private async read(key: string): Promise<Uint8Array | undefined> {
    for (const [path, legacy] of [[this.file(key), false], [this.legacyFile(key), true]] as const) {
      let data: Uint8Array;
      try { data = await readFile(path); } catch (error) { if (isMissing(error)) continue; throw error; }
      return this.decode(key, data, legacy);
    }
    return undefined;
  }
  /** The files holding `key` (normally one) with their disk use. */
  private async files(key: string): Promise<{ path: string; bytes: number }[]> {
    const found: { path: string; bytes: number }[] = [];
    for (const path of [this.file(key), this.legacyFile(key)]) {
      const info = await fileInfo(path);
      if (info) found.push({ path, bytes: diskBytes(info.size) });
    }
    return found;
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const value = await this.read(key);
    // Best effort: a failed marker write must not fail the caller's read.
    if (value !== undefined && this.retention?.retainOnRead) await this.retain(key).catch(() => {});
    return value;
  }

  /** The cap that `bytes` more in `pool` (of which `added` are new on disk) would exceed, if any. */
  private overflow(pool: "unretained" | "retained", bytes: number, added: number): SealedStoreFullError | undefined {
    const r = this.retention!;
    const unretained = this.unretainedBytes! + this.pendingBytes, retained = this.retainedBytes;
    if (pool === "unretained" && r.maxUnretainedBytes !== undefined && unretained + bytes > r.maxUnretainedBytes) return new SealedStoreFullError("unretained");
    if (pool === "retained" && r.maxRetainedBytes !== undefined && retained + bytes > r.maxRetainedBytes) return new SealedStoreFullError("retained");
    if (r.maxBytes !== undefined && added > 0 && unretained + retained + added > r.maxBytes) return new SealedStoreFullError("total");
    return undefined;
  }
  /**
   * Refuses `bytes` more in `pool` (`added` of them new on disk) past a cap, purging expired entries first, and
   * otherwise books them with `book` in the same synchronous step as the last check, so concurrent writers cannot all
   * pass the check before any of them is counted.
   */
  private async reserve(pool: "unretained" | "retained", bytes: number, added: number, book: () => void): Promise<void> {
    if (this.unretainedBytes === undefined) await this.sweep();
    if (this.overflow(pool, bytes, added)) {
      await this.sweep();
      const full = this.overflow(pool, bytes, added);
      if (full) throw full;
    }
    book();
  }
  private add(pool: "unretained" | "retained", bytes: number) {
    if (this.unretainedBytes === undefined) return;
    if (pool === "unretained") this.unretainedBytes = Math.max(0, this.unretainedBytes + bytes);
    else this.retainedBytes = Math.max(0, this.retainedBytes + bytes);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const data = this.encode(key, value);
    const path = this.file(key);
    if (!this.retention) {
      await writeFile(path, data, { mode: 0o600 });
      await unlink(this.legacyFile(key)).catch(() => {});
      return;
    }
    const previous = await this.files(key);
    const pool = previous.length && await fileInfo(this.marker(key)) ? "retained" : "unretained";
    const delta = diskBytes(data.byteLength) - previous.reduce((sum, file) => sum + file.bytes, 0);
    if (delta > 0) await this.reserve(pool, delta, delta, () => this.add(pool, delta));
    else this.add(pool, delta);
    try {
      await writeFile(path, data, { mode: 0o600 });
      if (previous.some((file) => file.path !== path)) await unlink(this.legacyFile(key)).catch(() => {});
    } catch (error) { this.add(pool, -delta); throw error; }
  }
  /**
   * Writes the sealed entry to a private staging file, flushes it, then hard-links it to the entry name and flushes the
   * directory, so the entry is durable before success is reported. link() fails with EEXIST when the entry exists, so
   * exactly one writer wins even across processes, and the entry only ever appears complete. Requires a filesystem with
   * hard links (ext4, xfs, tmpfs, overlayfs); other errors propagate.
   */
  async putIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    // Cheap early answer for the common case (also lets an existing entry be confirmed when the store is full). An
    // entry in the earlier JSON format counts: only earlier versions of this code wrote those, never a concurrent one.
    if ((await this.files(key)).length) return false;
    await mkdir(this.dir, { recursive: true });
    const data = this.encode(key, value);
    const bytes = diskBytes(data.byteLength);
    if (this.retention) await this.reserve("unretained", bytes, bytes, () => { this.pendingBytes += bytes; });
    const path = this.file(key);
    const staged = join(this.dir, `.${this.name(key)}.${randomBytes(8).toString("hex")}.tmp`);
    let wrote = false;
    try {
      const handle = await open(staged, "wx", 0o600);
      try {
        try { await handle.writeFile(data); await handle.sync(); }
        finally { await handle.close(); }
        try { await link(staged, path); wrote = true; }
        catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      } finally {
        await unlink(staged).catch(() => {});
      }
      if (wrote) await this.syncDirectory();
    } finally {
      if (this.retention) {
        this.pendingBytes -= bytes;
        if (wrote) this.add("unretained", bytes);
      }
    }
    return wrote;
  }
  /** fsync the store directory, persisting entry names created by link() (and the staging unlink). */
  protected async syncDirectory(): Promise<void> {
    const handle = await open(this.dir, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async has(key: string): Promise<boolean> { return (await this.read(key)) !== undefined; }
  /**
   * Marks the entry in use: it moves to the retained pool and lives `retainedTtlSec` from now. Retaining an entry that
   * is already retained restarts that lifetime. A missing entry is left missing (no marker is written for it). Throws
   * SealedStoreFullError when the retained pool is full; the entry then stays unretained.
   */
  async retain(key: string): Promise<void> {
    if (!this.retention) return;
    const files = await this.files(key);
    if (!files.length) return;
    const marker = this.marker(key);
    const at = new Date(this.now());
    if (await fileInfo(marker)) { await utimes(marker, at, at); return; }
    const entryBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const bytes = entryBytes + MARKER_BYTES;
    // The entry moves from the unretained pool to the retained one; only the marker is new on disk.
    await this.reserve("retained", bytes, MARKER_BYTES, () => { this.add("retained", bytes); this.add("unretained", -entryBytes); });
    try { await writeFile(marker, "", { mode: 0o600, flag: "wx" }); }
    catch (error) {
      this.add("retained", -bytes); this.add("unretained", entryBytes);
      if (!hasCode(error, "EEXIST")) throw error;
    }
    await utimes(marker, at, at);
  }
  async delete(key: string): Promise<void> {
    const kept = this.retention ? !!(await fileInfo(this.marker(key))) : false;
    let removed = 0;
    for (const file of await this.files(key)) {
      await unlink(file.path).catch((error) => { if (!isMissing(error)) throw error; });
      removed += file.bytes;
    }
    await unlink(this.marker(key)).catch((error) => { if (!isMissing(error)) throw error; });
    if (this.retention) { if (kept) this.add("retained", -(removed + MARKER_BYTES)); else this.add("unretained", -removed); }
  }
  /** Disk use by pool, as last counted (sweeping first if nothing has been counted yet). */
  async usage(): Promise<{ unretainedBytes: number; retainedBytes: number; pendingBytes: number }> {
    if (this.retention && this.unretainedBytes === undefined) await this.sweep();
    return { unretainedBytes: this.unretainedBytes ?? 0, retainedBytes: this.retainedBytes, pendingBytes: this.pendingBytes };
  }
  /** Deletes expired entries (by pool) and orphan markers; recomputes disk use. Returns the number of entries purged. */
  sweep(): Promise<number> {
    if (!this.retention) return Promise.resolve(0);
    this.sweeping ??= this.sweepOnce().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }
  private async sweepOnce(): Promise<number> {
    const ttlMs = this.retention!.ttlSec * 1000;
    const retainedTtlMs = this.retention!.retainedTtlSec === undefined ? Infinity : this.retention!.retainedTtlSec * 1000;
    let names: string[];
    try { names = await readdir(this.dir); } catch (error) { if (isMissing(error)) { this.unretainedBytes = 0; this.retainedBytes = 0; return 0; } throw error; }
    const present = new Set(names);
    const now = this.now();
    let purged = 0, unretained = 0, retained = 0;
    const markersCounted = new Set<string>();
    for (const name of names) {
      const path = join(this.dir, name);
      if (STAGED.test(name)) {
        const info = await fileInfo(path).catch(() => undefined);
        if (info && info.mtimeMs + ttlMs <= now) await unlink(path).catch(() => {});
        continue;
      }
      if (name.endsWith(".keep")) {
        const base = name.slice(0, -5);
        if (!present.has(`${base}.bin`) && !present.has(`${base}.json`)) await unlink(path).catch(() => {});
        continue;
      }
      if (!ENTRY.test(name)) continue;
      const info = await fileInfo(path).catch(() => undefined);
      if (!info) continue;
      const base = name.slice(0, name.lastIndexOf("."));
      const markerPath = join(this.dir, `${base}.keep`);
      // Read the marker (again) right before deciding, so a concurrent retain() that created or refreshed it wins.
      const marker = present.has(`${base}.keep`) || info.mtimeMs + ttlMs <= now ? await fileInfo(markerPath).catch(() => undefined) : undefined;
      const expired = marker ? marker.mtimeMs + retainedTtlMs <= now : info.mtimeMs + ttlMs <= now;
      if (expired) {
        await unlink(path).catch(() => {});
        if (marker) await unlink(markerPath).catch(() => {});
        purged++;
        continue;
      }
      if (!marker) { unretained += diskBytes(info.size); continue; }
      retained += diskBytes(info.size);
      if (!markersCounted.has(base)) { markersCounted.add(base); retained += MARKER_BYTES; }
    }
    this.unretainedBytes = unretained;
    this.retainedBytes = retained;
    return purged;
  }
  /** Stops the background sweeper (tests and shutdown). */
  close(): void { if (this.timer) clearInterval(this.timer); }
}
