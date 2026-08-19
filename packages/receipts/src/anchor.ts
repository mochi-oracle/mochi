import { concat, keccak256, type Hex } from "viem";
import { canonicalBytes, merkleRoot, ZERO32 } from "@mochi/core";

export function receiptLeaf(receipt: unknown): Hex {
  return keccak256(canonicalBytes(receipt));
}

function parent(a: Hex, b: Hex): Hex {
  return a < b ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** Generate a proof for a leaf using sorted initial leaves and promoted odd nodes. */
export function merkleProof(leaves: readonly Hex[], leaf: Hex): Hex[] {
  let level = [...leaves].sort();
  let index = level.indexOf(leaf);
  if (index < 0) throw new TypeError("Leaf is not in the tree");
  const proof: Hex[] = [];
  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (siblingIndex < level.length) proof.push(level[siblingIndex]!);
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : parent(left, right));
    }
    index = Math.floor(index / 2);
    level = next;
  }
  return proof;
}

/** Verify OpenZeppelin-compatible sorted-pair proof; omitted siblings represent promoted odd nodes. */
export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  try {
    let hash = leaf;
    for (const sibling of proof) hash = parent(hash, sibling);
    return hash.toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}

export function buildAnchorBatch(receipts: readonly unknown[]): { root: Hex; leaves: Hex[]; proofs: Map<Hex, Hex[]> } {
  const leaves = receipts.map(receiptLeaf);
  const root = merkleRoot(leaves);
  const proofs = new Map<Hex, Hex[]>();
  for (const leaf of leaves) if (!proofs.has(leaf)) proofs.set(leaf, merkleProof(leaves, leaf));
  return { root, leaves, proofs };
}

export interface AnchorFlushResult { root: Hex; count: number; txHash: Hex; proofs: Map<Hex, Hex[]> }

export class AnchorWindow {
  private leaves: Hex[] = [];
  private lastFlushAt: number;
  readonly intervalMs: number;
  readonly maxLeaves: number;

  constructor(options: { intervalMs?: number; maxLeaves?: number; now?: number } = {}) {
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
    this.maxLeaves = options.maxLeaves ?? 1000;
    this.lastFlushAt = options.now ?? Date.now();
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) throw new TypeError("intervalMs must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxLeaves) || this.maxLeaves <= 0) throw new TypeError("maxLeaves must be a positive safe integer");
  }

  add(receipt: unknown): Hex {
    const leaf = receiptLeaf(receipt);
    this.leaves.push(leaf);
    return leaf;
  }

  addLeaf(leaf: Hex): void { this.leaves.push(leaf); }

  get count(): number { return this.leaves.length; }

  shouldFlush(now = Date.now()): boolean {
    return this.leaves.length >= this.maxLeaves || (this.leaves.length > 0 && now - this.lastFlushAt >= this.intervalMs);
  }

  async flush(post: (root: Hex, count: number) => Promise<Hex>): Promise<AnchorFlushResult> {
    const leaves = [...this.leaves];
    const root = merkleRoot(leaves);
    const count = leaves.length;
    const proofs = new Map<Hex, Hex[]>();
    for (const leaf of leaves) if (!proofs.has(leaf)) proofs.set(leaf, merkleProof(leaves, leaf));
    const txHash = await post(root, count);
    this.leaves = [];
    this.lastFlushAt = Date.now();
    return { root: count === 0 ? ZERO32 : root, count, txHash, proofs };
  }
}
