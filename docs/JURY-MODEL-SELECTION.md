# Jury model selection (September 29, 2026)

The launch review is a three-juror (N3) panel using juror classes `LARGE_A`, `DOC_SPECIALIST` and `DISSENTER`, and a
verdict needs all three jurors to agree (`requiredAgree(3) = 3`); anything else is `HUNG`. Model choice therefore
decides both how often a paid review resolves and how often a resolved review is wrong.

## Method

- Dataset: 60 claims from the SciFact development set (AllenAI; labels by the dataset's annotators, not by us),
  stratified 20 SUPPORT / 20 CONTRADICT / 20 NOT ENOUGH INFO, deterministic seeded sample. Expected answers:
  `supported`, `contradicted`, `insufficient_evidence`. The dataset is used for internal evaluation only and is not
  redistributed here; only aggregate results are reported.
- Evidence: the cited abstracts (title + abstract), packaged by the SDK exactly as a paid claim review
  (`createClaimReviewProtocolInput`).
- Path: the production `FREEFORM_FACT` juror prompt (`extractionPrompt`), strict JSON schema, Phala ACI with attested
  confidential routing and receipt verification, the production retry policy, `normalizeAnswer`, and `runConsensus`.
- Single-model runs score each candidate as one juror; panels are scored by combining those real answers under the 3/3
  rule.

## Single juror (correct of 60; not-enough-info correct of 20)

| Model | Correct | NEI | Notes |
|---|---|---|---|
| google/gemma-4-31b-it | 48 | — | two Gemma seats agreed on 59/60 claims (effectively one vote) |
| openai/gpt-oss-120b | 44 | 14 | 4 malformed JSON outputs |
| deepseek/deepseek-v4-flash-0731 | 43 | 11 | cheapest, fastest median; slow tail |
| qwen/qwen3.6-35b-a3b | 43 | 11 | |
| qwen/qwen3.5-397b-a17b | 40 | 7 | |
| z-ai/glm-5.3 | 38 | 8 | 15 errors, expensive |
| deepseek/deepseek-v3.2 | 36 | 6 | |
| moonshotai/kimi-k2.6 | 36 | 4 | fastest |
| meta-llama/llama-3.3-70b-instruct | 30 | 0 | never answered insufficient_evidence |
| nvidia/nemotron-3.5-lightning | 16 | 0 | often echoed the claim instead of a label |

## Two fixes that mattered more than the model choice

1. **Unquoted "insufficient_evidence" answers were discarded.** Consensus only counts a value backed by a verbatim
   evidence span, but the claim question told jurors to cite passages "for every answer except insufficient_evidence".
   Unanimous "not enough evidence" juries therefore came back `HUNG` (juror fees charged, no answer). The question now
   asks for the passage closest to the claim for every answer (`packages/sdk/src/claims.ts`).
2. **Occasional inexact quotes.** A juror whose quote is not a verbatim passage is asked once more to copy it exactly
   (`services/juror/src/extract.ts`); quotes are still verified against the document.

## Panels, measured end to end with both fixes (correct / wrong / unresolved of 60)

| Panel (LARGE_A + DOC_SPECIALIST + DISSENTER) | Correct | Wrong | Unresolved | Median seconds | Mean inference USD |
|---|---|---|---|---|---|
| Llama + Gemma + Gemma, before the fixes | 25 | 3 | 32 | 4 | 0.008 |
| **Qwen 3.6 + Gemma + GPT-OSS (launch)** | **39** | **7** | **14** | 22 | 0.016 |
| Llama + Gemma + Gemma | 36 | 5 | 19 | 3 | 0.006 |
| GPT-OSS + Gemma + Gemma | 36 | 9 | 15 | 6 | 0.002 |

The launch panel resolves the most claims correctly with three independent model families; differences between the
top panels are within the noise of a 60-claim sample. Two identical Gemma seats agreed on 59/60 claims, so they add
little independent judgement. Mean inference cost stays well under the $0.10 tariff. `LARGE_B` (DeepSeek V4 Flash) and
`SMALL_FAST` (Kimi K2.6) serve larger juries only; launch offers N3.

Limits: 60 scientific claims are a small sample and not a representative crypto/AI benchmark. These numbers support
model selection only; they are not an accuracy promise.
