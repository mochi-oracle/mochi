import type { SchemaDef } from "@mochi/core";

export const PROMPT_TEMPLATE_VERSION = 2;

/** Maps a schema field kind to the JSON Schema value type accepted from the model. */
function rawFieldTypes(kind: SchemaDef["fields"][number]["kind"]): string[] {
  if (kind === "bool") return ["boolean", "null"];
  if (kind === "num" || kind === "int") return ["string", "number", "null"];
  return ["string", "null"];
}

/** Builds the guided-decoding JSON Schema for model output. */
export function extractionJsonSchema(definition: SchemaDef) {
  const fieldProperties: Record<string, unknown> = {};
  const evidenceProperties: Record<string, unknown> = {};
  const confidenceProperties: Record<string, unknown> = {};

  for (const field of definition.fields) {
    fieldProperties[field.name] = {
      type: rawFieldTypes(field.kind),
      ...(field.enumValues ? { enum: [...field.enumValues, null] } : {}),
    };
    evidenceProperties[field.name] = { type: ["string", "null"] };
    confidenceProperties[field.name] = { type: "number", minimum: 0, maximum: 1 };
  }

  return {
    type: "object",
    required: ["fields", "evidence", "confidence"],
    additionalProperties: false,
    properties: {
      fields: {
        type: "object",
        required: definition.fields.map((field) => field.name),
        additionalProperties: false,
        properties: fieldProperties,
      },
      evidence: {
        type: "object",
        additionalProperties: false,
        properties: evidenceProperties,
      },
      confidence: {
        type: "object",
        additionalProperties: false,
        properties: confidenceProperties,
      },
    },
  };
}

/** Builds the extraction rules and field list shown to the model. */
export function extractionPrompt(
  definition: SchemaDef,
  params: Record<string, unknown> = {},
): { system: string; user: string } {
  const system =
    "Extract only what the document states. Return an object with fields (one key per field, " +
    "the value as printed or null), evidence (one key per non-null field, an exact verbatim quote " +
    "copied from the document that contains the value), and confidence (one key per field, a number " +
    "from 0 to 1). Copy an exact verbatim quote for every non-null field as evidence. Use null when " +
    "a value is absent. Never compute or infer values that are not printed (for example, do not " +
    "compute EPS). Keep numbers as printed with their units; keep dates as written. Return no commentary.";
  const fieldDescriptions = definition.fields.map((field) => {
    const required = field.required ? "required" : "optional";
    const allowed = field.enumValues ? `; allowed: ${field.enumValues.join(", ")}` : "";
    return `- ${field.name} (${field.kind}, ${required}${allowed}): ${field.description}`;
  });
  if (definition.id === 7) fieldDescriptions.unshift(`Question: ${String(params.question ?? "")}`);

  return { system, user: `Extract these fields:\n${fieldDescriptions.join("\n")}` };
}
