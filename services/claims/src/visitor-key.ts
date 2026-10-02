/**
 * Per-visitor identity that the website vouches for on its requests to the CVM, so the CVM can apply per-client limits
 * to each website visitor instead of to the website's one egress address.
 *
 *   X-Mochi-Visitor: v1.<visitor>.<unix seconds>.<mac>
 *
 * `mac` authenticates the visitor and the time under a key derived from the visitor secret (see visitorSecretFromEnv),
 * which the website (Railway) and the CVM both hold; the secret itself never leaves either server. `visitor` is a
 * pseudonym of the visitor's address prefix under a random key that each website process draws at start and never
 * sends. Were it derived from the shared secret instead, anyone holding that secret (the CVM included) could recover an
 * IPv4 address by trying all 2^32 of them; as it is, the CVM sees an opaque pseudonym. Pseudonyms change when the
 * website restarts, which only resets the CVM's per-visitor buckets. A header is accepted for VISITOR_MAX_AGE_SEC
 * either side of the receiver's clock, and anyone who holds the secret can mint one, so per-client limits keyed on it
 * are a fairness measure: the CVM's global limits remain the actual bound.
 *
 * Nothing derived from the secret is published, since any public function of it lets anyone test guesses offline.
 * To confirm that the website and the CVM hold the same secret, the operator sends each a fresh X-Mochi-Key-Check
 * proof (keyCheckHeader: a MAC of a random nonce under the derived key; scripts/visitor-key-check.ts does this), and
 * each answers only "match" or "mismatch". A caller without the secret learns that one guess was wrong, as with any
 * invitation-token check, and no response carries anything to guess against offline.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const VISITOR_HEADER = 'x-mochi-visitor';
export const KEY_CHECK_HEADER = 'x-mochi-key-check';
export const VISITOR_MAX_AGE_SEC = 120;
const MIN_SECRET_LENGTH = 24;
const LABEL = 'mochi/visitor-key/v1';
const FORMAT = /^v1\.([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const CHECK_FORMAT = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

/**
 * The visitor secret. Today it is the invitation token MOCHI_CLAIMS_ACCESS_TOKEN, which both servers already hold; this
 * is the one place that names its source, so giving visitor keys their own secret later changes only this function
 * (and the matching variable on Railway and in the CVM's environment).
 */
export function visitorSecretFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.MOCHI_CLAIMS_ACCESS_TOKEN;
}

export type VisitorCheck = { status: 'valid'; visitor: string } | { status: 'absent' | 'invalid' | 'expired' };
/** Result of checking an X-Mochi-Key-Check proof: "match" exactly when its sender holds the same secret. */
export type KeyCheck = 'absent' | 'invalid' | 'match' | 'mismatch';
export type VisitorKey = {
  /** Header value for one visitor, identified by the website's own per-visitor key (an address prefix). */
  sign(client: string, nowSec: number): string;
  verify(header: string | null | undefined, nowSec: number): VisitorCheck;
  checkKey(header: string | null | undefined): KeyCheck;
};

const derive = (secret: string) => createHmac('sha256', secret).update(LABEL).digest();
const keyCheckMac = (key: Buffer, nonce: string) => createHmac('sha256', key).update(`key-check\n${nonce}`).digest();
const usable = (secret: string | undefined): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
const sameMac = (given: string, expected: Buffer) => {
  const bytes = Buffer.from(given, 'base64url');
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};

/** Undefined when the secret is absent or shorter than the invitation-token minimum (signing and checking are off). */
export function visitorKey(secret: string | undefined): VisitorKey | undefined {
  if (!usable(secret)) return undefined;
  const key = derive(secret);
  const mac = (data: string) => createHmac('sha256', key).update(data).digest();
  const pseudonymKey = randomBytes(32);
  return {
    sign(client, nowSec) {
      const visitor = createHmac('sha256', pseudonymKey).update(`visitor\n${client}`).digest('base64url').slice(0, 22);
      const ts = Math.floor(nowSec);
      return `v1.${visitor}.${ts}.${mac(`v1.${visitor}.${ts}`).toString('base64url')}`;
    },
    verify(header, nowSec) {
      if (!header) return { status: 'absent' };
      const match = FORMAT.exec(header);
      if (!match) return { status: 'invalid' };
      const [, visitor, ts, tag] = match as unknown as [string, string, string, string];
      if (!sameMac(tag, mac(`v1.${visitor}.${ts}`))) return { status: 'invalid' };
      if (Math.abs(nowSec - Number(ts)) > VISITOR_MAX_AGE_SEC) return { status: 'expired' };
      return { status: 'valid', visitor };
    },
    checkKey(header) {
      if (!header) return 'absent';
      const match = CHECK_FORMAT.exec(header);
      if (!match) return 'invalid';
      return sameMac(match[2]!, keyCheckMac(key, match[1]!)) ? 'match' : 'mismatch';
    },
  };
}

/**
 * Operator side of the key check: a fresh X-Mochi-Key-Check value proving knowledge of `secret` without revealing it.
 * Send a new one for each check; the servers answer only "match" or "mismatch".
 */
export function keyCheckHeader(secret: string, nonce: string = randomBytes(32).toString('base64url')): string {
  if (!usable(secret)) throw new Error('The visitor secret is missing or shorter than 24 characters.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('The key-check nonce must be 32 bytes in base64url.');
  return `v1.${nonce}.${keyCheckMac(derive(secret), nonce).toString('base64url')}`;
}
