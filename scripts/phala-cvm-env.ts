// Writes the enclave VM's encrypted environment file with a fixed set of variable NAMES in a fixed order. dstack
// measures the app definition, which includes the list of allowed environment names (not their values): deploying
// standby without MOCHI_PRODUCTION_CONFIG_JSON and production with it gives two different measurements, and a
// registry key enrolled under one can never match the other. Always deploy through this file.
//
//   bun scripts/phala-cvm-env.ts --base <protected base.env> [--config <production-runtime.json>] --out <file>
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

export const CVM_ENV_NAMES = [
  "PHALA_API_KEY",
  "MOCHI_CLAIMS_ACCESS_TOKEN",
  "MOCHI_PRODUCTION_POSTGRES_PASSWORD",
  "MOCHI_PRODUCTION_ATTESTOR_ADMIN_TOKEN",
  "MOCHI_PRODUCTION_CONFIG_JSON",
] as const;
const BASE_NAMES = CVM_ENV_NAMES.slice(0, 4);

export function renderCvmEnv(baseText: string, config?: unknown): string {
  const values = new Map<string, string>();
  for (const line of baseText.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error("base env lines must be NAME=value");
    const name = line.slice(0, eq);
    if (values.has(name)) throw new Error(`duplicate ${name}`);
    values.set(name, line.slice(eq + 1));
  }
  const unexpected = [...values.keys()].filter((name) => !(BASE_NAMES as readonly string[]).includes(name));
  if (unexpected.length) throw new Error(`unexpected env names change the measurement: ${unexpected.join(", ")}`);
  for (const name of BASE_NAMES) if (!values.get(name)) throw new Error(`base env must set ${name}`);
  const configLine = config === undefined ? "" : JSON.stringify(config);
  if (configLine.includes("\n")) throw new Error("config must serialise to one line");
  return [...BASE_NAMES.map((name) => `${name}=${values.get(name)}`), `MOCHI_PRODUCTION_CONFIG_JSON=${configLine}`].join("\n") + "\n";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const base = get("--base"), configPath = get("--config"), out = get("--out");
  if (!base || !out) throw new Error("usage: bun scripts/phala-cvm-env.ts --base <base.env> [--config <production-runtime.json>] --out <file>");
  const text = renderCvmEnv(readFileSync(base, "utf8"), configPath ? JSON.parse(readFileSync(configPath, "utf8")) : undefined);
  writeFileSync(out, text, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`wrote ${out} (${CVM_ENV_NAMES.length} names, ${configPath ? "production config" : "standby: empty config"})`);
}
