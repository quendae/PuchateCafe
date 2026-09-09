import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/src', { recursive: true });
await Promise.all([
  cp('index.html', 'dist/index.html'),
  cp('styles.css', 'dist/styles.css'),
  cp('menu.css', 'dist/menu.css'),
  cp('assets', 'dist/assets', { recursive: true }),
  cp('src', 'dist/src', { recursive: true }),
]);
console.log('Gotowe: dist/');
