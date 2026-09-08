import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = 4197;
const smokePath = 'browser-smoke.html';
const original = await readFile('index.html', 'utf8');
const bootstrapScript = `<script>
window.__bootstrapErrors = [];
const recordBootstrapError = (event) => {
  const target = event.target && event.target !== window ? event.target : null;
  const resource = target ? (target.src || target.href || target.tagName || 'resource') : '';
  const source = event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : '';
  const stack = event.error && event.error.stack ? event.error.stack : '';
  window.__bootstrapErrors.push([event.message || 'window error', source, resource, stack].filter(Boolean).join(' :: '));
};
window.addEventListener('error', recordBootstrapError, true);
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const detail = reason && reason.stack ? reason.stack : String(reason && reason.message || reason || 'unhandled rejection');
  window.__bootstrapErrors.push('unhandledrejection :: ' + detail);
});
</script>`;
const probeScript = `<script>
const reportSmoke = (status, detail = '') => fetch('/__smoke?status=' + encodeURIComponent(status) + '&detail=' + encodeURIComponent(detail)).catch(() => {});
window.setTimeout(() => {
  const button = document.querySelector('[data-action="solo"]');
  if (!button) { reportSmoke('fail', 'solo button missing'); return; }
  button.click();
  window.setTimeout(() => {
    const setup = document.getElementById('setup-screen');
    const errors = (window.__bootstrapErrors || []).join(' | ');
    reportSmoke(setup && !setup.hidden ? 'ok' : 'fail', errors || 'setup screen stayed hidden after click');
  }, 200);
}, 800);
</script>`;
const smokeHtml = original.replace(
  '<script type="module" src="src/app.js"></script>',
  `${bootstrapScript}\n  <script type="module" src="src/app.js"></script>\n  ${probeScript}`,
);
if (smokeHtml === original) throw new Error('Could not inject browser smoke probe into index.html');
await writeFile(smokePath, smokeHtml, 'utf8');

let resolveResult;
const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
const requests = [];
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/__smoke') {
    const result = { status: url.searchParams.get('status') || 'fail', detail: url.searchParams.get('detail') || '' };
    resolveResult(result);
    response.writeHead(204);
    response.end();
    return;
  }
  const requested = decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let filePath = join(process.cwd(), safePath || 'index.html');
  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    const type = mimeTypes[extname(filePath)] || 'application/octet-stream';
    requests.push(`${url.pathname} -> 200 ${type}`);
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    requests.push(`${url.pathname} -> 404`);
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const chromeBinary = candidates.map((candidate) => spawnSync('which', [candidate], { encoding: 'utf8' }).stdout.trim()).find(Boolean);
if (!chromeBinary) throw new Error('Chromium/Chrome executable not found on CI runner');

const chrome = spawn(chromeBinary, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  `http://127.0.0.1:${port}/${smokePath}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeStderr = '';
chrome.stderr.on('data', (chunk) => { chromeStderr += chunk.toString(); });

try {
  const result = await Promise.race([
    resultPromise,
    new Promise((_, reject) => setTimeout(() => {
      console.error('Browser request trace before timeout:\n' + requests.join('\n'));
      reject(new Error(`Browser smoke timed out. Chrome stderr: ${chromeStderr}`));
    }, 15_000)),
  ]);
  if (result.status !== 'ok') {
    console.error('Browser request trace:\n' + requests.join('\n'));
    throw new Error(`Browser smoke failed: ${result.detail || 'unknown bootstrap failure'}`);
  }
  console.log('Browser smoke OK: app bootstrapped and Solo menu button opened setup.');
} finally {
  chrome.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
  await unlink(smokePath).catch(() => {});
}
