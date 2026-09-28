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
