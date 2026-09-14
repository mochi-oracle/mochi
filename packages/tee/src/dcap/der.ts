/** Small, bounds-checked DER reader used for Intel's X.509 objects. */
export interface Tlv { tag: number; start: number; contentStart: number; end: number; raw: Uint8Array; content: Uint8Array }
export function readTlv(data: Uint8Array, offset = 0): Tlv {
  if (offset >= data.length) throw new Error("DER truncated tag");
  const start = offset; const tag = data[offset++]!;
  if ((tag & 31) === 31) throw new Error("DER high tag unsupported");
  if (offset >= data.length) throw new Error("DER truncated length");
  let n = data[offset++]!; let len: number;
  if (n < 128) len = n;
  else { const count = n & 127; if (!count) throw new Error("DER indefinite length"); if (count > 4 || offset + count > data.length) throw new Error("DER invalid length"); if (data[offset] === 0) throw new Error("DER noncanonical length"); len = 0; for (let i = 0; i < count; i++) len = len * 256 + data[offset++]!; if (len < 128) throw new Error("DER noncanonical length"); }
  const contentStart = offset, end = offset + len; if (end > data.length) throw new Error("DER truncated value");
  return { tag, start, contentStart, end, raw: data.subarray(start, end), content: data.subarray(contentStart, end) };
}
export function children(t: Tlv): Tlv[] { const a: Tlv[] = []; let p = t.contentStart; while (p < t.end) { const x = readTlv(t.raw, p - t.start); a.push({ ...x, start: x.start + t.start, contentStart: x.contentStart + t.start, end: x.end + t.start, raw: t.raw.subarray(x.start, x.end), content: t.raw.subarray(x.contentStart, x.end) }); p = a[a.length - 1]!.end; } return a; }
export function expect(t: Tlv, tag: number): Tlv { if (t.tag !== tag) throw new Error(`DER expected tag ${tag}`); return t; }
export function integer(t: Tlv): bigint { expect(t, 2); if (!t.content.length) throw new Error("DER empty integer"); let n = 0n; for (const b of t.content) n = (n << 8n) | BigInt(b); if (t.content[0]! & 128) n -= 1n << BigInt(t.content.length * 8); return n; }
export function oid(t: Tlv): string { expect(t, 6); const a = [...t.content]; if (!a.length) throw new Error("DER empty OID"); const nums: bigint[] = []; let n = 0n; for (const b of a) { n = n * 128n + BigInt(b & 127); if (!(b & 128)) { nums.push(n); n = 0n; } } if (a[a.length - 1]! & 128) throw new Error("DER truncated OID"); const first = nums.shift()!; const x = first < 40n ? [0n, first] : first < 80n ? [1n, first - 40n] : [2n, first - 80n]; return [...x, ...nums].join("."); }
export function time(t: Tlv): number { const s = new TextDecoder().decode(t.content); let m: RegExpExecArray | null; let year: number, rest: string; if (t.tag === 23) { m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s); if (!m) throw new Error("DER invalid UTCTime"); year = Number(m[1]); year += year >= 50 ? 1900 : 2000; rest = `${year}${m[2]}${m[3]}${m[4]}${m[5]}${m[6] ?? "00"}`; } else if (t.tag === 24) { m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s); if (!m) throw new Error("DER invalid GeneralizedTime"); rest = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6] ?? "00"}`; } else throw new Error("DER expected time"); return Date.UTC(+rest.slice(0,4), +rest.slice(4,6)-1, +rest.slice(6,8), +rest.slice(8,10), +rest.slice(10,12), +rest.slice(12,14))/1000; }
export function hex(b: Uint8Array): string { return [...b].map(x => x.toString(16).padStart(2,"0")).join("").toUpperCase(); }
export function bitString(t: Tlv): Uint8Array { expect(t,3); if (!t.content.length || t.content[0] !== 0) throw new Error("DER unsupported BIT STRING"); return t.content.subarray(1); }
export function octetString(t:Tlv):Uint8Array { expect(t,4); return t.content; }
export function boolean(t:Tlv):boolean { expect(t,1); if(t.content.length!==1||(t.content[0]!==0&&t.content[0]!==255)) throw new Error("DER invalid BOOLEAN"); return t.content[0]===255; }
export function contextTag(t:Tlv,number:number):Tlv { if((t.tag&0xc0)!==0x80||(t.tag&0x1f)!==number) throw new Error("DER context tag mismatch"); return t; }
export function derChildren(data: Uint8Array): Tlv[] { const x=readTlv(data); if(x.end!==data.length) throw new Error("DER trailing garbage"); return children(x); }
