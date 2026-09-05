# @mochi/sdk

```ts
import { MochiClient, askClaimReview, prepareClaimReview, waitForClaimReview } from "@mochi/sdk";
import { MockQuoteVerifier } from "@mochi/tee";

const client = new MochiClient({
  gatewayUrl: "https://gateway.example",
  indexerUrl: "https://indexer.example",
  quoteVerifier: new MockQuoteVerifier({ mockRootAddress: "0x0000000000000000000000000000000000000000" }),
  intakeMeasurement: "0x0000000000000000000000000000000000000000000000000000000000000000",
});
const wallet = /* configured viem WalletClient */ null as never;

// A claim review can be prepared privately for inspection without sending a transaction.
// Claim and evidence excerpts are uploaded as SUBMITTED user content; the adapter does not
// fetch source URLs or imply that they were independently verified.
const claimInput = {
  claim: "The board approved the transaction.",
  evidence: [{
    id: "minutes-1", title: "Meeting minutes", url: "https://issuer.example/minutes",
    excerpt: "The board approved the transaction at its meeting.",
  }],
  sender: "0x0000000000000000000000000000000000000001",
};
const preparedClaim = await prepareClaimReview(client, claimInput);
// Inspect preparedClaim.prepared.quote and .tx before explicitly submitting.
// const submittedClaim = await askClaimReview(client, claimInput, wallet);

// Public ask: document bytes are sealed to the attested intake key.
const publicAsk = await client.ask({
  schema: "EARNINGS", document: { bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" },
  isPublic: true, sender: "0x0000000000000000000000000000000000000001",
}, wallet);
const verdictId = await client.waitForVerdict(publicAsk.queryId);
console.log(await client.getVerdict(verdictId));

// Private ask: retain the result private key locally and decrypt after the verdict arrives.
const privateAsk = await client.ask({
  schema: "INVOICE", document: { url: "https://example.com/invoice.pdf" },
  isPublic: false, sender: "0x0000000000000000000000000000000000000001",
}, wallet);
const privateVerdictId = await client.waitForVerdict(privateAsk.queryId);
const result = await client.decryptPrivateResult(privateVerdictId, privateAsk.secrets.resultPrivateKey!);

// Verify a signed receipt and read a decoded feed value.
const receipt = await client.verifyReceipt(verdictId, { checkAnchorOnChain: true });
const latest = await client.feed("earnings@RHC", "0x" + "00".repeat(32));
console.log({ receipt, result, latest });
```

`prepareClaimReview(client, input)` creates an inspectable private `FREEFORM_FACT` query using the four-answer enum
`supported | contradicted | missing_context | insufficient_evidence`. It packages the exact claim and bounded user-supplied
evidence excerpts into deterministic text bytes. Source URLs are metadata only: the adapter never fetches them and marks
their provenance `SUBMITTED`. It defaults to private results and panel disclosure off. Preparation performs attested
intake and requests a quote, but sends no wallet transaction and collects no payment. Call
`askClaimReview(client, input, wallet)` explicitly to submit through the existing `MochiClient.ask` payment and escrow
path. `waitForClaimReview(client, queryId, resultPrivateKey)` waits for the gateway's protocol record; a `HUNG` outcome
remains `HUNG`, and a prepared/local preview is never interpreted as a verdict. It decrypts with
`MochiClient.decryptPrivateResult` and checks the answer hash before returning the answer. The result is labeled
gateway-reported; this helper does not independently verify the gateway's chain fields. Keep the key local if you need to
inspect the full private result and source spans.

Limits: claim 4,000 UTF-8 bytes; 1–5 evidence items; 18,000 bytes per excerpt; 64,000 aggregate excerpt bytes; 80,000 bytes
for the complete uploaded package; title and URL metadata at most 2,048 bytes each. URLs must be public HTTPS metadata,
but no request is made to them. This produces a structured protocol verdict over user-submitted evidence, not independent
source verification.
