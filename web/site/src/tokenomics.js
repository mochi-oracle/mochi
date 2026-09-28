import '@fontsource-variable/hanken-grotesk';
import './styles/tokenomics.css';
import { illustrateReviewEconomics } from './tokenomics-policy.js';
import { animateCalculation } from './tokenomics-motion.js';

const fields = { total: 'total-revenue', jurors: 'juror-revenue', panel: 'panel-revenue', remainder: 'protocol-revenue', eligible: 'purchase-budget' };
const format = amount => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: amount % 10_000n === 0n ? 2 : 4 }).format(Number(amount) / 1_000_000);
function update() {
  try {
    const plan = illustrateReviewEconomics(document.querySelector('#review-count').value, document.querySelector('#obligations').value);
    document.querySelector('#calculator-error').textContent = '';
    for (const [field, id] of Object.entries(fields)) document.getElementById(id).textContent = format(plan[field]);
    document.querySelector('#batch-status').textContent = plan.minimumBatchReached ? '$25 illustration threshold reached. Execution checks still apply; no purchase is initiated.' : plan.eligible === 0n ? 'No surplus in this illustration. Nothing is allocated to purchases.' : 'Below the proposed $25 minimum. Eligible funds would accumulate for a later batch.';
  } catch (error) {
    document.querySelector('#calculator-error').textContent = error.message;
    for (const id of Object.values(fields)) document.getElementById(id).textContent = '—';
    document.querySelector('#batch-status').textContent = 'Correct the inputs to calculate an illustration.';
  }
}
document.querySelector('#economics-form').addEventListener('input', () => { update(); animateCalculation(); });
document.querySelector('#economics-form').addEventListener('submit', event => event.preventDefault());
update();

const activityState = document.querySelector('#activity-state');
const activityData = document.querySelector('#activity-data');
const activitySection = document.querySelector('#activity');
const activityTitle = document.querySelector('#activity-state-title');
const activityCopy = document.querySelector('#activity-state-copy');
const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;
const ATOMIC = /^(0|[1-9]\d*)$/;
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;

function formatAtomic(value, decimals, unit) {
  if (typeof value !== 'string' || !ATOMIC.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('invalid amount');
  const digits = value.padStart(decimals + 1, '0');
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(BigInt(whole));
  return `${grouped}${fraction ? `.${fraction}` : ''} ${unit}`;
}

function validateLiveReport(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return { state: 'unavailable' };
  if (payload.status === 'awaiting_token') return { state: 'awaiting_token' };
  if (payload.status === 'unavailable') return { state: 'unavailable' };
  if (payload.status === 'stale') return { state: 'stale' };
  const report = payload.status === 'ready' ? payload.report : null;
  if (!report || report.status !== 'complete' || !report.asOf || !report.accounting || !report.assets || !report.treasury || !report.purchasedToken) return { state: 'unavailable' };
  const generated = Date.parse(report.asOf.generatedAt);
  if (!Number.isFinite(generated) || generated > now + 5 * 60 * 1000 || now - generated > MAX_REPORT_AGE_MS) return { state: 'stale' };
  const accounting = report.accounting;
  const burns = report.purchasedToken.manualBurnEvidence;
  const values = [accounting.totalVerifiedSettledReviewRevenueAtomic, accounting.purchasedReviewFundsAtomic,
    accounting.reservedOrInFlightReviewFundsAtomic, report.purchasedToken.purchasedAtomic,
    burns?.nativeSupplyBurnAtomic, burns?.deadAddressTransferAtomic, burns?.awaitingManualBurnAtomic];
  if (report.schema !== 'mochi-public-revenue-report-v1' || !Number.isSafeInteger(report.asOf.chainId) ||
      typeof report.asOf.blockNumber !== 'string' || !ATOMIC.test(report.asOf.blockNumber) ||
      !HASH.test(report.asOf.blockHash || '') || !ADDRESS.test(report.assets.reviewRevenue?.address || '') ||
      !ADDRESS.test(report.assets.purchasedToken?.address || '') || !ADDRESS.test(report.treasury.address || '') ||
      !ADDRESS.test(report.purchasedToken.purchaseRecipient || '') || !Number.isInteger(report.assets.reviewRevenue.decimals) ||
      !Number.isInteger(report.assets.purchasedToken.decimals) || values.some(value => typeof value !== 'string' || !ATOMIC.test(value)) ||
      !Array.isArray(accounting.settlements) || accounting.settlements.some(row => !HASH.test(row?.transactionHash || '') || !HASH.test(row?.blockHash || '') ||
        !Number.isSafeInteger(row?.logIndex) || !ATOMIC.test(row?.blockNumber || '') || !ATOMIC.test(row?.amountAtomic || '')) ||
      !Array.isArray(burns.records) || burns.records.some(row => !HASH.test(row?.transactionHash || '') || !Number.isSafeInteger(row?.logIndex) || !ATOMIC.test(row?.blockNumber || '') || !ATOMIC.test(row?.amountAtomic || ''))) {
    return { state: 'unavailable' };
  }
  return { state: 'ready', report };
}

const statusCopy = {
  awaiting_token: ['Token details are awaiting confirmation.', 'The token has not launched. No balances or activity totals are available yet.'],
  unavailable: ['Live accounting is unavailable.', 'We could not verify a complete report. No balances are shown; try again later.'],
  stale: ['The report is out of date.', 'The last report is older than 24 hours or its timestamp is invalid. No cached balances are shown.'],
};

function showActivityState(state) {
  const [title, copy] = statusCopy[state] || statusCopy.unavailable;
  activityTitle.textContent = title;
  activityCopy.textContent = copy;
  activityState.hidden = false;
  activityData.hidden = true;
}

function text(id, value) { document.getElementById(id).textContent = value; }
function renderActivity(report) {
  const accounting = report.accounting;
  const token = report.assets.purchasedToken;
  const usd = report.assets.reviewRevenue;
  const burns = report.purchasedToken.manualBurnEvidence;
  text('activity-settled', formatAtomic(accounting.totalVerifiedSettledReviewRevenueAtomic, usd.decimals, 'USDG'));
  text('activity-purchased-usdg', formatAtomic(accounting.purchasedReviewFundsAtomic, usd.decimals, 'USDG'));
  text('activity-purchased-mochi', formatAtomic(report.purchasedToken.purchasedAtomic, token.decimals, 'MOCHI'));
  text('activity-reserved', formatAtomic(accounting.reservedOrInFlightReviewFundsAtomic, usd.decimals, 'USDG'));
  text('activity-native-burn', formatAtomic(burns.nativeSupplyBurnAtomic, token.decimals, 'MOCHI'));
  text('activity-dead-transfer', formatAtomic(burns.deadAddressTransferAtomic, token.decimals, 'MOCHI'));
  text('activity-awaiting', formatAtomic(burns.awaitingManualBurnAtomic, token.decimals, 'MOCHI'));
  const date = new Date(report.asOf.generatedAt);
  text('activity-as-of', `As of ${new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`);
  text('activity-checkpoint', `Finalized block ${report.asOf.blockNumber} · chain ${report.asOf.chainId}`);
  const list = document.querySelector('#activity-receipt-list');
  list.replaceChildren();
  for (const receipt of accounting.settlements.slice(-10).reverse()) {
    const row = document.createElement('li');
    const amount = document.createElement('span');
    amount.textContent = formatAtomic(receipt.amountAtomic, usd.decimals, 'USDG');
    const ref = document.createElement('code');
    ref.textContent = `${receipt.transactionHash.slice(0, 10)}…${receipt.transactionHash.slice(-8)} · log ${receipt.logIndex}`;
    ref.setAttribute('aria-label', `Transaction ${receipt.transactionHash}, log ${receipt.logIndex}`);
    row.append(amount, ref);
    list.append(row);
  }
  if (!accounting.settlements.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No verified settlement receipts in this reporting period.';
    list.append(empty);
  }
  activityState.hidden = true;
  activityData.hidden = false;
}

async function loadActivity() {
  activitySection.setAttribute('aria-busy', 'true');
  showActivityState('unavailable');
  try {
    const response = await fetch('/api/tokenomics/report', { method: 'GET', cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('report unavailable');
    const result = validateLiveReport(await response.json());
    if (result.state !== 'ready') showActivityState(result.state);
    else renderActivity(result.report);
  } catch {
    showActivityState('unavailable');
  } finally {
    activitySection.setAttribute('aria-busy', 'false');
  }
}

document.querySelector('#activity-refresh').addEventListener('click', loadActivity);
loadActivity();
