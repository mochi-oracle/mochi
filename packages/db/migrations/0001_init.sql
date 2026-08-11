CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS schemas (
  id smallint NOT NULL CHECK (id BETWEEN 1 AND 7),
  version integer NOT NULL CHECK (version > 0),
  json_hash text NOT NULL CHECK (json_hash ~ '^0x[0-9a-f]{64}$'),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^0x[0-9a-f]{64}$'),
  tolerances jsonb NOT NULL,
  crosschecks jsonb NOT NULL,
  active boolean NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS jurors (
  key text PRIMARY KEY CHECK (key ~ '^0x[0-9a-f]{40}$'),
  operator text NOT NULL CHECK (operator ~ '^0x[0-9a-f]{40}$'),
  measurement text NOT NULL CHECK (measurement ~ '^0x[0-9a-f]{64}$'),
  class smallint NOT NULL CHECK (class BETWEEN 0 AND 4),
  role smallint NOT NULL CHECK (role BETWEEN 0 AND 3),
  bond numeric(78,0) NOT NULL,
  attested_until timestamptz NOT NULL,
  uptime_30d integer NOT NULL,
  served integer NOT NULL,
  timeouts integer NOT NULL,
  slashed numeric(78,0) NOT NULL,
  delisted boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS queries (
  id text PRIMARY KEY CHECK (id ~ '^0x[0-9a-f]{64}$'),
  ts timestamptz NOT NULL,
  doc_commit text NOT NULL CHECK (doc_commit ~ '^0x[0-9a-f]{64}$'),
  schema_id smallint NOT NULL CHECK (schema_id BETWEEN 1 AND 7),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  n smallint NOT NULL CHECK (n IN (3,5,7,9)),
  round smallint NOT NULL CHECK (round BETWEEN 0 AND 255),
  is_public boolean NOT NULL,
  pay_path smallint NOT NULL CHECK (pay_path BETWEEN 0 AND 3),
  payer_commit text NOT NULL CHECK (payer_commit ~ '^0x[0-9a-f]{64}$'),
  params_hash text NOT NULL CHECK (params_hash ~ '^0x[0-9a-f]{64}$'),
  provenance_kind smallint NOT NULL CHECK (provenance_kind BETWEEN 0 AND 1),
  origin_id text NOT NULL CHECK (origin_id ~ '^0x[0-9a-f]{64}$'),
  tokens_k integer NOT NULL CHECK (tokens_k >= 0),
  status smallint NOT NULL CHECK (status BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS queries_status_idx ON queries(status);
CREATE INDEX IF NOT EXISTS queries_ts_idx ON queries(ts);
CREATE TABLE IF NOT EXISTS juror_answers (
  query_id text NOT NULL CHECK (query_id ~ '^0x[0-9a-f]{64}$'),
  round smallint NOT NULL CHECK (round BETWEEN 0 AND 255),
  seat smallint NOT NULL CHECK (seat BETWEEN 0 AND 8),
  juror text NOT NULL CHECK (juror ~ '^0x[0-9a-f]{40}$'),
  class smallint NOT NULL CHECK (class BETWEEN 0 AND 4),
  answer_hash text NOT NULL CHECK (answer_hash ~ '^0x[0-9a-f]{64}$'),
  spans_root text NOT NULL CHECK (spans_root ~ '^0x[0-9a-f]{64}$'),
  quote_hash text NOT NULL CHECK (quote_hash ~ '^0x[0-9a-f]{64}$'),
  sig bytea NOT NULL,
  timed_out boolean NOT NULL,
  ts timestamptz NOT NULL,
  PRIMARY KEY (query_id, round, seat)
);
CREATE INDEX IF NOT EXISTS juror_answers_juror_idx ON juror_answers(juror);
CREATE TABLE IF NOT EXISTS verdicts (
  id text NOT NULL CHECK (id ~ '^0x[0-9a-f]{64}$'),
  ts timestamptz NOT NULL,
  query_id text NOT NULL CHECK (query_id ~ '^0x[0-9a-f]{64}$'),
  round smallint NOT NULL CHECK (round BETWEEN 0 AND 255),
  status smallint NOT NULL CHECK (status BETWEEN 0 AND 2),
  agreement_bps integer NOT NULL CHECK (agreement_bps BETWEEN 0 AND 10000),
  dissent_mask bigint NOT NULL CHECK (dissent_mask >= 0),
  timeout_mask bigint NOT NULL CHECK (timeout_mask >= 0),
  evidence_root text NOT NULL CHECK (evidence_root ~ '^0x[0-9a-f]{64}$'),
  attestation_root text NOT NULL CHECK (attestation_root ~ '^0x[0-9a-f]{64}$'),
  answer_hash text NOT NULL CHECK (answer_hash ~ '^0x[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
  is_public boolean NOT NULL,
  escalated boolean NOT NULL,
  tx text NOT NULL CHECK (tx ~ '^0x[0-9a-f]{64}$'),
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('verdicts', by_range('ts'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS verdicts_query_id_idx ON verdicts(query_id);
CREATE TABLE IF NOT EXISTS verdict_public (
  verdict_id text PRIMARY KEY CHECK (verdict_id ~ '^0x[0-9a-f]{64}$'),
  answer jsonb NOT NULL,
  payload bytea NOT NULL,
  dissent jsonb NOT NULL,
  field_agreement jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS private_results (
  verdict_id text PRIMARY KEY CHECK (verdict_id ~ '^0x[0-9a-f]{64}$'),
  ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS private_results_expires_at_idx ON private_results(expires_at);
CREATE TABLE IF NOT EXISTS feeds (
  feed_id text NOT NULL,
  key text NOT NULL,
  verdict_id text NOT NULL CHECK (verdict_id ~ '^0x[0-9a-f]{64}$'),
  as_of timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (feed_id, key)
);
CREATE INDEX IF NOT EXISTS feeds_updated_at_idx ON feeds(updated_at);
CREATE TABLE IF NOT EXISTS disagreement (
  bucket timestamptz NOT NULL,
  "window" interval NOT NULL,
  schema_id smallint NOT NULL CHECK (schema_id BETWEEN 1 AND 7),
  field text NOT NULL,
  class smallint NOT NULL CHECK (class BETWEEN 0 AND 4),
  disagree_rate numeric NOT NULL CHECK (disagree_rate >= 0 AND disagree_rate <= 1),
  samples integer NOT NULL CHECK (samples >= 0),
  disagree_count integer NOT NULL CHECK (disagree_count >= 0),
  PRIMARY KEY (schema_id, field, class, "window", bucket)
);
SELECT create_hypertable('disagreement', by_range('bucket'), if_not_exists => TRUE);
CREATE TABLE IF NOT EXISTS crosschecks (
  feed_id text NOT NULL,
  key text NOT NULL,
  verdict_id text NOT NULL CHECK (verdict_id ~ '^0x[0-9a-f]{64}$'),
  ok boolean NOT NULL,
  detail jsonb NOT NULL,
  ts timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS crosschecks_verdict_id_idx ON crosschecks(verdict_id);
CREATE TABLE IF NOT EXISTS escalations (
  query_id text NOT NULL CHECK (query_id ~ '^0x[0-9a-f]{64}$'),
  round smallint NOT NULL CHECK (round BETWEEN 0 AND 255),
  panel text[] NOT NULL,
  outcome jsonb NOT NULL,
  appealed boolean NOT NULL,
  ts timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS anonyma_vouchers (
  voucher_id text PRIMARY KEY CHECK (voucher_id ~ '^0x[0-9a-f]{64}$'),
  query_id text NOT NULL CHECK (query_id ~ '^0x[0-9a-f]{64}$'),
  tier smallint NOT NULL CHECK (tier >= 0),
  usdg_amount numeric(78,0) NOT NULL,
  settled boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  verdict_id text PRIMARY KEY CHECK (verdict_id ~ '^0x[0-9a-f]{64}$'),
  key_id text NOT NULL,
  sig bytea NOT NULL,
  payload jsonb NOT NULL,
  anchor_root text NOT NULL CHECK (anchor_root ~ '^0x[0-9a-f]{64}$'),
  anchor_index integer NOT NULL CHECK (anchor_index >= 0)
);
CREATE TABLE IF NOT EXISTS anchors (
  root text PRIMARY KEY CHECK (root ~ '^0x[0-9a-f]{64}$'),
  ts timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  tx text NOT NULL CHECK (tx ~ '^0x[0-9a-f]{64}$')
);
