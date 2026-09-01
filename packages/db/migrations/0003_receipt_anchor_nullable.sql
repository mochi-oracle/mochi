-- A receipt is issued as soon as a verdict is posted and anchored later (hourly batch), so the anchor columns are
-- NULL until then. (The CHECK constraints pass for NULL.)
ALTER TABLE receipts ALTER COLUMN anchor_root DROP NOT NULL;
ALTER TABLE receipts ALTER COLUMN anchor_index DROP NOT NULL;
