import { createHmac, timingSafeEqual } from "node:crypto";

export function signAnonyma(secret: string, timestamp: string, body: string): string {
  return `0x${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyAnonyma(secret: string, timestamp: string, body: string, signature: string, nowSeconds: number): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(signAnonyma(secret, timestamp, body).slice(2), "hex");
  const supplied = Buffer.from(signature.replace(/^0x/, ""), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
