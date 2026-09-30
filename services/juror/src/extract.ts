import { extractionJsonSchema, extractionPrompt, normalizeAnswer } from "@mochi/schemas";
import type { JurorAnswerBody, SchemaDef } from "@mochi/core";
import type { ModelRunner, RunBudget } from "./runner.ts";

/** Fields that carry a value but no verified verbatim evidence span; consensus counts those answers as invalid. */
export function unquotedFields(def: SchemaDef, body: JurorAnswerBody): string[] {
  return def.fields
    .filter((field) => body.fields[field.name] != null && !body.invalid.includes(field.name) && !body.spans.some((span) => span.field === field.name))
    .map((field) => field.name);
}

/**
 * Runs the extraction prompt. When a value comes back without an exact evidence quote (models occasionally trim or
 * paraphrase), asks the same model once more to copy the passage verbatim, and keeps whichever answer has fewer
 * unquoted fields (the original on a tie). Quotes are still verified against the document by normalizeAnswer.
 */
export async function extractAnswer(runner: ModelRunner, def: SchemaDef, params: Record<string, unknown>, text: string, maxTokens: number, budget?: RunBudget & { onCall?: (call: "initial" | "repair", cause?: "repair_skipped" | "repair_failed") => void }): Promise<{ body: JurorAnswerBody; repaired: boolean }> {
  const prompt = extractionPrompt(def, params);
  const jsonSchema = extractionJsonSchema(def);
  const run = async (user: string, call: "initial" | "repair") => {
    budget?.onCall?.(call);
    const raw = await runner.run({ system: prompt.system, user, document: text, jsonSchema, maxTokens }, budget);
    if (!raw || typeof raw !== "object" || !("fields" in raw) || typeof raw.fields !== "object" || raw.fields === null) throw new TypeError("invalid model output");
    return normalizeAnswer(def, raw as Parameters<typeof normalizeAnswer>[1], text);
  };
  const first = await run(prompt.user, "initial");
  const missing = unquotedFields(def, first);
  if (!missing.length) return { body: first, repaired: false };
  if (budget && budget.remainingMs() < 35_000) {
    budget.onCall?.("repair", "repair_skipped");
    return { body: first, repaired: false };
  }
  let second;
  try { second = await run(`${prompt.user}\n\nYour previous evidence quote for ${missing.join(", ")} was not an exact passage of the document. Copy the evidence quote verbatim, character for character, from the document.`, "repair"); }
  catch (error) {
    if (!budget) throw error;
    budget.onCall?.("repair", "repair_failed");
    return { body: first, repaired: false };
  }
  return { body: unquotedFields(def, second).length < missing.length ? second : first, repaired: true };
}
