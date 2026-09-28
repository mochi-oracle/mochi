import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function verifyStyles(css: string): void {
  if (/@tailwind\b/.test(css)) throw new Error('Unprocessed Tailwind directives in production CSS');
  for (const selector of ['fixed', 'w-screen', 'h-screen']) {
    if (!new RegExp(`\\.${selector}\\s*[{,]`).test(css)) throw new Error(`Missing layout utility: ${selector}`);
  }
}

export function verifyBuild(directory: string): void {
  const files = readdirSync(join(directory, 'assets')).filter(name => name.endsWith('.css'));
  if (!files.length) throw new Error('Production CSS is missing');
  verifyStyles(files.map(name => readFileSync(join(directory, 'assets', name), 'utf8')).join('\n'));
}

if (import.meta.main) {
  verifyBuild(resolve('dist'));
  console.log('Production CSS verified: Tailwind compiled and layout utilities present.');
}
