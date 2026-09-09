import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

async function expectFile(path) {
  const info = await stat(path);
  assert.equal(info.isFile(), true, `${path} should be a file`);
  assert.ok(info.size > 0, `${path} should not be empty`);
}

test('production build contains every local asset required by the redesigned menu', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'pipe' });

  await expectFile('dist/index.html');
  await expectFile('dist/styles.css');
  await expectFile('dist/menu.css');
  await expectFile('dist/src/menu-experience.js');

  const menuSource = await readFile('dist/src/menu-experience.js', 'utf8');
  const referencedAssets = [...new Set(menuSource.match(/assets\/[A-Za-z0-9_./-]+\.(?:webp|png|jpg|jpeg|svg)/g) ?? [])];
  assert.ok(referencedAssets.length >= 5, 'menu should reference its card artwork');

  for (const asset of referencedAssets) await expectFile(`dist/${asset}`);
});
