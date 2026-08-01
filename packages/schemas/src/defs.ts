import { SchemaId, type FieldSpec, type ParamSpec, type SchemaDef } from "@mochi/core";

const exactTolerance = { kind: "exact" as const };

/** Creates a field with exact tolerance unless a schema overrides it. */
function field(
  name: string,
  kind: FieldSpec["kind"],
  required: boolean,
  description: string,
  extra: Partial<FieldSpec> = {},
): FieldSpec {
  return { name, kind, required, tolerance: exactTolerance, description, ...extra };
}

/** Creates a requester parameter specification. */
function parameter(
  name: string,
  kind: ParamSpec["kind"],
  required: boolean,
  description: string,
  extra: Partial<ParamSpec> = {},
): ParamSpec {
  return { name, kind, required, description, ...extra };
}

/** Creates a relative tolerance measured in basis points. */
const relativeTolerance = (bps: number) => ({ kind: "rel" as const, bps });

/** The seven version-one extraction schema definitions. */
const SCHEMA_DEFINITIONS: Record<SchemaId, SchemaDef> = {
  [SchemaId.EX_DIVIDEND]: {
    id: SchemaId.EX_DIVIDEND,
    name: "EX_DIVIDEND",
    version: 1,
    fields: [
      field("ticker", "str", true, "The stock ticker for the issuer.", { strMode: "ticker" }),
      field("issuer", "str", false, "The issuer name as printed.", { strMode: "name" }),
      field("ex_date", "date", true, "The ex-dividend date as printed."),
      field("record_date", "date", false, "The dividend record date as printed."),
      field("pay_date", "date", false, "The dividend payment date as printed."),
      field("amount_per_share", "num", true, "The dividend amount per share as printed."),
      field("currency", "str", true, "The currency of the dividend amount.", { strMode: "currency" }),
      field("dividend_type", "enum", true, "The stated dividend type.", {
        enumValues: ["CASH", "STOCK", "SPECIAL", "RETURN_OF_CAPITAL", "OTHER"],
      }),
    ],
    params: [
      parameter(
        "multiplier_token",
        "bool",
        false,
        "True if the ticker is a registered Stock Token whose dividends are applied through a UI-multiplier change.",
      ),
    ],
    derived: ["multiplier_effect_expected"],
  },
  [SchemaId.SPLIT]: {
    id: SchemaId.SPLIT,
    name: "SPLIT",
    version: 1,
    fields: [
      field("ticker", "str", true, "The stock ticker for the issuer.", { strMode: "ticker" }),
      field("ratio_num", "int", true, "The numerator of the stated split ratio."),
      field("ratio_den", "int", true, "The denominator of the stated split ratio."),
      field("effective_date", "date", true, "The effective date of the split."),
    ],
    params: [],
    derived: [],
  },
  [SchemaId.EARNINGS]: {
    id: SchemaId.EARNINGS,
    name: "EARNINGS",
    version: 1,
    fields: [
      field("ticker", "str", true, "The stock ticker for the issuer.", { strMode: "ticker" }),
      field("period", "str", true, "The fiscal period reported.", { strMode: "period" }),
      field("eps_gaap_diluted", "num", true, "Diluted GAAP earnings per share for the reported period, as printed."),
      field(
        "eps_non_gaap_diluted",
        "num",
        false,
        "Diluted non-GAAP earnings per share for the reported period, as printed.",
      ),
      field("revenue", "num", true, "Revenue for the reported period, as printed.", {
        tolerance: relativeTolerance(10),
      }),
      field("currency", "str", true, "The currency of the reported financial values.", { strMode: "currency" }),
      field("release_ts", "ts", false, "The earnings release timestamp."),
    ],
    params: [
      parameter("consensus_eps", "num", false, "Requester-supplied consensus EPS."),
      parameter("consensus_revenue", "num", false, "Requester-supplied consensus revenue."),
      parameter("consensus_eps_basis", "enum", false, "Basis used for consensus EPS.", {
        enumValues: ["GAAP", "NON_GAAP"],
      }),
    ],
    derived: ["beat_eps", "beat_revenue"],
  },
  [SchemaId.RESERVE_ATTESTATION]: {
    id: SchemaId.RESERVE_ATTESTATION,
    name: "RESERVE_ATTESTATION",
    version: 1,
    fields: [
      field("issuer", "str", true, "The issuer name as printed.", { strMode: "name" }),
      field("asset_symbol", "str", true, "The reserve asset ticker or symbol.", { strMode: "ticker" }),
      field("as_of", "date", true, "The date the reserve figures apply to."),
      field("reported_supply", "num", true, "The reported circulating or token supply.", {
        tolerance: relativeTolerance(1),
      }),
      field("reported_reserves", "num", true, "The reported reserve amount.", {
        tolerance: relativeTolerance(1),
      }),
      field("custodian", "str", false, "The named reserve custodian.", { strMode: "name" }),
      field("auditor", "str", false, "The named auditor.", { strMode: "name" }),
      field("attestation_type", "enum", false, "The stated type of attestation.", {
        enumValues: ["AUDIT", "REVIEW", "AGREED_UPON_PROCEDURES", "ATTESTATION", "SELF_REPORTED", "OTHER"],
      }),
      field("signature_present", "bool", true, "Whether a signature is visibly present on the attestation."),
    ],
    params: [],
    derived: [],
  },
  [SchemaId.NAV]: {
    id: SchemaId.NAV,
    name: "NAV",
    version: 1,
    fields: [
      field("fund_id", "str", true, "The fund identifier.", { strMode: "id" }),
      field("as_of", "date", true, "The date the NAV applies to."),
      field("nav_per_share", "num", true, "Net asset value per share as printed."),
      field("total_assets", "num", false, "Total fund assets as printed.", { tolerance: relativeTolerance(10) }),
      field("total_liabilities", "num", false, "Total fund liabilities as printed.", {
        tolerance: relativeTolerance(10),
      }),
      field("shares_outstanding", "num", false, "Fund shares outstanding as printed.", {
        tolerance: relativeTolerance(10),
      }),
    ],
    params: [],
    derived: [],
  },
  [SchemaId.INVOICE]: {
    id: SchemaId.INVOICE,
    name: "INVOICE",
    version: 1,
    fields: [
      field("payee_id", "str", true, "The payee name or identifier as printed.", { strMode: "name" }),
      field("payer_id", "str", true, "The payer name or identifier as printed.", { strMode: "name" }),
      field("amount", "num", true, "The invoice amount as printed."),
      field("currency", "str", true, "The invoice currency.", { strMode: "currency" }),
      field("due_date", "date", true, "The invoice due date."),
      field("invoice_number", "str", true, "The invoice number as printed.", { strMode: "id" }),
    ],
    params: [],
    derived: [],
  },
  [SchemaId.FREEFORM_FACT]: {
    id: SchemaId.FREEFORM_FACT,
    name: "FREEFORM_FACT",
    version: 1,
    fields: [field("answer", "str", true, "The answer to the supplied question.", { strMode: "text" })],
    params: [
      parameter("question", "str", true, "The question to answer.", { strMode: "text" }),
      parameter("answer_type", "enum", true, "The answer value type.", {
        enumValues: ["BOOL", "NUMBER", "STRING"],
      }),
    ],
    derived: [],
  },
};

export const SCHEMAS = SCHEMA_DEFINITIONS;

/** Returns a schema definition by its numeric identifier. */
export function getSchema(id: SchemaId): SchemaDef {
  const definition = SCHEMAS[id];
  if (!definition) throw new RangeError(`unknown schema id: ${id}`);
  return definition;
}

/** Resolves FREEFORM_FACT to a concrete answer kind using its required parameters. */
export function resolveSchema(id: SchemaId, params?: Record<string, unknown>): SchemaDef {
  const definition = getSchema(id);
  if (id !== SchemaId.FREEFORM_FACT) return definition;

  const answerType = String(params?.answer_type ?? "").trim().toUpperCase();
  const answerKinds: Record<string, FieldSpec["kind"]> = {
    BOOL: "bool",
    NUMBER: "num",
    STRING: "str",
  };
  if (!answerKinds[answerType] || typeof params?.question !== "string" || !params.question.trim()) {
    throw new TypeError("FREEFORM_FACT requires a question and answer_type BOOL, NUMBER, or STRING");
  }

  return {
    ...definition,
    fields: [
      {
        ...definition.fields[0]!,
        kind: answerKinds[answerType]!,
        ...(answerType === "STRING" ? { strMode: "text" as const } : {}),
      },
    ],
  };
}
