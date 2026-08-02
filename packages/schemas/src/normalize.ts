import { keccak256, toHex } from "viem";
import type {
  FieldSpec,
  JurorAnswerBody,
  NormalizedValue,
  ParamSpec,
  SchemaDef,
} from "@mochi/core";

const NULL_LIKE_WORDS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "not stated",
  "not available",
  "not disclosed",
  "-",
  "—",
]);
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const SCALE_SUFFIXES: Record<string, number> = {
  k: 3,
  thousand: 3,
  m: 6,
  mm: 6,
  mn: 6,
  million: 6,
  b: 9,
  bn: 9,
  billion: 9,
  t: 12,
  tn: 12,
  trillion: 12,
};
const CURRENCY_TOKENS = [
  "US$",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CAD",
  "AUD",
  "$",
  "€",
  "£",
  "¥",
];
const CURRENCY_NAMES: Record<string, string> = {
  "$": "USD",
  "us$": "USD",
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  "€": "EUR",
  euro: "EUR",
  euros: "EUR",
  "£": "GBP",
  "¥": "JPY",
  yen: "JPY",
};
const ENUM_SYNONYMS: Record<string, string> = {
  REGULAR: "CASH",
  ORDINARY: "CASH",
  QUARTERLY: "CASH",
  CASH_DIVIDEND: "CASH",
  SPECIAL_CASH: "SPECIAL",
  SPECIAL_DIVIDEND: "SPECIAL",
  STOCK_DIVIDEND: "STOCK",
  ROC: "RETURN_OF_CAPITAL",
};
const LEGAL_SUFFIX =
  /\s+(inc|llc|ltd|corp|corporation|co|company|plc|lp|llp|na|sa|ag|gmbh)$/;

/** Returns a successful normalized value. */
function success(value: NormalizedValue | null) {
  return { ok: true as const, value };
}

/** Returns a normalization failure with a useful reason. */
function failure(error: string) {
  return { ok: false as const, error };
}

/** Identifies null and supported null-like strings. */
function isNullLike(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "string" &&
      (!value.trim() || NULL_LIKE_WORDS.has(value.trim().toLowerCase())))
  );
}

/** Removes currency codes and symbols wherever they occur in a numeric string. */
function stripCurrency(text: string): string {
  let cleaned = text;
  for (const currency of CURRENCY_TOKENS) {
    const escaped = currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(escaped, "gi"), "");
  }
  return cleaned;
}

/** Rejects numeric text that contains more than one currency marker. */
function assertSingleCurrency(text: string): void {
  const markers = text.match(/US\$|USD|EUR|GBP|JPY|CAD|AUD|[$€£¥]/gi) ?? [];
  if (markers.length > 1) throw new Error("multiple currency markers");
}

/** Parses decimal digits and rounds to fixed point using bigint arithmetic. */
function parseNumber(raw: unknown): bigint {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error("expected number");
  }

  let text = typeof raw === "number" ? String(raw) : raw;
  assertSingleCurrency(text);
  text = stripCurrency(text.trim());
  text = text.replace(/[\u2009\u202f\u00a0,_]/g, "").trim();

  let negative = false;
  const parenthesizedWithScale = text.match(/^\((.*)\)\s*(thousand|million|billion|trillion|mm|mn|bn|tn|k|m|b|t)?$/i);
  if (parenthesizedWithScale) {
    negative = true;
    text = `${parenthesizedWithScale[1]} ${parenthesizedWithScale[2] ?? ""}`.trim();
  } else if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  } else if (/^[−-]/.test(text)) {
    negative = true;
    text = text.slice(1).trim();
  }

  text = stripCurrency(text).trim();
  if (/^[−-]/.test(text)) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  text = text.replace(/[\u2009\u202f\u00a0,_]/g, "").trim();

  const match = text.match(
    /^(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?\s*(thousand|million|billion|trillion|mm|mn|bn|tn|k|m|b|t)?$/i,
  );
  if (!match) throw new Error("invalid number");

  const decimal = match[1]!;
  let exponent = Number(match[2] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new Error("number exponent out of range");
  }
  exponent += SCALE_SUFFIXES[(match[3] ?? "").toLowerCase()] ?? 0;

  const digits = decimal.replace(".", "");
  const decimalPlaces = decimal.split(".")[1]?.length ?? 0;
  const power = exponent - decimalPlaces + 8;
  let scaled = BigInt(digits || "0");
  if (power >= 0) {
    scaled *= 10n ** BigInt(power);
  } else {
    const divisor = 10n ** BigInt(-power);
    const quotient = scaled / divisor;
    const remainder = scaled % divisor;
    scaled = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return negative ? -scaled : scaled;
}

/** Validates a calendar date and formats it as an ISO date. */
function formatCalendarDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("invalid calendar date");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day)
    .padStart(2, "0")}`;
}

/** Resolves full and abbreviated month names. */
function monthNumber(rawMonth: string): number {
  const month = rawMonth.toLowerCase().replace(/\.$/, "");
  const index = MONTH_NAMES.findIndex(
    (name) => name === month || name.slice(0, 3) === month || (name === "september" && month === "sept"),
  );
  if (index < 0) throw new Error("invalid month");
  return index + 1;
}

/** Parses accepted date formats, including US-ordered slash dates. */
function parseDate(raw: string): string {
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return formatCalendarDate(+match[1]!, +match[2]!, +match[3]!);

  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return formatCalendarDate(+match[3]!, +match[1]!, +match[2]!);

  const ordinalDay = "(\\d{1,2})(?:st|nd|rd|th)?";
  const monthFirst = new RegExp(`^([A-Za-z]+\\.?)\\s+${ordinalDay},?\\s+(\\d{4})$`, "i");
  const dayFirst = new RegExp(`^${ordinalDay}\\s+([A-Za-z]+\\.?)\\s+(\\d{4})$`, "i");
  const weekdayPrefix = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*/i;
  const withoutWeekday = raw.replace(weekdayPrefix, "");

  match = withoutWeekday.match(monthFirst);
  if (match) return formatCalendarDate(+match[3]!, monthNumber(match[1]!), +match[2]!);

  match = withoutWeekday.match(dayFirst);
  if (match) return formatCalendarDate(+match[3]!, monthNumber(match[2]!), +match[1]!);

  match = raw.match(/^(\d{4}-\d{2}-\d{2})T.*(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (match) {
    const milliseconds = Date.parse(raw);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid date");
    return new Date(milliseconds).toISOString().slice(0, 10);
  }
  throw new Error("invalid date");
}

/** Expands two-digit years using the package's 20xx fiscal-year convention. */
function fullYear(rawYear: string): number {
  const year = Number(rawYear);
  return year < 100 ? year + 2000 : year;
}

/** Canonicalizes supported fiscal quarter, year, and half-year expressions. */
function normalizePeriod(rawPeriod: string): string {
  const text = rawPeriod.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
  const quarterWords: Record<string, string> = {
    first: "1",
    second: "2",
    third: "3",
    fourth: "4",
  };
  let match = text.match(/^(\d{4})q([1-4])$/);
  if (match) return `${match[1]}Q${match[2]}`;

  match = text.match(/^(\d{4})h([12])$/);
  if (match) return `${match[1]}H${match[2]}`;

  match = text.match(/^fy\s*(\d{2,4})\s*q([1-4])$/);
  if (match) return `${fullYear(match[1]!)}Q${match[2]}`;

  match = text.match(/^([1-4])q\s*fy\s*(\d{2,4})$/);
  if (match) return `${fullYear(match[2]!)}Q${match[1]}`;

  match = text.match(/^(?:fiscal\s+)?q([1-4])\s+(?:fiscal\s+(?:year\s+)?)?(?:fy\s*)?(\d{2,4})$/);
  if (match) return `${fullYear(match[2]!)}Q${match[1]}`;

  match = text.match(/^(\d{1,2})q(\d{2,4})$/);
  if (match && Number(match[1]) <= 4) return `${fullYear(match[2]!)}Q${match[1]}`;

  match = text.match(
    /^(?:the\s+)?(first|second|third|fourth)\s+quarter(?:\s+of)?\s+(?:(?:the\s+)?fiscal\s+(?:year\s+)?)?(\d{2,4})$/,
  );
  if (match) return `${fullYear(match[2]!)}Q${quarterWords[match[1]!]}`;

  match = text.match(/^fy\s*(\d{2,4})$/) ??
    text.match(/^(?:fiscal(?:\s+year)?|full\s+year)\s+(\d{2,4})$/);
  if (match) return `FY${fullYear(match[1]!)}`;

  match = text.match(/^h([12])\s+(\d{2,4})$/) ??
    text.match(/^(first|second)\s+half\s+(\d{2,4})$/);
  if (match) {
    const half = /^[12]$/.test(match[1]!) ? match[1] : match[1] === "first" ? "1" : "2";
    return `${fullYear(match[2]!)}H${half}`;
  }
  throw new Error("unrecognized period");
}

/** Canonicalizes strings according to the field's declared mode. */
function normalizeString(raw: string, mode: FieldSpec["strMode"]): string {
  let text = raw.normalize("NFKC").trim();
  switch (mode) {
    case "ticker":
      return text.replace(/^\$/, "").replace(/^[A-Za-z.]+:/, "").trim().toUpperCase();
    case "currency": {
      const normalized = CURRENCY_NAMES[text.toLowerCase()] ?? text.toUpperCase();
      if (!/^[A-Z]{3}$/.test(normalized)) throw new Error("invalid currency");
      return normalized;
    }
    case "name": {
      text = text
        .replace(/\./g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      while (LEGAL_SUFFIX.test(text)) text = text.replace(LEGAL_SUFFIX, "");
      return text;
    }
    case "id":
      return text.toUpperCase().replace(/\s/g, "");
    case "period":
      return normalizePeriod(text);
    case "text":
      return text.replace(/\s+/g, " ");
    default:
      return text;
  }
}

/** Converts one raw value according to its field or parameter specification. */
export function normalizeValue(
  spec: FieldSpec | ParamSpec,
  raw: unknown,
): { ok: true; value: NormalizedValue | null } | { ok: false; error: string } {
  if (isNullLike(raw)) return success(null);

  try {
    switch (spec.kind) {
      case "num":
        return success({ t: "num", e8: parseNumber(raw) });
      case "int": {
        const text = typeof raw === "number" ? String(raw) : String(raw).replace(/,/g, "").trim();
        if (!/^[+-]?\d+$/.test(text)) throw new Error("expected integer");
        return success({ t: "int", v: BigInt(text) });
      }
      case "date":
        return success({ t: "date", v: parseDate(String(raw).trim()) });
      case "ts": {
        if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
          const timestamp = Number(raw);
          if (!Number.isSafeInteger(timestamp) || timestamp < 1e9 || timestamp >= 1e11) {
            throw new Error("invalid unix timestamp");
          }
          return success({ t: "ts", v: timestamp });
        }
        const text = String(raw);
        if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) throw new Error("timestamp requires timezone");
        const milliseconds = Date.parse(text);
        if (!Number.isFinite(milliseconds)) throw new Error("invalid timestamp");
        return success({ t: "ts", v: Math.floor(milliseconds / 1000) });
      }
      case "str":
        return success({ t: "str", v: normalizeString(String(raw), spec.strMode) });
      case "enum": {
        const text = String(raw).trim().toUpperCase().replace(/[ -]+/g, "_");
        const value = ENUM_SYNONYMS[text] ?? text;
        if (!spec.enumValues?.includes(value)) throw new Error("invalid enum member");
        return success({ t: "enum", v: value });
      }
      case "bool": {
        if (raw === true || raw === 1 || raw === "1") return success({ t: "bool", v: true });
        if (raw === false || raw === 0 || raw === "0") return success({ t: "bool", v: false });
        const value = String(raw).trim().toLowerCase();
        if (["true", "yes", "y"].includes(value)) return success({ t: "bool", v: true });
        if (["false", "no", "n"].includes(value)) return success({ t: "bool", v: false });
        throw new Error("invalid boolean");
      }
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : "invalid value");
  }
}

/** Normalizes whitespace and returns a character-to-source offset map. */
function collapseWhitespace(text: string): { value: string; offsets: number[] } {
  let value = "";
  const offsets: number[] = [];
  for (let index = 0; index < text.length; ) {
    if (/\s/.test(text[index]!)) {
      while (index < text.length && /\s/.test(text[index]!)) index++;
      offsets.push(index - 1);
      value += " ";
    } else {
      offsets.push(index);
      value += text[index]!;
      index++;
    }
  }
  return { value, offsets };
}

/** Finds an exact or whitespace-normalized quote in the document text. */
export function locateSpan(docText: string, quote: string): { start: number; end: number } | null {
  if (quote.length < 2) return null;
  const exactIndex = docText.indexOf(quote);
  if (exactIndex >= 0) return { start: exactIndex, end: exactIndex + quote.length };

  const document = collapseWhitespace(docText);
  const normalizedQuote = collapseWhitespace(quote).value;
  for (const caseInsensitive of [false, true]) {
    const haystack = caseInsensitive ? document.value.toLowerCase() : document.value;
    const needle = caseInsensitive ? normalizedQuote.toLowerCase() : normalizedQuote;
    const index = haystack.indexOf(needle);
    if (index >= 0) {
      return {
        start: document.offsets[index]!,
        end: document.offsets[index + needle.length - 1]! + 1,
      };
    }
  }
  return null;
}

/** Normalizes all declared fields and records valid evidence spans. */
export function normalizeAnswer(
  def: SchemaDef,
  raw: {
    fields: Record<string, unknown>;
    evidence?: Record<string, string>;
    confidence?: Record<string, number>;
  },
  docText: string,
): JurorAnswerBody {
  const fields: JurorAnswerBody["fields"] = {};
  const invalid: string[] = [];
  const spans: JurorAnswerBody["spans"] = [];
  const confidence: Record<string, number> = {};

  for (const field of def.fields) {
    const normalized = normalizeValue(field, raw.fields?.[field.name]);
    fields[field.name] = normalized.ok ? normalized.value : null;
    if (!normalized.ok) invalid.push(field.name);

    const rawConfidence = raw.confidence?.[field.name];
    confidence[field.name] =
      typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0;

    const quote = raw.evidence?.[field.name];
    if (fields[field.name] !== null && typeof quote === "string") {
      const span = locateSpan(docText, quote);
      if (span) {
        spans.push({
          field: field.name,
          ...span,
          hash: keccak256(toHex(docText.slice(span.start, span.end))),
        });
      }
    }
  }
  return { schemaId: def.id, schemaVersion: def.version, fields, invalid, spans, confidence };
}
