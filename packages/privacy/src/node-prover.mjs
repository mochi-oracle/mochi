// Groth16 proving runs under Node.js: snarkjs's worker-thread polyfill (`web-worker`) crashes under Bun
// ("EventTarget.dispatchEvent must be an instance of Event"), in multi- and single-thread mode alike.
// stdin: JSON { input, wasm, zkey, vkey } (circuit inputs are private: never log them)
// stdout: JSON { proof, publicSignals, verified, seconds }
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";

const request = JSON.parse(readFileSync(0, "utf8"));
const started = performance.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(request.input, request.wasm, request.zkey);
const seconds = (performance.now() - started) / 1000;
const vkey = JSON.parse(readFileSync(request.vkey, "utf8"));
const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
process.stdout.write(JSON.stringify({ proof, publicSignals, verified, seconds }));
if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
process.exit(0);
