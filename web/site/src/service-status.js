// Status labels that must follow live service health instead of hard-coded copy. Markup:
//   <dd data-service-status="research" data-available="Live · unpaid" data-unavailable="Unavailable">Checking…</dd>
// A label shows its available text only after a 2xx JSON response that reports enabled:true. Errors, timeouts,
// non-2xx responses and malformed bodies all show the unavailable text. Only the enabled flag is read.
export const SERVICE_SOURCES = Object.freeze({
  research: '/api/claims/config',
  paid: '/mochi-config.json',
});

export async function serviceAvailable(source, { fetcher = fetch, timeoutMs = 5000 } = {}) {
  const url = SERVICE_SOURCES[source];
  if (!url) return false;
  try {
    const response = await fetcher(url, { cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.enabled === true;
  } catch {
    return false;
  }
}

/** Settles every [data-service-status] label under root; each source is requested once. */
export async function applyServiceStatus(root = document, options = {}) {
  const labels = [...root.querySelectorAll('[data-service-status]')];
  const sources = [...new Set(labels.map(label => label.dataset.serviceStatus))];
  const results = new Map(await Promise.all(sources.map(async source => [source, await serviceAvailable(source, options)])));
  for (const label of labels) {
    const available = results.get(label.dataset.serviceStatus) === true;
    label.textContent = available ? label.dataset.available : label.dataset.unavailable;
    label.dataset.state = available ? 'available' : 'unavailable';
  }
  return Object.fromEntries(results);
}
