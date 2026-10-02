/**
 * Per-visitor identity that the website vouches for on its requests to the CVM, so the CVM can apply per-client limits
 * to each website visitor instead of to the website's one egress address.
 *
 *   X-Mochi-Visitor: v1.<visitor>.<unix seconds>.<mac>
 *
 * `visitor` is a pseudonym of the visitor's address prefix (the CVM never learns the address) and `mac` authenticates
 * the visitor and the time. Both are HMAC-SHA256 outputs under a key derived from MOCHI_CLAIMS_ACCESS_TOKEN, which the
 * website (Railway) and the CVM already hold; the token itself never leaves either server. A header is accepted for
 * MAX_AGE_SEC either side of the receiver's clock, and anyone who holds the token can mint one, so per-client limits
 * keyed on it are a fairness measure: the CVM's global limits remain the actual bound.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const VISITOR_HEADER = 'x-mochi-visitor';
export const VISITOR_MAX_AGE_SEC = 120;
const MIN_SECRET_LENGTH = 24;
const LABEL = 'mochi/visitor-key/v1';
const FORMAT = /^v1\.([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export type VisitorCheck = { status: 'valid'; visitor: string } | { status: 'absent' | 'invalid' | 'expired' };
export type VisitorKey = {
  /** Short public fingerprint of the derived key: equal on both servers exactly when they hold the same token. */
  readonly id: string;
  /** Header value for one visitor, identified by the website's own per-visitor key (an address prefix). */
  sign(client: string, nowSec: number): string;
  verify(header: string | null | undefined, nowSec: number): VisitorCheck;
};

/** Undefined when the secret is absent or shorter than the invitation-token minimum (signing and checking are off). */
export function visitorKey(secret: string | undefined): VisitorKey | undefined {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  const key = createHmac('sha256', secret).update(LABEL).digest();
  const mac = (data: string) => createHmac('sha256', key).update(data).digest();
  return {
    id: mac('key-id').toString('hex').slice(0, 8),
    sign(client, nowSec) {
      const visitor = mac(`visitor\n${client}`).toString('base64url').slice(0, 22);
      const ts = Math.floor(nowSec);
      return `v1.${visitor}.${ts}.${mac(`v1.${visitor}.${ts}`).toString('base64url')}`;
    },
    verify(header, nowSec) {
      if (!header) return { status: 'absent' };
      const match = FORMAT.exec(header);
      if (!match) return { status: 'invalid' };
      const [, visitor, ts, tag] = match as unknown as [string, string, string, string];
      const expected = mac(`v1.${visitor}.${ts}`);
      const given = Buffer.from(tag, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 'invalid' };
      if (Math.abs(nowSec - Number(ts)) > VISITOR_MAX_AGE_SEC) return { status: 'expired' };
      return { status: 'valid', visitor };
    },
  };
}
