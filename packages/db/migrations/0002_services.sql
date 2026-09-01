-- Wave-2 service tables (Claude). Privacy: no plaintext documents, params, salts or answers.

-- Future schema ids are allowed by SchemaRegistry; drop the v1-only upper bound.
ALTER TABLE schemas DROP CONSTRAINT IF EXISTS schemas_id_check;
ALTER TABLE schemas ADD CONSTRAINT schemas_id_check CHECK (id > 0);
ALTER TABLE queries DROP CONSTRAINT IF EXISTS queries_schema_id_check;
ALTER TABLE queries ADD CONSTRAINT queries_schema_id_check CHECK (schema_id > 0);
ALTER TABLE disagreement DROP CONSTRAINT IF EXISTS disagreement_schema_id_check;
ALTER TABLE disagreement ADD CONSTRAINT disagreement_schema_id_check CHECK (schema_id > 0);

-- Enclave endpoint directory: signing address → base URL (EndpointDirectory in @mochi/protocol).
CREATE TABLE IF NOT EXISTS endpoints (
  address text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  role smallint NOT NULL CHECK (role BETWEEN 1 AND 3),
  url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Standing feed queries opened by feed-runners; the orchestrator calls Feeds.update after a VERDICT.
CREATE TABLE IF NOT EXISTS feed_queries (
  query_id text PRIMARY KEY CHECK (query_id ~ '^0x[0-9a-f]{64}$'),
  feed_id text NOT NULL CHECK (feed_id ~ '^0x[0-9a-f]{64}$'),
  key text NOT NULL CHECK (key ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Private queries: the payer's per-query x25519 result key. Safe to store: the consensus enclave only uses it if
-- payerCommit(key) equals the on-chain Query.payerCommit.
CREATE TABLE IF NOT EXISTS query_meta (
  query_id text PRIMARY KEY CHECK (query_id ~ '^0x[0-9a-f]{64}$'),
  payer_result_pub text CHECK (payer_result_pub IS NULL OR payer_result_pub ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Log-indexing cursors.
CREATE TABLE IF NOT EXISTS chain_cursors (
  name text PRIMARY KEY,
  block numeric(78,0) NOT NULL
);
