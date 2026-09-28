# Invitation research service

This deploys the usable, CA-independent claim-research API on an existing Phala CVM. It replaces the bounded fixture rehearsal on port 8080. It uses the same reviewed Llama, Nemotron and Gemma confidential inference routes, accepts a claim plus public HTML/text source links, and requires a private invitation token. No wallet, token, customer payment, settlement or purchase worker is enabled.

The Railway website forwards only the approved `/api/claims/` routes to `MOCHI_CLAIMS_UPSTREAM`, a fixed HTTPS origin. It forwards invitation and review-owner tokens, never browser cookies or unrelated authorization. Provider credentials remain in the Phala encrypted environment. Railway can see plaintext research requests in this pilot: hosting the backend in a CVM is **not** end-to-end confidential client execution. Results retain `unattested_research`; the separately verified encrypted protocol remains the paid-production integration.

Build `bun scripts/phala-claims-service.ts --build-artifact`, then commit source and artifact with the neutral identity and use the guarded publisher. Render from the immutable published revision and printed artifact digest:

```sh
bun scripts/phala-claims-service.ts --revision <40-hex-sha> --sha256 <64-hex-digest> --out /tmp/claims-compose.yml
```

Supply `PHALA_API_KEY` and `MOCHI_CLAIMS_ACCESS_TOKEN` through the existing Phala encrypted environment. The invitation must have at least 24 characters. Never put either value in Git, command-line arguments, URLs or logs. Deploy only to the already approved VM; the renderer cannot provision capacity. The provider-side $10 limit remains the actual budget control. Forty daily actions allow at most twenty newly researched/reviewed claims; failed actions count. This is a volume guard, not a dollar cap.

A named volume `mochi-claims-data` on the CVM's existing disk retains public shares and aggregate usage in SQLite across container replacement. One replica only. Private evidence expires after thirty minutes and results after sixty minutes in memory; restart loses private sessions. Export results before a restart. Docker volume persistence is not a backup or disaster-recovery guarantee. A deployment must preserve the volume. Never run volume deletion during upgrades.

`GET /health` verifies startup and the configured handler; `GET /api/claims/config` exposes the unpaid invitation mode. Test unauthorized POST rejection, a complete authenticated research/review, source/citation handling and the Railway route after deployment. Model requests enforce attested routing and receipt verification; no non-confidential fallback exists. Search discovery is optional and remains unconfigured until a search provider is supplied: users must include source links.

The process restarts on failure and stays online until the operator stops the existing VM. To pause new research, remove the upstream configuration or stop the VM; existing public shares then become unavailable. Rollback uses a previously reviewed immutable compose without deleting the named volume. Paid access remains disabled independently of research availability.
