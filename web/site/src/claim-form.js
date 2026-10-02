// Checks for the paid claim-check form that run in the page before the wallet is asked to connect. They use the
// protocol client's own limits and accept exactly what its validateEvidence accepts, but report each problem
// against the field it belongs to so the form can show it there and focus it.
import { CLAIM_EVIDENCE_LIMITS } from './claim-protocol-client.js';

export const checkLimits = CLAIM_EVIDENCE_LIMITS;
const encoder = new TextEncoder();

/** Size in UTF-8 bytes, the unit the protocol limits are expressed in. */
export const utf8Bytes = value => typeof value === 'string' ? encoder.encode(value).byteLength : 0;
export const formatBytes = value => value.toLocaleString('en-US');
export const excerptBytesTotal = sources => sources.reduce((total, source) => total + utf8Bytes(source?.text), 0);

/** Why a submitted source link would be refused, or '' if it is accepted. The link is a label; it is never fetched. */
export function sourceLinkProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Enter the source’s HTTPS link.';
  let url;
  try { url = new URL(value); } catch { return 'Enter a full link that starts with https://.'; }
  if (url.protocol !== 'https:') return 'Use an HTTPS link (https://…).';
  if (url.username || url.password) return 'Remove the user name or password from the link.';
  if (utf8Bytes(value) > checkLimits.urlBytes) return `Keep the link within ${formatBytes(checkLimits.urlBytes)} UTF-8 bytes.`;
  return '';
}

/**
 * Every problem with a paid-check draft, in form order, so the first one names the field to focus. Each problem is
 * `{ field, index, message }`: field is 'claim', 'title', 'url', 'text', 'total' (all excerpts together) or 'sources'
 * (the number of sources); index is the source position, or -1. A 'total' problem also gives `focusIndex`, the
 * largest excerpt. An empty list means the protocol client accepts the same claim and sources.
 */
export function checkFormProblems({ claim, sources }) {
  const problems = [];
  const add = (field, index, message, extra) => problems.push({ field, index, message, ...extra });
  const claimSize = utf8Bytes(claim);
  if (typeof claim !== 'string' || !claim.trim()) add('claim', -1, 'Enter the exact claim to check.');
  else if (claimSize > checkLimits.claimBytes) add('claim', -1, `The claim is ${formatBytes(claimSize)} UTF-8 bytes; the limit is ${formatBytes(checkLimits.claimBytes)}. Shorten it by ${formatBytes(claimSize - checkLimits.claimBytes)}.`);
  const list = Array.isArray(sources) ? sources : [];
  list.forEach((source, index) => {
    const title = source?.title, text = source?.text;
    if (typeof title !== 'string' || !title.trim()) add('title', index, 'Give this source a title.');
    else if (utf8Bytes(title) > checkLimits.titleBytes) add('title', index, `Keep the title within ${formatBytes(checkLimits.titleBytes)} UTF-8 bytes.`);
    const link = sourceLinkProblem(source?.url);
    if (link) add('url', index, link);
    const size = utf8Bytes(text);
    if (typeof text !== 'string' || !text.trim()) add('text', index, 'Paste the exact excerpt the jurors should read.');
    else if (size > checkLimits.excerptBytes) add('text', index, `This excerpt is ${formatBytes(size)} UTF-8 bytes; the limit is ${formatBytes(checkLimits.excerptBytes)}. Shorten it by ${formatBytes(size - checkLimits.excerptBytes)}.`);
  });
  const total = excerptBytesTotal(list);
  if (total > checkLimits.aggregateBytes) {
    const focusIndex = list.reduce((best, source, index) => utf8Bytes(source?.text) > utf8Bytes(list[best]?.text) ? index : best, 0);
    add('total', -1, `Together the excerpts are ${formatBytes(total)} UTF-8 bytes; the limit is ${formatBytes(checkLimits.aggregateBytes)}. Shorten or remove excerpts by ${formatBytes(total - checkLimits.aggregateBytes)}.`, { focusIndex });
  }
  if (list.length < checkLimits.minSources || list.length > checkLimits.maxSources) add('sources', -1, `Add between ${checkLimits.minSources} and ${checkLimits.maxSources} sources.`);
  return problems;
}

/** True when the form holds text the visitor typed. Whitespace alone does not count. */
export function hasCheckDraft(claim, sources) {
  const filled = value => typeof value === 'string' && value.trim() !== '';
  return filled(claim) || (Array.isArray(sources) && sources.some(source => filled(source?.title) || filled(source?.url) || filled(source?.text)));
}
