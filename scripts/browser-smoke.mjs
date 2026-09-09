import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = 4197;
const smokePath = 'browser-smoke.html';
const original = await readFile('index.html', 'utf8');
const bootstrapScript = `<script>
window.__bootstrapErrors = [];
localStorage.setItem('puchate.qqnd.server-session.v1', JSON.stringify({
  sessionId: '11111111-1111-4111-8111-111111111111',
  resumeToken: 'r'.repeat(40),
}));
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
const runName = new URLSearchParams(location.search).get('run') || 'default';
const reportSmoke = (status, detail = '') => fetch('/__smoke?run=' + encodeURIComponent(runName) + '&status=' + encodeURIComponent(status) + '&detail=' + encodeURIComponent(detail)).catch(() => {});
window.setTimeout(() => {
  const errors = (window.__bootstrapErrors || []).join(' | ');
  const button = document.querySelector('[data-action="solo"]');
  const language = document.getElementById('menu-language');
  const resume = document.getElementById('resume-session-card');
  const artCards = document.querySelectorAll('.hero-art-card img');
  const home = document.getElementById('home-screen');
  const topbar = document.querySelector('.topbar');
  if (errors) { reportSmoke('fail', errors); return; }
  if (!button) { reportSmoke('fail', 'solo button missing'); return; }
  if (!language) { reportSmoke('fail', 'menu language control missing'); return; }
  if (!resume || resume.hidden) { reportSmoke('fail', 'saved-session continue card missing'); return; }
  if (artCards.length < 3) { reportSmoke('fail', 'card-art hero did not render'); return; }
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    reportSmoke('fail', 'horizontal overflow: scrollWidth=' + document.documentElement.scrollWidth + ', viewport=' + window.innerWidth);
    return;
  }
  for (const [name, node] of [['home', home], ['topbar', topbar], ['resume', resume]]) {
    const rect = node?.getBoundingClientRect();
    if (!rect || rect.left < -2 || rect.right > window.innerWidth + 2) {
      reportSmoke('fail', name + ' escapes viewport: ' + (rect ? JSON.stringify({ left: rect.left, right: rect.right, width: rect.width, viewport: window.innerWidth }) : 'missing'));
      return;
    }
  }
  button.click();
  window.setTimeout(() => {
    const setup = document.getElementById('setup-screen');
    const lateErrors = (window.__bootstrapErrors || []).join(' | ');
    reportSmoke(setup && !setup.hidden ? 'ok' : 'fail', lateErrors || 'setup screen stayed hidden after click');
  }, 180);
}, 900);
</script>`;
const smokeHtml = original.replace(
  '<script type="module" src="src/app.js"></script>',
  `${bootstrapScript}\n  <script type="module" src="src/app.js"></script>\n  ${probeScript}`,
);
if (smokeHtml === original) throw new Error('Could not inject browser smoke probe into index.html');
await writeFile(smokePath, smokeHtml, 'utf8');

const pendingResults = new Map();
const requests = [];
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/__smoke') {
    const run = url.searchParams.get('run') || 'default';
    const result = { status: url.searchParams.get('status') || 'fail', detail: url.searchParams.get('detail') || '' };
    pendingResults.get(run)?.(result);
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

async function runViewport(name, width, height) {
  const resultPromise = new Promise((resolve) => pendingResults.set(name, resolve));
  const chrome = spawn(chromeBinary, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    `--window-size=${width},${height}`,
    `http://127.0.0.1:${port}/${smokePath}?run=${encodeURIComponent(name)}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', (chunk) => { chromeStderr += chunk.toString(); });
  let timeout;
  try {
    const result = await Promise.race([
      resultPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} browser smoke timed out. Chrome stderr: ${chromeStderr}`)), 15_000);
      }),
    ]);
    if (result.status !== 'ok') throw new Error(`${name} browser smoke failed: ${result.detail || 'unknown bootstrap/layout failure'}`);
    console.log(`Browser smoke OK (${name} ${width}x${height}).`);
  } finally {
    clearTimeout(timeout);
    pendingResults.delete(name);
    chrome.kill('SIGKILL');
  }
}

try {
  await runViewport('desktop', 1440, 900);
  await runViewport('mobile', 390, 844);
  console.log('Browser smoke OK: redesigned menu, saved-session affordance, responsive layout and Solo navigation all work.');
} catch (error) {
  console.error('Browser request trace:\n' + requests.join('\n'));
  throw error;
} finally {
  await new Promise((resolve) => server.close(resolve));
  await unlink(smokePath).catch(() => {});
}
