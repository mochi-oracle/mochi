import { boolean, bigint, customType, index, integer, interval, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

export const schemas = pgTable("schemas", {
  id: smallint("id").notNull(), version: integer("version").notNull(), jsonHash: text("json_hash").notNull(), promptHash: text("prompt_hash").notNull(), tolerances: jsonb("tolerances").notNull(), crosschecks: jsonb("crosschecks").notNull(), active: boolean("active").notNull(),
}, (t) => [primaryKey({ columns: [t.id, t.version] })]);
export const jurors = pgTable("jurors", {
  key: text("key").primaryKey(), operator: text("operator").notNull(), measurement: text("measurement").notNull(), class: smallint("class").notNull(), role: smallint("role").notNull(), bond: numeric("bond", { precision: 78, scale: 0 }).notNull(), attestedUntil: timestamp("attested_until", { withTimezone: true, mode: "date" }).notNull(), uptime30d: integer("uptime_30d").notNull(), served: integer("served").notNull(), timeouts: integer("timeouts").notNull(), slashed: numeric("slashed", { precision: 78, scale: 0 }).notNull(), delisted: boolean("delisted").notNull(),
  passport: jsonb("passport"), passportSig: text("passport_sig")
});
export const queries = pgTable("queries", {
  id: text("id").primaryKey(), ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull(), docCommit: text("doc_commit").notNull(), schemaId: smallint("schema_id").notNull(), schemaVersion: integer("schema_version").notNull(), n: smallint("n").notNull(), round: smallint("round").notNull(), isPublic: boolean("is_public").notNull(), payPath: smallint("pay_path").notNull(), payerCommit: text("payer_commit").notNull(), paramsHash: text("params_hash").notNull(), provenanceKind: smallint("provenance_kind").notNull(), originId: text("origin_id").notNull(), tokensK: integer("tokens_k").notNull(), status: smallint("status").notNull(),
  payer: text("payer")
}, (t) => [index("queries_status_idx").on(t.status), index("queries_ts_idx").on(t.ts)]);
export const jurorAnswers = pgTable("juror_answers", {
  queryId: text("query_id").notNull(), round: smallint("round").notNull(), seat: smallint("seat").notNull(), juror: text("juror").notNull(), class: smallint("class").notNull(), answerHash: text("answer_hash").notNull(), spansRoot: text("spans_root").notNull(), quoteHash: text("quote_hash").notNull(), sig: bytea("sig").notNull(), timedOut: boolean("timed_out").notNull(), ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [primaryKey({ columns: [t.queryId, t.round, t.seat] }), index("juror_answers_juror_idx").on(t.juror)]);
export const verdicts = pgTable("verdicts", {
  id: text("id").notNull(), ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull(), queryId: text("query_id").notNull(), round: smallint("round").notNull(), status: smallint("status").notNull(), agreementBps: integer("agreement_bps").notNull(), dissentMask: bigint("dissent_mask", { mode: "bigint" }).notNull(), timeoutMask: bigint("timeout_mask", { mode: "bigint" }).notNull(), evidenceRoot: text("evidence_root").notNull(), attestationRoot: text("attestation_root").notNull(), answerHash: text("answer_hash").notNull(), payloadHash: text("payload_hash").notNull(), isPublic: boolean("is_public").notNull(), escalated: boolean("escalated").notNull(), tx: text("tx").notNull(),
}, (t) => [primaryKey({ columns: [t.id, t.ts] }), index("verdicts_query_id_idx").on(t.queryId)]);
export const verdictPublic = pgTable("verdict_public", {
  verdictId: text("verdict_id").primaryKey(), answer: jsonb("answer").notNull(), payload: bytea("payload").notNull(), dissent: jsonb("dissent").notNull(), fieldAgreement: jsonb("field_agreement").notNull(),
});
export const privateResults = pgTable("private_results", { verdictId: text("verdict_id").primaryKey(), ciphertext: bytea("ciphertext").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull() }, (t) => [index("private_results_expires_at_idx").on(t.expiresAt)]);
export const feeds = pgTable("feeds", { feedId: text("feed_id").notNull(), key: text("key").notNull(), verdictId: text("verdict_id").notNull(), asOf: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull() }, (t) => [primaryKey({ columns: [t.feedId, t.key] }), index("feeds_updated_at_idx").on(t.updatedAt)]);
export const disagreement = pgTable("disagreement", { bucket: timestamp("bucket", { withTimezone: true, mode: "date" }).notNull(), window: interval("window").notNull(), schemaId: smallint("schema_id").notNull(), field: text("field").notNull(), class: smallint("class").notNull(), disagreeRate: numeric("disagree_rate").notNull(), samples: integer("samples").notNull(), disagreeCount: integer("disagree_count").notNull() }, (t) => [primaryKey({ columns: [t.schemaId, t.field, t.class, t.window, t.bucket] })]);
export const crosschecks = pgTable("crosschecks", { feedId: text("feed_id").notNull(), key: text("key").notNull(), verdictId: text("verdict_id").notNull(), ok: boolean("ok").notNull(), detail: jsonb("detail").notNull(), ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull() }, (t) => [index("crosschecks_verdict_id_idx").on(t.verdictId)]);
export const escalations = pgTable("escalations", { queryId: text("query_id").notNull(), round: smallint("round").notNull(), panel: text("panel").array().notNull(), outcome: jsonb("outcome").notNull(), appealed: boolean("appealed").notNull(), ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull() });
export const anonymaVouchers = pgTable("anonyma_vouchers", { voucherId: text("voucher_id").primaryKey(), queryId: text("query_id").notNull(), tier: smallint("tier").notNull(), usdgAmount: numeric("usdg_amount", { precision: 78, scale: 0 }).notNull(), settled: boolean("settled").notNull() });
export const receipts = pgTable("receipts", { verdictId: text("verdict_id").primaryKey(), keyId: text("key_id").notNull(), sig: bytea("sig").notNull(), payload: jsonb("payload").notNull(), anchorRoot: text("anchor_root"), anchorIndex: integer("anchor_index") }); // NULL until anchored
export const anchors = pgTable("anchors", { root: text("root").primaryKey(), ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull(), count: integer("count").notNull(), tx: text("tx").notNull() });

export type SchemaRow = typeof schemas.$inferSelect;
export type JurorRow = typeof jurors.$inferSelect;
export type QueryRow = typeof queries.$inferSelect;
export type JurorAnswerRow = typeof jurorAnswers.$inferSelect;
export type VerdictRow = typeof verdicts.$inferSelect;
export type VerdictPublicRow = typeof verdictPublic.$inferSelect;
export type PrivateResultRow = typeof privateResults.$inferSelect;
export type FeedRow = typeof feeds.$inferSelect;
export type DisagreementRow = typeof disagreement.$inferSelect;
export type CrosscheckRow = typeof crosschecks.$inferSelect;
export type EscalationRow = typeof escalations.$inferSelect;
export type AnonymaVoucherRow = typeof anonymaVouchers.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type AnchorRow = typeof anchors.$inferSelect;

// ── wave-2 service tables (migrations/0002_services.sql) ──
export const endpoints = pgTable("endpoints", {
  address: text("address").primaryKey(),
  role: smallint("role").notNull(),
  url: text("url").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export const feedQueries = pgTable("feed_queries", {
  queryId: text("query_id").primaryKey(),
  feedId: text("feed_id").notNull(),
  key: text("key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export const queryMeta = pgTable("query_meta", {
  queryId: text("query_id").primaryKey(),
  payerResultPub: text("payer_result_pub"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
/** Payer result keys by on-chain commitment (migration 0005): cannot be overwritten for someone else's query. */
export const payerResultKeys = pgTable("payer_result_keys", {
  payerCommit: text("payer_commit").primaryKey(),
  pub: text("pub").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export const chainCursors = pgTable("chain_cursors", {
  name: text("name").primaryKey(),
  block: numeric("block", { precision: 78, scale: 0 }).notNull(),
});
export type EndpointRow = typeof endpoints.$inferSelect;
export type FeedQueryRow = typeof feedQueries.$inferSelect;

// ── wave 3 (migrations/0004_doc_completion.sql) ──
export const disagreementModel = pgTable("disagreement_model", {
  bucket: timestamp("bucket", { withTimezone: true, mode: "date" }).notNull(),
  window: interval("window").notNull(),
  schemaId: smallint("schema_id").notNull(),
  field: text("field").notNull(),
  modelId: text("model_id").notNull(),
  disagreeRate: numeric("disagree_rate").notNull(),
  samples: integer("samples").notNull(),
  disagreeCount: integer("disagree_count").notNull(),
}, (t) => [primaryKey({ columns: [t.schemaId, t.field, t.modelId, t.window, t.bucket] })]);
export const disclosures = pgTable("disclosures", {
  verdictId: text("verdict_id").notNull(),
  recipientKeyHash: text("recipient_key_hash").notNull(),
  envelope: bytea("envelope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.verdictId, t.recipientKeyHash] })]);
export const feedSubscriptions = pgTable("feed_subscriptions", {
  feedId: text("feed_id").notNull(),
  consumer: text("consumer").notNull(),
  until: timestamp("until", { withTimezone: true, mode: "date" }).notNull(),
  paid: numeric("paid", { precision: 78, scale: 0 }).notNull(),
}, (t) => [primaryKey({ columns: [t.feedId, t.consumer] })]);
export const panelPayloads = pgTable("panel_payloads", {
  caseId: text("case_id").notNull(),
  panelIndex: smallint("panel_index").notNull(),
  evaluator: text("evaluator").notNull(),
  payloadHash: text("payload_hash").notNull(),
  payload: bytea("payload").notNull(),
  answerJson: text("answer_json"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.caseId, t.panelIndex, t.evaluator] })]);
