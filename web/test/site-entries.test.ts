import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

const src = (name: string) => readFileSync(new URL(`../site/src/${name}`, import.meta.url), 'utf8');

test('entries that load the live client switch Zod to jitless mode before any other module runs', () => {
  // Zod probes `new Function` while building object schemas unless jitless is set first; the site CSP reports it.
  expect(src('zod-jitless.js')).toMatch(/^config\(\{ jitless: true \}\);$/m);
  for (const entry of ['claims.jsx', 'dashboard.jsx']) expect(src(entry).match(/^import\s[^;]+;/m)?.[0]).toBe("import './zod-jitless.js';");
  const dist = new URL('../site/dist/assets/', import.meta.url);
  const chunks = readdirSync(dist).filter(name => /^live-client-.+\.js$/.test(name));
  expect(chunks.length).toBe(1);
  expect(readFileSync(new URL(chunks[0]!, dist), 'utf8')).toContain('jitless:!0');
});
