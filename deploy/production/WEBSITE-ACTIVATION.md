# Paid checkout activation and rollback

The launch input template now includes Robinhood Chain USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, listed by [Paxos](https://docs.paxos.com/guides/stablecoin/usdg/mainnet). Public RPC verification on 2026-09-28 at block 75174349 returned chain 4663, contract code present, name `Global Dollar`, symbol `USDG`, and six decimals. Recheck at deployment; this observation does not attest future proxy behavior.

Railway accepts `MOCHI_WEB_CONFIG_JSON` directly, so activation no longer needs a new image or a manually copied configuration file. Do not set it alongside the older `MOCHI_WEB_CONFIG` file path. Updating Railway variables restarts the service; it does not submit a transaction.

Keep `MOCHI_WEB_CONFIG_JSON={"enabled":false}` until the production protocol and bounded paid canary pass. This is also the website rollback setting. It hides paid checkout, but **does not pause contracts or cancel already-open reviews**. The control wallet holding the guardian role must pause QueryEscrow for a protocol incident. Keep recovery and settlement services available for existing reviews.

New deployment timelocks default to 60 seconds, with tooling limited to 0–3600 seconds. Active enclave restarts can refresh expired attestations without a governance pause/unpause when all other reviewed registry eligibility checks pass. Prepare and enroll still require paused escrow; an actual pause must be reopened through the recorded timelock delay. Keep checkout disabled until service and payment checks pass.

After activation, set these existing server-only variables to the verified production HTTPS endpoints: `MOCHI_GATEWAY_URL`, `MOCHI_INDEXER_URL`, and `RPC_URL`. Provider RPC paths may contain credentials; never put them in the public config. Then set the public config using actual deployment and enclave values:

```json
{
  "enabled": true,
  "chainId": 4663,
  "contracts": {
    "queryEscrow": "<deployment.contracts.queryEscrow>",
    "jurorRegistry": "<deployment.contracts.jurorRegistry>",
    "verdicts": "<deployment.contracts.verdicts>",
    "usdg": "<deployment.contracts.usdg>",
    "receiptAnchor": "<deployment.contracts.receiptAnchor>"
  },
  "intakeAddress": "<verified persistent intake signing address>",
  "intakeMeasurement": "<fresh verified pinned TDX measurement, 0x-prefixed bytes32>",
  "receiptPublicKey": "<indexer Ed25519 public key, 0x-prefixed bytes32>",
  "jurySizes": [3],
  "tdxAllowedTcbStatuses": ["UpToDate"]
}
```

Placeholders above are intentionally rejected. The server rejects incomplete enabled configuration, wrong chain, invalid identities/keys, unsupported jury sizes or TCB statuses, ambiguous configuration sources, and missing/insecure upstreams. Unknown fields are stripped from the browser response. Shape validation is not proof of service health, on-chain activation or current attestation.

`tdxAllowedTcbStatuses` is the Intel TCB policy the browser applies to the intake's quote. It must equal the runtime config's `tdxAllowedTcbStatuses`; `prepare-production-launch.ts` writes the same list into both files. It is optional and defaults to `["UpToDate"]`, and `/mochi-config.json` always shows the list in force. For an Intel TCB recovery, change both copies together ("Intel TCB recoveries" in [README.md](./README.md)).

## Visitor keying and limits

The website names each visitor to the CVM in a signed `X-Mochi-Visitor` header, so the CVM's per-client limits apply per visitor rather than to Railway's one egress address. It signs with a key derived from the visitor secret, which `visitorSecretFromEnv` in `services/claims/src/visitor-key.ts` names: `MOCHI_VISITOR_KEY_SECRET`, a dedicated random secret of at least 24 characters that must be the same value on Railway and in the CVM's encrypted environment. It is deliberately not the pilot invitation token, so the website never holds pilot access. Set it on Railway from the protected base env without printing it (`railway variable set MOCHI_VISITOR_KEY_SECRET --stdin`). Without it the website logs a warning and all website traffic shares one CVM client budget. The visitor in the header is a pseudonym under a random key that each website process keeps to itself, so the CVM cannot recover visitors' addresses from it, even by trying every IPv4 address.

The website keys a visitor on an `X-Forwarded-For` entry that Railway's edge writes. It trusts the header only on Railway, which it detects from `RAILWAY_ENVIRONMENT` (or `RAILWAY_ENVIRONMENT_NAME`/`RAILWAY_ENVIRONMENT_ID`); `MOCHI_WEB_TRUST_FORWARDED_FOR=1` or `0` overrides the detection. Anywhere else the header is whatever the caller sent, so the website keys on the transport peer. The visitor is the entry at `len - hops`, counting the right-most entry as 1, and on Railway `hops` is 2. Measured on 2026-10-02 with the CDN off, Railway's edge sends `<visitor>, <edge node>`, and the right-most entry names whichever of a few edge nodes took the request. The earlier right-most keying therefore put every visitor into one of about four shared buckets, so anyone could exhaust the per-client limits for everyone and real users could get 429s they did not cause. The edge also rewrites a caller's own header rather than appending to it: a request with `X-Forwarded-For: 192.0.2.1` still arrives with two entries. If Railway switches to appending, the caller's entries come first (`192.0.2.1, <visitor>, <edge node>`), so position `len - 2` is still the visitor; a caller can add entries only on the left. A header with fewer than `hops` entries keys as `invalid`, one budget shared by all such requests, and never falls back to one of its entries, to `X-Real-IP` or to the peer. `MOCHI_WEB_FORWARDED_HOPS` (1 to 4) overrides the hop count, and any other value stops the website at startup. Railway's CDN would add a hop of its own; the checks below catch that and any other change in what the edge sends.

Limits (numbers and reasoning in `web/server.ts`): one paid check costs at most about 120 read-only RPC calls and peaks at about 30 a minute while waiting for the verdict, with one batched request every 4 s. `/rpc` allows each address (IPv6: each /56) 120 calls a minute and 3000 an hour, enough for four checks waiting at once behind one NAT address. In total it allows 6000 a minute and 180000 an hour. A browser over a limit waits for `Retry-After` and polls on; it does not fail. `/rpc` reads at most 64 KiB, `/api/v1/query` 64 KiB and `/api/v1/intake/upload` 1 MiB, and at most 32 MiB of request bodies are held at once. Intel collateral for an FMSPC that PCS has served once, or that is pinned, is never charged against the small miss budget. The default pin is `20A06F000000`, the live CVM's platform from the verified identity report. `MOCHI_WEB_PINNED_FMSPCS` (comma-separated) replaces the pin list if the CVM moves to another platform.

## Activation checks for visitor keying

Run these against the deployed website before enabling checkout. Use one network unless a step says otherwise. Tags are salted per process, so run steps 2–6 without a redeploy in between, against one replica: each replica has its own tags and its own in-memory limits. `/health` shows only address classes (`public`, `private`, `loopback`, `invalid`) and 8-hex-digit salted tags, never an address or header value. `forwardedFor.fromRight` lists at most four entries, right-most first, so entry `hops - 1` is the one keyed on.

```sh
W=https://<website>
F='.client | {trust: .trustForwardedFor, source: .keySource, hops: .forwardedFor.hops, entries: .forwardedFor.entries, keyTag, selected: .forwardedFor.fromRight[.forwardedFor.hops - 1].tag, rightmost: .forwardedFor.fromRight[0].tag, classes: [.forwardedFor.fromRight[].class], realIp, realIpTag}'
```

1. **Railway CDN is off.** In the Railway dashboard, confirm that the website service's CDN setting is disabled. Record it in the launch evidence.
2. **Two entries, and a key that does not follow the edge node.** With no `X-Forwarded-For` of your own:

   ```sh
   for i in $(seq 8); do curl -s "$W/health" | jq -c "$F"; done
   ```

   Every line must look like this, with `keyTag` the same on every line and equal to `selected`:

   ```json
   {"trust":true,"source":"forwarded","hops":2,"entries":2,"keyTag":"5f0c9e21","selected":"5f0c9e21","rightmost":"a83d17b0","classes":["public","public"],"realIp":"public","realIpTag":"5f0c9e21"}
   ```

   `rightmost` may vary between lines: it is the edge node. `entries` other than `2`, or a `keyTag` that varies, fails the check.
3. **A caller's own header does not move the key.**

   ```sh
   for xff in '192.0.2.1' '192.0.2.1, 198.51.100.1'; do curl -s -H "X-Forwarded-For: $xff" "$W/health" | jq -c "$F"; done
   ```

   `keyTag` must equal step 2's on both lines. `entries` is `2` if Railway rewrote the header, or `3` and then `4` if it appended to it. When it appended, `hops` must still select the same entry: `selected` equals step 2's `keyTag`, and the caller's entries sit to its left, in `fromRight[2]` and beyond.
4. **Visitors are told apart.** Run step 2's command from a second network, such as a phone hotspot. `keyTag` must be stable there too, and differ from the first network's.
5. **X-Real-IP agrees (optional).** In step 2, `realIpTag` equal to `keyTag` means Railway's `X-Real-IP` names the same visitor. The website reports `X-Real-IP` only for this comparison and never keys on it. `curl -s -H 'X-Real-IP: 192.0.2.7' "$W/health" | jq -c "$F"` shows whether Railway overwrites a caller's value: `realIpTag` still equal to `keyTag` means it does. A different or absent `realIpTag` does not fail activation.
6. **Same visitor secret on both servers.** `bun scripts/visitor-key-check.ts https://<website>/health https://<cvm-host>/production/status < <protected secret file>` must print `match` twice and exit 0. Neither server publishes anything derived from the secret; the script proves knowledge of it with a fresh MAC, and each server answers only `match` or `mismatch`.
7. **TCB policy.** `/mochi-config.json` shows `tdxAllowedTcbStatuses` equal to the runtime config's list (`["UpToDate"]` at launch).

**If any of steps 2–4 is unstable or unexpected, stop.** Set `MOCHI_WEB_TRUST_FORWARDED_FOR=0` and keep it until the cause is understood; do not change `MOCHI_WEB_FORWARDED_HOPS` just to make a check pass. With forwarding off, the website keys on the transport peer, which on Railway is the edge's internal address. Per-client limits are then coarse, since visitors share buckets, but never caller-chosen, and the global limits in `web/server.ts` still bound all traffic.

## Checkout canary

Verify `/health` reports `configured:true`, `/mochi-config.json` contains only these public values and `/rpc`, and Chrome `/check/` can quote, submit and recover the bounded canary. Confirm verdict, receipt, debit and settlement against the actual chain. Keep `jurySizes:[3]` for launch; the nine registered jurors are the network pool, not a nine-juror price for every review.

The research-preview service and buyback worker have independent switches. Do not remove the research invitation gate or turn on the purchase worker as a side effect of enabling checkout. Token confirmation alone does not establish a funded, approved swap route. Developer fees remain excluded and burns remain manual.
