import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toHex,
  type AbiParameter,
  type Hex,
} from "viem";
import {
  SchemaId,
  encodePayload,
  privatePayloadHash,
  publicPayloadHash,
  toBytes32String,
  type NormalizedValue,
  type SchemaDef,
} from "@mochi/core";

const ABSENT_INT = -(2n ** 255n);
const DIVIDEND_TYPES = ["CASH", "STOCK", "SPECIAL", "RETURN_OF_CAPITAL", "OTHER"];
const ANSWER_TYPES = ["BOOL", "NUMBER", "STRING"];
const UTF8_ENCODER = new TextEncoder();

interface TupleSpec {
  names: string[];
  types: AbiParameter["type"][];
}

/** Solidity tuple layouts, in the same member order as MochiTypes.sol. */
const PAYLOAD_TUPLES: Record<number, TupleSpec> = {
  1: {
    names: [
      "ticker", "exDate", "recordDate", "payDate", "amountPerShareE8", "currency", "dividendType",
      "multiplierEffectExpected",
    ],
    types: ["bytes32", "uint64", "uint64", "uint64", "int256", "bytes32", "uint8", "bool"],
  },
  2: {
    names: ["ticker", "effectiveDate", "ratioNum", "ratioDen"],
    types: ["bytes32", "uint64", "uint32", "uint32"],
  },
  3: {
    names: [
      "ticker", "period", "releaseTs", "epsGaapDilutedE8", "epsNonGaapDilutedE8", "revenueE8",
      "currency", "beatEps", "beatRevenue",
    ],
    types: ["bytes32", "bytes32", "uint64", "int256", "int256", "int256", "bytes32", "int8", "int8"],
  },
  4: {
    names: [
      "assetSymbol", "asOf", "reportedSupplyE8", "reportedReservesE8", "signaturePresent", "issuer",
      "custodian", "auditor", "attestationType",
    ],
    types: ["bytes32", "uint64", "int256", "int256", "bool", "string", "string", "string", "string"],
  },
  5: {
    names: ["fundId", "asOf", "navPerShareE8", "totalAssetsE8", "totalLiabilitiesE8", "sharesOutstandingE8"],
    types: ["bytes32", "uint64", "int256", "int256", "int256", "int256"],
  },
  6: {
    names: ["invoiceKey", "dueDate", "amountE8", "currency", "payeeId", "payerId", "invoiceNumber"],
    types: ["bytes32", "uint64", "int256", "bytes32", "string", "string", "string"],
  },
  7: {
    names: ["questionHash", "asOf", "answerType", "boolAnswer", "numberAnswerE8", "stringAnswer"],
    types: ["bytes32", "uint64", "uint8", "bool", "int256", "string"],
  },
};

/** Encodes a string as UTF-8 bytes for hashing. */
function utf8(value: string): Hex {
  return toHex(UTF8_ENCODER.encode(value));
}

/** Reads a nullable value by normalized field name. */
function valueAt(values: Record<string, NormalizedValue | null>, name: string) {
  return values[name] ?? null;
}

/** Reads a required normalized value or throws when it is missing. */
function requiredValue(values: Record<string, NormalizedValue | null>, name: string): NormalizedValue {
  const value = valueAt(values, name);
  if (value === null) throw new TypeError(`required field missing: ${name}`);
  return value;
}

/** Reads a string or enum value, returning an empty string for an absent optional field. */
function stringValue(
  values: Record<string, NormalizedValue | null>,
  name: string,
  required = true,
): string {
  const value = required ? requiredValue(values, name) : valueAt(values, name);
  if (value === null) return "";
  if (value.t === "str" || value.t === "enum") return value.v;
  if (value.t === "bool") return String(value.v);
  if (value.t === "num") return String(value.e8);
  return String(value.v);
}

/** Reads a fixed-point number or returns the absent-int sentinel for optional values. */
function numberE8(
  values: Record<string, NormalizedValue | null>,
  name: string,
  required = true,
): bigint {
  const value = required ? requiredValue(values, name) : valueAt(values, name);
  if (value === null) return ABSENT_INT;
  if (value.t !== "num") throw new TypeError(`${name} must be num`);
  return value.e8;
}

/** Reads a date field as seconds since midnight UTC. */
function dateSeconds(
  values: Record<string, NormalizedValue | null>,
  name: string,
  required = true,
): bigint {
  const value = required ? requiredValue(values, name) : valueAt(values, name);
  if (value === null) return 0n;
  if (value.t !== "date") throw new TypeError(`${name} must be date`);
  return BigInt(Date.parse(`${value.v}T00:00:00Z`) / 1000);
}

/** Converts a string to bytes32 or hashes it when its UTF-8 form is too long. */
function bytes32String(value: string): Hex {
  return UTF8_ENCODER.encode(value).length > 32 ? keccak256(utf8(value)) : toBytes32String(value);
}

/** Builds named ABI tuple components from a schema's explicit field layout. */
function tupleComponents(spec: TupleSpec): AbiParameter[] {
  return spec.names.map((name, index) => ({ name, type: spec.types[index]! }));
}

/** Encodes a Solidity struct as a single ABI tuple parameter. */
function encodeStruct(spec: TupleSpec, values: readonly unknown[]): Hex {
  const components = tupleComponents(spec);
  const parameters = [{ type: "tuple", components }] as const;
  return encodeAbiParameters(parameters, [values] as never);
}

/** Decodes the tuple body into an object with Solidity member names. */
function decodeStruct(spec: TupleSpec, encoded: Hex): Record<string, unknown> {
  const components = tupleComponents(spec);
  const parameters = [{ type: "tuple", components }] as const;
  const decoded = decodeAbiParameters(parameters, encoded as never)[0] as unknown as
    | readonly unknown[]
    | Record<string, unknown>;
  return Object.fromEntries(
    spec.names.map((name, index) => [
      name,
      Array.isArray(decoded)
        ? decoded[index]
        : (decoded as Record<string, unknown>)[name],
    ]),
  );
}

/** Returns a three-way comparison against consensus, or 2 when either value is missing. */
function beatResult(value: NormalizedValue | null, consensus: NormalizedValue | null): number {
  if (!consensus || !value) return 2;
  if (value.t !== "num" || consensus.t !== "num") throw new TypeError("beat comparison requires numbers");
  return value.e8 > consensus.e8 ? 1 : value.e8 < consensus.e8 ? -1 : 0;
}

/**
 * Builds the typed schema body and outer feed payload from agreed values. `payloadHash` is the value posted on-chain:
 * keccak256(payload) for a public query, or privatePayloadHash(privateSalt, payload) when `privateSalt` (the private
 * query's secret seed salt) is given, so the outcome of a private query cannot be found by hashing candidates.
 */
export function buildPayload(
  definition: SchemaDef,
  agreed: Record<string, NormalizedValue | null>,
  params: Record<string, NormalizedValue | null>,
  context: { openedAt: bigint; privateSalt?: Hex },
) {
  let subjectKey: Hex;
  let asOf: bigint;
  let body: Hex;
  let derived: Record<string, unknown> = {};
  const fieldString = (name: string, required = true) => stringValue(agreed, name, required);

  switch (definition.id) {
    case SchemaId.EX_DIVIDEND: {
      const dividendType = DIVIDEND_TYPES.indexOf(fieldString("dividend_type"));
      const multiplier = valueAt(params, "multiplier_token");
      derived.multiplier_effect_expected = multiplier?.t === "bool" ? multiplier.v : false;
      subjectKey = toBytes32String(fieldString("ticker"));
      asOf = dateSeconds(agreed, "ex_date");
      body = encodeStruct(PAYLOAD_TUPLES[1]!, [
        subjectKey,
        asOf,
        dateSeconds(agreed, "record_date", false),
        dateSeconds(agreed, "pay_date", false),
        numberE8(agreed, "amount_per_share"),
        toBytes32String(fieldString("currency")),
        dividendType,
        derived.multiplier_effect_expected,
      ]);
      break;
    }
    case SchemaId.SPLIT: {
      subjectKey = toBytes32String(fieldString("ticker"));
      asOf = dateSeconds(agreed, "effective_date");
      const numerator = requiredValue(agreed, "ratio_num");
      const denominator = requiredValue(agreed, "ratio_den");
      if (numerator.t !== "int" || denominator.t !== "int") throw new TypeError("split ratios must be integers");
      body = encodeStruct(PAYLOAD_TUPLES[2]!, [subjectKey, asOf, numerator.v, denominator.v]);
      break;
    }
    case SchemaId.EARNINGS: {
      subjectKey = toBytes32String(fieldString("ticker"));
      const releaseTime = valueAt(agreed, "release_ts");
      asOf = releaseTime?.t === "ts" ? BigInt(releaseTime.v) : context.openedAt;
      const basisValue = valueAt(params, "consensus_eps_basis");
      const basis = basisValue?.t === "enum"
        ? basisValue.v
        : valueAt(agreed, "eps_non_gaap_diluted")
          ? "NON_GAAP"
          : "GAAP";
      const epsValue = valueAt(agreed, basis === "NON_GAAP" ? "eps_non_gaap_diluted" : "eps_gaap_diluted");
      const beatEps = beatResult(epsValue, valueAt(params, "consensus_eps"));
      const beatRevenue = beatResult(valueAt(agreed, "revenue"), valueAt(params, "consensus_revenue"));
      derived = { beat_eps: beatEps, beat_revenue: beatRevenue };
      body = encodeStruct(PAYLOAD_TUPLES[3]!, [
        subjectKey,
        toBytes32String(fieldString("period")),
        releaseTime?.t === "ts" ? BigInt(releaseTime.v) : 0n,
        numberE8(agreed, "eps_gaap_diluted"),
        numberE8(agreed, "eps_non_gaap_diluted", false),
        numberE8(agreed, "revenue"),
        toBytes32String(fieldString("currency")),
        beatEps,
        beatRevenue,
      ]);
      break;
    }
    case SchemaId.RESERVE_ATTESTATION: {
      subjectKey = toBytes32String(fieldString("asset_symbol"));
      asOf = dateSeconds(agreed, "as_of");
      const signaturePresent = requiredValue(agreed, "signature_present");
      if (signaturePresent.t !== "bool") throw new TypeError("signature_present must be bool");
      body = encodeStruct(PAYLOAD_TUPLES[4]!, [
        subjectKey,
        asOf,
        numberE8(agreed, "reported_supply"),
        numberE8(agreed, "reported_reserves"),
        signaturePresent.v,
        fieldString("issuer"),
        fieldString("custodian", false),
        fieldString("auditor", false),
        stringValue(agreed, "attestation_type", false),
      ]);
      break;
    }
    case SchemaId.NAV: {
      subjectKey = bytes32String(fieldString("fund_id"));
      asOf = dateSeconds(agreed, "as_of");
      body = encodeStruct(PAYLOAD_TUPLES[5]!, [
        subjectKey,
        asOf,
        numberE8(agreed, "nav_per_share"),
        numberE8(agreed, "total_assets", false),
        numberE8(agreed, "total_liabilities", false),
        numberE8(agreed, "shares_outstanding", false),
      ]);
      break;
    }
    case SchemaId.INVOICE: {
      const payee = fieldString("payee_id");
      const invoiceNumber = fieldString("invoice_number");
      subjectKey = keccak256(utf8(`${payee}|${invoiceNumber}`));
      asOf = dateSeconds(agreed, "due_date");
      body = encodeStruct(PAYLOAD_TUPLES[6]!, [
        subjectKey,
        asOf,
        numberE8(agreed, "amount"),
        toBytes32String(fieldString("currency")),
        payee,
        fieldString("payer_id"),
        invoiceNumber,
      ]);
      break;
    }
    case SchemaId.FREEFORM_FACT: {
      const question = stringValue(params, "question");
      const answerType = stringValue(params, "answer_type");
      const answer = requiredValue(agreed, "answer");
      subjectKey = keccak256(utf8(question));
      asOf = context.openedAt;
      body = encodeStruct(PAYLOAD_TUPLES[7]!, [
        subjectKey,
        asOf,
        ANSWER_TYPES.indexOf(answerType),
        answer.t === "bool" ? answer.v : false,
        answer.t === "num" ? answer.e8 : 0n,
        answer.t === "str" ? answer.v : "",
      ]);
      break;
    }
    default:
      throw new Error("unknown schema");
  }

  const payload = encodePayload(subjectKey, asOf, body);
  const payloadHash = context.privateSalt === undefined ? publicPayloadHash(payload) : privatePayloadHash(context.privateSalt, payload);
  return { subjectKey, asOf, body, payload, payloadHash, derived };
}

/** Decodes the outer payload and schema-specific tuple body into named fields. */
export function decodePayload(schemaId: SchemaId, payload: Hex) {
  const [subjectKey, asOf, body] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes" }] as const,
    payload,
  );
  const tuple = PAYLOAD_TUPLES[schemaId];
  if (!tuple) throw new Error("unknown schema");
  return { subjectKey, asOf, body: decodeStruct(tuple, body) };
}
