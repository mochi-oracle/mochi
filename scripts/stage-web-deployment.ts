import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const requiredWebBuildFiles = [
  'web/site/postcss.config.js', 'web/site/tailwind.config.js',
  'web/site/vite.config.js', 'web/site/package.json', 'web/site/bun.lock',
  'web/site/scripts/verify-build.ts', 'web/claims-proxy.ts', 'web/deployment-config.ts', 'web/Dockerfile', 'web/Dockerfile.dockerignore',
];
export function validateWebBuildFiles(files: string[]): void {
  for (const file of requiredWebBuildFiles) if (!files.includes(file)) throw new Error(`Deployment build input missing: ${file}`);
}

function git(root: string, args: string[]): Buffer {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

export function stageWebDeployment(root: string, destination: string): void {
  const files = git(root, ['ls-tree', '-rz', '--name-only', 'HEAD']).toString().split('\0').filter(Boolean);
  validateWebBuildFiles(files);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length) throw new Error('Deployment destination must be empty');
  // Export whole tracked directories, including build configs; never glob a selection of extensions.
  const archive = git(root, ['archive', 'HEAD', '--', 'package.json', 'bun.lock', 'tsconfig.json', 'tsconfig.base.json', 'packages', 'services', 'web/site', 'web/server.ts', 'web/claims-proxy.ts', 'web/deployment-config.ts', 'web/Dockerfile', 'web/Dockerfile.dockerignore']);
  const extracted = spawnSync('tar', ['-x', '-C', destination], { input: archive });
  if (extracted.status !== 0) throw new Error('Deployment archive extraction failed');
  for (const name of ['Dockerfile', 'Dockerfile.dockerignore']) {
    const copied = spawnSync('cp', [resolve(destination, 'web', name), resolve(destination, name)]);
    if (copied.status !== 0) throw new Error(`Could not stage ${name}`);
  }
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error('usage: bun scripts/stage-web-deployment.ts <empty-directory>');
  stageWebDeployment(process.cwd(), resolve(process.argv[2]));
  console.log('Committed web deployment staged with complete build configuration.');
}
