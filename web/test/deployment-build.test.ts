import { expect, test } from 'bun:test';
import { requiredWebBuildFiles, validateWebBuildFiles } from '../../scripts/stage-web-deployment';
import { verifyStyles } from '../site/scripts/verify-build';

test('deployment refuses the missing CSS build configs that broke production', () => {
  expect(() => validateWebBuildFiles([...requiredWebBuildFiles])).not.toThrow();
  for (const file of ['web/site/postcss.config.js', 'web/site/tailwind.config.js']) {
    expect(() => validateWebBuildFiles(requiredWebBuildFiles.filter(path => path !== file))).toThrow(file);
  }
});

test('production CSS must contain compiled layout utilities, not raw directives', () => {
  expect(() => verifyStyles('@tailwind base; @tailwind utilities;')).toThrow('Unprocessed');
  expect(() => verifyStyles('.hero{opacity:1}')).toThrow('Missing layout');
  expect(() => verifyStyles('.fixed{position:fixed}.w-screen{width:100vw}.h-screen{height:100vh}')).not.toThrow();
});
