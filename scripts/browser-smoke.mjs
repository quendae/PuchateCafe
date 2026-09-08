import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';

const port = 4197;
const smokePath = 'browser-smoke.html';
const original = await readFile('index.html', 'utf8');
const bootstrapScript = `<script>
window.__bootstrapErrors = [];
window.addEventListener('error', (event) => window.__bootstrapErrors.push(event.message || 'window error'));
window.addEventListener('unhandledrejection', (event) => window.__bootstrapErrors.push(String(event.reason?.message || event.reason || 'unhandled rejection')));
</script>`;
const probeScript = `<script type="module">
window.setTimeout(() => {
  document.querySelector('[data-action="solo"]')?.click();
  window.setTimeout(() => {
    const setup = document.getElementById('setup-screen');
    document.body.dataset.smoke = setup && !setup.hidden ? 'ok' : 'fail';
    document.body.dataset.bootstrapErrors = (window.__bootstrapErrors || []).join(' | ');
  }, 50);
}, 100);
</script>`;
const smokeHtml = original.replace(
  '<script type="module" src="src/app.js"></script>',
  `${bootstrapScript}\n  <script type="module" src="src/app.js"></script>\n  ${probeScript}`,
);
if (smokeHtml === original) throw new Error('Could not inject browser smoke probe into index.html');
await writeFile(smokePath, smokeHtml, 'utf8');

const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 30 && !serverOutput.includes(`:${port}`); i += 1) await sleep(100);
  if (!serverOutput.includes(`:${port}`)) throw new Error(`Static server did not start: ${serverOutput}`);

  const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const chrome = candidates.map((candidate) => spawnSync('which', [candidate], { encoding: 'utf8' }).stdout.trim()).find(Boolean);
  if (!chrome) throw new Error('Chromium/Chrome executable not found on CI runner');

  const result = spawnSync(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--virtual-time-budget=2500',
    '--dump-dom',
    `http://127.0.0.1:${port}/${smokePath}`,
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 10 * 1024 * 1024 });

  const html = result.stdout || '';
  const errorMatch = html.match(/data-bootstrap-errors="([^"]*)"/);
  if (result.status !== 0 || !html.includes('data-smoke="ok"')) {
    console.error('Browser smoke failed.');
    console.error('Chrome exit:', result.status);
    console.error('Captured browser errors:', errorMatch?.[1] || '(none)');
    console.error('Chrome stderr:', result.stderr || '(none)');
    throw new Error('Main menu JavaScript did not bootstrap or the Solo button did not open setup');
  }
  console.log('Browser smoke OK: app bootstrapped and Solo menu button opened setup.');
} finally {
  server.kill('SIGTERM');
  await unlink(smokePath).catch(() => {});
}
