// Illustration only. Atomic USDG arithmetic; never a wallet or execution policy.
export function illustrateReviewEconomics(reviews, obligations) {
  if (!/^\d{1,7}$/.test(reviews) || Number(reviews) > 1_000_000) throw new Error('Enter a whole review count between 0 and 1,000,000.');
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(obligations) || Number(obligations) > 1_000_000_000) throw new Error('Enter obligations between 0 and 1,000,000,000 USDG, with at most two decimals.');
  const [whole, fraction = ''] = obligations.split('.');
  const count = BigInt(reviews);
  const held = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(2, '0')) * 10_000n;
  const remainder = count * 7_500n;
  const eligible = remainder > held ? remainder - held : 0n;
  return { total: count * 50_000n, jurors: count * 40_000n, panel: count * 2_500n, remainder, eligible, minimumBatchReached: eligible >= 25_000_000n };
}
