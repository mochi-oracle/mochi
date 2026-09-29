import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const outputIndex = Bun.argv.indexOf("--out");
const out = resolve(outputIndex >= 0 ? Bun.argv[outputIndex + 1]! : "dist/mochi-runtime");
const servicesDir = resolve(out, "services");
const migrationsDir = resolve(out, "migrations");
const services = ["intake", "consensus", "juror", "gateway", "indexer", "attestor", "orchestrator"] as const;
const entrypoints = [...services.map((service) => [service, resolve(root, `services/${service}/src/main.ts`)] as const), ["juror-pool", resolve(root, "services/juror/src/pool.ts")] as const, ["postman", resolve(root, "scripts/asp-postman.ts")] as const];
await mkdir(out, { recursive: true });
if ((await readdir(out)).length !== 0) throw new Error(`output directory must be empty: ${out}`);
await mkdir(servicesDir, { recursive: true });
const stagingDir = await mkdtemp(join(tmpdir(), "mochi-runtime-build-"));
for (const [service, entrypoint] of entrypoints) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: stagingDir,
    naming: `${service}.js`,
    target: "bun",
    format: "esm",
    minify: true,
    sourcemap: "none",
    env: "disable",
  });
  if (!result.success) { await rm(stagingDir, { recursive: true, force: true }); throw new AggregateError(result.logs, `failed to build ${service}`); }
  const bundle = result.outputs.find((file) => file.path.endsWith(`${service}.js`));
  if (!bundle) { await rm(stagingDir, { recursive: true, force: true }); throw new Error(`missing built ${service} bundle`); }
  await rename(bundle.path, resolve(servicesDir, `${service}.mjs`));
}
await cp(resolve(root, "packages/db/migrations"), migrationsDir, { recursive: true });
await rm(stagingDir, { recursive: true, force: true });
const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: out, onlyFiles: true }));
const bytes = await Promise.all(files.map(async (file) => (await Bun.file(resolve(out, file)).arrayBuffer()).byteLength));
process.stdout.write(JSON.stringify({ output: out, services: entrypoints.map(([service]) => `services/${service}.mjs`), migrationCount: (await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: migrationsDir, onlyFiles: true }))).length, totalBytes: bytes.reduce((sum, count) => sum + count, 0) }) + "\n");
