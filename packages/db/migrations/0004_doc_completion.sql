-- Wave 3 (Claude): model Passports, payer address for kill-criteria metrics, per-model disagreement index,
-- view-key disclosures, feed subscriptions, human-panel payloads. Privacy: still no plaintext documents/answers.

ALTER TABLE jurors ADD COLUMN IF NOT EXISTS passport jsonb;
ALTER TABLE jurors ADD COLUMN IF NOT EXISTS passport_sig text;
ALTER TABLE queries ADD COLUMN IF NOT EXISTS payer text CHECK (payer IS NULL OR payer ~ '^0x[0-9a-f]{40}$');

CREATE TABLE IF NOT EXISTS disagreement_model (
  bucket timestamptz NOT NULL,
  "window" interval NOT NULL,
  schema_id smallint NOT NULL CHECK (schema_id > 0),
  field text NOT NULL,
  model_id text NOT NULL,
  disagree_rate numeric NOT NULL CHECK (disagree_rate >= 0 AND disagree_rate <= 1),
  samples integer NOT NULL CHECK (samples >= 0),
  disagree_count integer NOT NULL CHECK (disagree_count >= 0),
  PRIMARY KEY (schema_id, field, model_id, "window", bucket)
);
SELECT create_hypertable('disagreement_model', by_range('bucket'), if_not_exists => TRUE);

-- Envelopes are sealed to the recipient (auditor); the server cannot read them.
CREATE TABLE IF NOT EXISTS disclosures (
  verdict_id text NOT NULL CHECK (verdict_id ~ '^0x[0-9a-f]{64}$'),
  recipient_key_hash text NOT NULL CHECK (recipient_key_hash ~ '^0x[0-9a-f]{64}$'),
  envelope bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (verdict_id, recipient_key_hash)
);

CREATE TABLE IF NOT EXISTS feed_subscriptions (
  feed_id text NOT NULL CHECK (feed_id ~ '^0x[0-9a-f]{64}$'),
  consumer text NOT NULL CHECK (consumer ~ '^0x[0-9a-f]{40}$'),
  until timestamptz NOT NULL,
  paid numeric(78,0) NOT NULL,
  PRIMARY KEY (feed_id, consumer)
);

-- Payload bytes submitted by panel evaluators; only the one matching the majority payloadHash is ever relayed.
CREATE TABLE IF NOT EXISTS panel_payloads (
  case_id text NOT NULL CHECK (case_id ~ '^0x[0-9a-f]{64}$'),
  panel_index smallint NOT NULL CHECK (panel_index IN (0, 1)),
  evaluator text NOT NULL CHECK (evaluator ~ '^0x[0-9a-f]{40}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
  payload bytea NOT NULL,
  answer_json text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, panel_index, evaluator)
);
