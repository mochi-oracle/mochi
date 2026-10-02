-- Disclosure envelopes are kept per envelope, keyed by envelope_hash = keccak256 of the envelope's canonical JSON (the
-- bytes stored in `envelope`, and the value the SDK records on-chain in DisclosureRegistry). The old key, one row per
-- (verdict, recipient) with the first post winning, let anyone squat a recipient's slot with junk before the payer
-- posted. Envelopes are sealed to the recipient and checked by it against the verdict's on-chain commitments, so every
-- distinct envelope is kept and served; the gateway bounds writes per caller and globally instead of per recipient.
-- Rows stored before this migration hold non-canonical JSON, so they get a sha256 placeholder hash.
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS envelope_hash text;
UPDATE disclosures SET envelope_hash = '0x' || encode(sha256(envelope), 'hex') WHERE envelope_hash IS NULL;
ALTER TABLE disclosures ALTER COLUMN envelope_hash SET NOT NULL;
ALTER TABLE disclosures ADD CONSTRAINT disclosures_envelope_hash_check CHECK (envelope_hash ~ '^0x[0-9a-f]{64}$');
ALTER TABLE disclosures DROP CONSTRAINT disclosures_pkey;
ALTER TABLE disclosures ADD PRIMARY KEY (verdict_id, recipient_key_hash, envelope_hash);
CREATE INDEX IF NOT EXISTS disclosures_recipient_created_idx ON disclosures (verdict_id, recipient_key_hash, created_at);
