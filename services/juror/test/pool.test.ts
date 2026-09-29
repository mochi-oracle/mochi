import { expect, test } from "bun:test";
import { parseSeats } from "../src/pool.ts";

const seat = (i: number) => ({ PORT: String(3100 + i), TEE_KEY_LABEL: `production-juror-class-0-seat-${i}`, SEALED_STORE_DIR: `/data/mochi/sealed/juror-${i}`, JUROR_CLASS: "0" });

test("a juror pool needs distinct ports, key labels and sealed stores for every seat", () => {
  expect(parseSeats(JSON.stringify([seat(0), seat(1)]))).toHaveLength(2);
  expect(() => parseSeats(undefined)).toThrow("JUROR_SEATS_JSON is required");
  expect(() => parseSeats("not json")).toThrow("must be JSON");
  expect(() => parseSeats("[]")).toThrow();
  expect(() => parseSeats(JSON.stringify([seat(0), { ...seat(1), PORT: "3100" }]))).toThrow("distinct PORT");
  expect(() => parseSeats(JSON.stringify([seat(0), { ...seat(1), TEE_KEY_LABEL: seat(0).TEE_KEY_LABEL }]))).toThrow("distinct TEE_KEY_LABEL");
  expect(() => parseSeats(JSON.stringify([seat(0), { ...seat(1), SEALED_STORE_DIR: seat(0).SEALED_STORE_DIR }]))).toThrow("distinct SEALED_STORE_DIR");
  const { TEE_KEY_LABEL: _, ...unlabeled } = seat(1);
  expect(() => parseSeats(JSON.stringify([seat(0), unlabeled]))).toThrow("must set TEE_KEY_LABEL");
  expect(() => parseSeats(JSON.stringify([{ ...seat(0), PORT: 3100 }]))).toThrow();
});
