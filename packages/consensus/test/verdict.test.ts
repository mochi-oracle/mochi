import { describe, expect, test } from "bun:test";
import { ZERO32, answerHash as coreAnswerHash, answerJson as coreAnswerJson, SchemaId, VerdictStatus, type SchemaDef, type SpanRef } from "@mochi/core";
import { runConsensus } from "../src/engine.ts";
import { buildVerdictHashes } from "../src/verdict.ts";
import { answer, def, hexByte, seats, vnum } from "./helpers.ts";

const single: SchemaDef = { ...def, fields: [def.fields[0]!] };

describe("buildVerdictHashes", () => {
  test("answer hash changes with salt and public hash matches the core canonical hash", () => {
    const result = runConsensus(single, seats([{ exact_num: vnum(10n) }, { exact_num: vnum(10n) }, { exact_num: vnum(10n) }]));
    const publicResult = buildVerdictHashes(single, result, seats([{ exact_num: vnum(10n) }, { exact_num: vnum(10n) }, { exact_num: vnum(10n) }]), ZERO32);
    const privateResult = buildVerdictHashes(single, result, seats([{ exact_num: vnum(10n) }, { exact_num: vnum(10n) }, { exact_num: vnum(10n) }]), hexByte(99));
    expect(publicResult.answerHash).toBe(coreAnswerHash({ salt: ZERO32, schemaId: single.id, schemaVersion: single.version, fields: { exact_num: vnum(10n) } }));
    expect(publicResult.answerJson).toBe(coreAnswerJson({ salt: ZERO32, schemaId: single.id, schemaVersion: single.version, fields: { exact_num: vnum(10n) } }));
    expect(privateResult.answerHash).not.toBe(publicResult.answerHash);
  });

  test("evidence root is order-independent and deduplicates repeated span leaves", () => {
    const span: SpanRef = { field: "exact_num", start: 1, end: 2, hash: hexByte(1) };
    const s = seats([{ exact_num: vnum(10n) }, { exact_num: vnum(10n) }, { exact_num: vnum(10n) }]);
    const withSpans = s.map((seat) => seat.timedOut ? seat : { ...seat, answer: { ...seat.answer, spans: [span] } });
    const result = runConsensus(single, withSpans);
    const forward = buildVerdictHashes(single, result, withSpans, ZERO32);
    const reverse = buildVerdictHashes(single, result, [...withSpans].reverse(), ZERO32);
    expect(forward.evidenceRoot).not.toBe(ZERO32);
    expect(reverse.evidenceRoot).toBe(forward.evidenceRoot);
  });

  test("hung fields serialize as null in a total answer", () => {
    const input = seats([{ exact_num: vnum(10n) }, { exact_num: vnum(20n) }, { exact_num: vnum(30n) }]);
    const result = runConsensus(single, input);
    expect(result.status).toBe(VerdictStatus.HUNG);
    const hashes = buildVerdictHashes(single, result, input, ZERO32);
    expect(JSON.parse(hashes.answerJson).fields).toEqual({ exact_num: null });
  });
});
