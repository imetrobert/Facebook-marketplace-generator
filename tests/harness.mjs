/** Shared test harness: a static file server and a browser launcher. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

/** Serve the site root on `port`. */
export async function serve(port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(port, r));
  return { server, origin: `http://localhost:${port}` };
}

/**
 * Chromium ships preinstalled in this environment at a fixed path; fall back
 * to Playwright's own download when running anywhere else.
 */
export function launch() {
  const preinstalled = '/opt/pw-browsers/chromium';
  return chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
}

/** Read js/config.js with Supabase credentials injected, for gate tests. */
export function configWithSupabase(url, anonKey) {
  return fs
    .readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')
    .replace("url: ''", `url: '${url}'`)
    .replace("anonKey: ''", `anonKey: '${anonKey}'`);
}

/**
 * Collect console errors and uncaught exceptions into `problems`.
 *
 * Chromium logs "Failed to load resource" for every non-2xx response. The
 * failure tests provoke those deliberately, so that noise is filtered out —
 * what matters is that the app catches them, which those tests assert
 * directly. Genuine script errors still come through.
 */
export function watchForErrors(page, problems) {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (text.includes('Failed to load resource')) return;
    problems.push(`console: ${text}`);
  });
}

/** Print results and exit non-zero if anything failed. */
export function report(name, problems) {
  if (problems.length) {
    console.error(`\n${name} FAILURES:\n` + problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`\n${name}: all checks passed.`);
}
