-- Payer result-encryption keys, indexed by their on-chain commitment payerCommit = keccak256("mochi/payer/v1" ‖ key).
-- Keyed by commitment rather than queryId: writing a row under a commitment requires a key that hashes to it, so nobody
-- can overwrite (and thereby block) the key of someone else's private query. First write wins.
CREATE TABLE IF NOT EXISTS payer_result_keys (
  payer_commit text PRIMARY KEY CHECK (payer_commit ~ '^0x[0-9a-f]{64}$'),
  pub text NOT NULL CHECK (pub ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
