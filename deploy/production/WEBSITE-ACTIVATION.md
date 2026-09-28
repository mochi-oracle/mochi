# Paid checkout activation and rollback

The launch input template now includes Robinhood Chain USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, listed by [Paxos](https://docs.paxos.com/guides/stablecoin/usdg/mainnet). Public RPC verification on 2026-09-28 at block 75174349 returned chain 4663, contract code present, name `Global Dollar`, symbol `USDG`, and six decimals. Recheck at deployment; this observation does not attest future proxy behavior.

Railway accepts `MOCHI_WEB_CONFIG_JSON` directly, so activation no longer needs a new image or a manually copied configuration file. Do not set it alongside the older `MOCHI_WEB_CONFIG` file path. Updating Railway variables restarts the service; it does not submit a transaction.

Keep `MOCHI_WEB_CONFIG_JSON={"enabled":false}` until the production protocol and bounded paid canary pass. This is also the website rollback setting. It hides paid checkout, but **does not pause contracts or cancel already-open reviews**. The independent guardian must pause QueryEscrow for a protocol incident. Keep recovery and settlement services available for existing reviews.

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
  "jurySizes": [3]
}
```

Placeholders above are intentionally rejected. The server rejects incomplete enabled configuration, wrong chain, invalid identities/keys, unsupported jury sizes, ambiguous configuration sources, and missing/insecure upstreams. Unknown fields are stripped from the browser response. Shape validation is not proof of service health, on-chain activation or current attestation.

Verify `/health` reports `configured:true`, `/mochi-config.json` contains only these public values and `/rpc`, and Chrome `/check/` can quote, submit and recover the bounded canary. Confirm verdict, receipt, debit and settlement against the actual chain. Keep `jurySizes:[3]` for launch; the nine registered jurors are the network pool, not a nine-juror price for every review.

The research-preview service and buyback worker have independent switches. Do not remove the research invitation gate or turn on the purchase worker as a side effect of enabling checkout. Token confirmation alone does not establish a funded, approved swap route. Developer fees remain excluded and burns remain manual.
