# Invitation research service

This deploys the usable, CA-independent claim-research API on an existing Phala CVM. It replaces the bounded fixture rehearsal on port 8080. It uses the same reviewed Llama, Nemotron and Gemma confidential inference routes, accepts a claim plus public HTML/text source links, and requires a private invitation token. No wallet, token, customer payment, settlement or purchase worker is enabled.

The Railway website forwards only the approved `/api/claims/` routes to `MOCHI_CLAIMS_UPSTREAM`, a fixed HTTPS origin. It forwards invitation and review-owner tokens, never browser cookies or unrelated authorization. Provider credentials remain in the Phala encrypted environment. Railway can see plaintext research requests in this pilot: hosting the backend in a CVM is **not** end-to-end confidential client execution. Results retain `unattested_research`; the separately verified encrypted protocol remains the paid-production integration.

Build `bun scripts/phala-claims-service.ts --build-artifact`, then commit source and artifact with the neutral identity and use the guarded publisher. Render from the immutable published revision and printed artifact digest:

```sh
bun scripts/phala-claims-service.ts --revision <40-hex-sha> --sha256 <64-hex-digest> --out /tmp/claims-compose.yml
```

Supply `PHALA_API_KEY`, `MOCHI_CLAIMS_ACCESS_TOKEN` and `MOCHI_VISITOR_KEY_SECRET` (the website's per-visitor signing secret, the same value as on Railway) through the existing Phala encrypted environment, always via `scripts/phala-cvm-env.ts`. The invitation and the visitor secret must each have at least 24 characters. Never put any of these values in Git, command-line arguments, URLs or logs. Deploy only to the already approved VM; the renderer cannot provision capacity. The provider-side $10 limit remains the actual budget control. Forty daily actions allow at most twenty newly researched/reviewed claims; failed actions count. This is a volume guard, not a dollar cap.

A named volume `mochi-claims-data` on the CVM's existing disk retains public shares and aggregate usage in SQLite across container replacement. One replica only. Private evidence expires after thirty minutes and results after sixty minutes in memory; restart loses private sessions. Export results before a restart. Docker volume persistence is not a backup or disaster-recovery guarantee. A deployment must preserve the volume. Never run volume deletion during upgrades.

`GET /health` verifies startup and the configured handler; `GET /api/claims/config` exposes the unpaid invitation mode. Test unauthorized POST rejection, a complete authenticated research/review, source/citation handling and the Railway route after deployment. Model requests enforce attested routing and receipt verification; no non-confidential fallback exists. Search discovery is optional and remains unconfigured until a search provider is supplied: users must include source links.

An existing external monitor can run the redacted public prelaunch probe:

```sh
bun scripts/prelaunch-health.ts https://web-production-fb1a0.up.railway.app
```

Exit 0 means `/health`, unpaid invitation configuration, and tokenomics report status passed; exit 1 means at least one check failed; exit 2 means the origin argument is invalid. The probe sends no credentials and makes no inference request. Alert on any nonzero result, repeated Docker healthcheck failures, a disabled/changed invitation configuration, or a report status other than `awaiting_token` or `ready`. This probe does not expose provider counters or billing data; a review containing a juror failure or timeout remains unresolved, and any charge without provider usage remains unknown. The retained small evaluations record one 45-second timeout and three inference failures among 36 requests, which makes provider delivery a launch smoke-test condition. Do not retry failed jurors automatically or promote partial agreement. The command is ready for an existing monitor. No external monitor, notification route, or offsite backup destination is configured by this repository.

## Claims database backup and recovery

The SQLite file at `/data/claims.sqlite` stores public shares and aggregate daily usage. It does not contain private evidence, but it is still an audit record and should be handled as operational data. The backup tool creates a consistent SQLite snapshot (including committed WAL content), checks integrity, writes new files with mode `0600`, and refuses to overwrite a source or destination. Exercise it only with a local/synthetic fixture before using it operationally:

```sh
bun scripts/claims-sqlite-backup.ts backup ./claims.sqlite ./claims-backup.sqlite
bun scripts/claims-sqlite-backup.ts verify ./claims-backup.sqlite
bun scripts/claims-sqlite-backup.ts restore ./claims-backup.sqlite ./claims-restored.sqlite
```

For the existing Phala volume, run the same script from a maintenance container on the existing CVM. The service uses `oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`; mount the checked-out script read-only and use a protected backup directory on the CVM:

```sh
docker run --rm --network none --entrypoint bun \
  -v mochi-claims-data:/data:ro \
  -v "$PWD/scripts/claims-sqlite-backup.ts:/tool.ts:ro" \
  -v "$BACKUP_DIR:/backup:rw" \
  oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 \
  /tool.ts backup /data/claims.sqlite "/backup/claims-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
```

Run `verify` on the resulting new backup path, then transfer it to the team's approved offsite encrypted storage. This process is manual; no schedule, offsite target, or restore monitor is configured.

To restore, stop `claims-research` first so there are no open SQLite handles. Run `restore` from the maintenance container with the volume mounted writable and backup directory read-only; use a new target such as `/data/claims-restored.sqlite`:

```sh
docker compose stop claims-research
docker run --rm --network none --entrypoint bun \
  -v mochi-claims-data:/data:rw \
  -v "$PWD/scripts/claims-sqlite-backup.ts:/tool.ts:ro" \
  -v "$BACKUP_DIR:/backup:ro" \
  oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 \
  /tool.ts restore /backup/claims-backup.sqlite /data/claims-restored.sqlite
```

After the command reports integrity and table counts, retain the current `/data/claims.sqlite` under a dated recovery name, move the restored file into place, then start the service and verify the three public probe endpoints. Never copy a backup over an active database or remove the named volume during upgrades. The SQLite tool never deletes or overwrites an existing database; operator file moves are an explicit recovery step. Reconcile restored accounting data against chain settlement records before any treasury decision.

The process restarts on failure and stays online until the operator stops the existing VM. To pause new research, remove the upstream configuration or stop the VM; existing public shares then become unavailable. Rollback uses a previously reviewed immutable compose without deleting the named volume. Paid access remains disabled independently of research availability.
