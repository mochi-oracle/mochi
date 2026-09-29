import { expect, test } from "bun:test";
import { SchemaId } from "@mochi/core";
import { resolveSchema } from "@mochi/schemas";
import { extractAnswer, unquotedFields } from "../src/extract.ts";
import type { ModelInput, ModelRunner } from "../src/runner.ts";

const def = resolveSchema(SchemaId.FREEFORM_FACT, { question: "Assess the claim.", answer_type: "STRING" });
const text = "Claim: the paper appeared in 2008. Evidence: The paper was released on October 31, 2008.";
const scripted = (outputs: unknown[]) => {
  const inputs: ModelInput[] = [];
  const runner: ModelRunner = { run: async (input) => { inputs.push(input); return outputs[inputs.length - 1]; } };
  return { runner, inputs };
};

test("a verbatim quote is accepted on the first call", async () => {
  const { runner, inputs } = scripted([{ fields: { answer: "supported" }, evidence: { answer: "The paper was released on October 31, 2008." }, confidence: {} }]);
  const out = await extractAnswer(runner, def, {}, text, 512);
  expect(inputs).toHaveLength(1);
  expect(out.repaired).toBe(false);
  expect(unquotedFields(def, out.body)).toEqual([]);
});

test("a paraphrased quote triggers one verbatim retry whose quoted answer is kept", async () => {
  const { runner, inputs } = scripted([
    { fields: { answer: "supported" }, evidence: { answer: "paper came out on 31 October 2008" }, confidence: {} },
    { fields: { answer: "supported" }, evidence: { answer: "released on October 31, 2008" }, confidence: {} },
  ]);
  const out = await extractAnswer(runner, def, {}, text, 512);
  expect(inputs).toHaveLength(2);
  expect(inputs[1]!.user).toContain("Copy the evidence quote verbatim");
  expect(inputs[1]!.system).toBe(inputs[0]!.system);
  expect(inputs[1]!.document).toBe(inputs[0]!.document);
  expect(out.repaired).toBe(true);
  expect(unquotedFields(def, out.body)).toEqual([]);
});

test("if the retry is still unquoted the original answer is kept, and there is never a third call", async () => {
  const { runner, inputs } = scripted([
    { fields: { answer: "insufficient_evidence" }, evidence: {}, confidence: {} },
    { fields: { answer: "contradicted" }, evidence: { answer: "not in the document" }, confidence: {} },
  ]);
  const out = await extractAnswer(runner, def, {}, text, 512);
  expect(inputs).toHaveLength(2);
  expect((out.body.fields.answer as { v: string }).v).toBe("insufficient_evidence");
});

test("malformed model output still fails", async () => {
  const { runner } = scripted([{ nope: true }]);
  await expect(extractAnswer(runner, def, {}, text, 512)).rejects.toThrow("invalid model output");
});
