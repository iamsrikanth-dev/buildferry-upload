#!/usr/bin/env node
// BuildFerry CLI: upload an .ipa from CI or a terminal. No dependencies, Node 18 or newer.
//   npx buildferry upload [path/to/App.ipa]
// The token comes from --token or BUILDFERRY_TOKEN (create one under "Upload from CI" in BuildFerry).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.1.0';
const DEFAULT_URL = 'https://buildferry.app';
const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', '.build', '.gradle', '.dart_tool', 'vendor']);
const HELP = `Upload an iOS build to BuildFerry. Testers' iPhones get it automatically.

Usage
  npx buildferry upload [path/to/App.ipa] [options]

With no path, the newest .ipa under the current folder is used.

Options
  --token <token>   API token (default: the BUILDFERRY_TOKEN environment variable)
  --notes <text>    What's new / what to test, shown to testers on the install page
  --notes-file <f>  Read the notes from a file (a changelog, for example)
  --no-wait         Don't wait for BuildFerry to check the build
  --timeout <sec>   How long to wait for the check (default 600)
  --json            Print the result as JSON
  --url <url>       BuildFerry address (default ${DEFAULT_URL}, or BUILDFERRY_URL)
  -h, --help        Show this help
  -v, --version     Show the version

Create a token at ${DEFAULT_URL}/ci`;

class Failure extends Error {}

function parseArgs(argv) {
  const opts = { wait: true, json: false, timeout: 600, token: process.env.BUILDFERRY_TOKEN, url: process.env.BUILDFERRY_URL || DEFAULT_URL, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined || v === '') throw new Failure(`${a.split('=')[0]} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--no-wait') opts.wait = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--token' || a.startsWith('--token=')) opts.token = value();
    else if (a === '--url' || a.startsWith('--url=')) opts.url = value();
    else if (a === '--notes' || a.startsWith('--notes=')) opts.notes = value();
    else if (a === '--notes-file' || a.startsWith('--notes-file=')) opts.notesFile = value();
    else if (a === '--timeout' || a.startsWith('--timeout=')) opts.timeout = Number(value());
    else if (a.startsWith('-')) throw new Failure(`Unknown option ${a}. Run buildferry --help.`);
    else opts.files.push(a);
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout < 0) throw new Failure('--timeout must be a number of seconds');
  if (opts.notes !== undefined && opts.notesFile) throw new Failure('Use --notes or --notes-file, not both.');
  opts.url = opts.url.replace(/\/+$/, '');
  return opts;
}

/** The newest .ipa under `dir`, a few levels deep, skipping dependency folders. */
export function findIpa(dir, depth = 6) {
  let best = null;
  const walk = (d, left) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, left - 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.ipa')) {
        const mtime = fs.statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: p, mtime };
      }
    }
  };
  walk(dir, depth);
  return best?.path ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A request to the BuildFerry API, retried on network errors, 429 and 5xx. */
async function call(opts, method, p, body, { attempts = 4 } = {}) {
  const headers = { authorization: `Bearer ${opts.token}`, 'user-agent': `buildferry-cli/${VERSION}` };
  if (body && !(body instanceof Uint8Array)) headers['content-type'] = 'application/json';
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${opts.url}${p}`, { method, headers, body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (attempt >= attempts) throw new Failure(`Could not reach ${opts.url}: ${e.cause?.message ?? e.message}`);
      await sleep(attempt * 2000);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await sleep(attempt * 2000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Failure(data.error || `${method} ${p} failed with HTTP ${res.status}`);
    return data;
  }
}

function progress(opts) {
  const tty = process.stderr.isTTY && !opts.json;
  let shown = -1;
  return {
    update(done, total) {
      const pct = Math.floor((done / total) * 100);
      if (opts.json) return;
      if (tty) process.stderr.write(`\rUploading ${size(done)} of ${size(total)} (${pct}%)`);
      else if (pct >= shown + 25 || pct === 100) {
        shown = pct - (pct % 25);
        process.stderr.write(`Uploaded ${pct}%\n`);
      }
    },
    end() {
      if (tty) process.stderr.write('\n');
    },
  };
}

async function upload(opts) {
  if (!opts.token) throw new Failure(`No API token. Create one at ${opts.url}/ci, then set BUILDFERRY_TOKEN or pass --token.`);
  if (opts.files.length > 1) throw new Failure('Upload one .ipa at a time.');
  const file = opts.files[0] ?? findIpa(process.cwd());
  if (!file) throw new Failure('No .ipa found under this folder. Pass its path: buildferry upload path/to/App.ipa');
  if (!fs.existsSync(file)) throw new Failure(`${file} does not exist.`);
  if (!file.toLowerCase().endsWith('.ipa')) throw new Failure(`${file} is not an .ipa file.`);
  if (opts.notesFile && !fs.existsSync(opts.notesFile)) throw new Failure(`${opts.notesFile} does not exist.`);
  const notes = (opts.notesFile ? fs.readFileSync(opts.notesFile, 'utf8') : opts.notes ?? '').trim();
  if (notes.length > 2000) throw new Failure(`The notes are ${notes.length} characters; keep them under 2000.`);
  const bytes = fs.statSync(file).size;
  const log = (s) => opts.json || process.stderr.write(`${s}\n`);
  log(`Uploading ${path.relative(process.cwd(), file) || file} (${size(bytes)}) to ${opts.url}`);

  const start = await call(opts, 'POST', '/api/uploads', { fileName: path.basename(file), size: bytes, ...(notes ? { notes } : {}) });
  const fd = fs.openSync(file, 'r');
  const bar = progress(opts);
  const parts = [];
  try {
    for (let n = 1, offset = 0; offset < bytes; n++, offset += start.partSize) {
      const chunk = Buffer.alloc(Math.min(start.partSize, bytes - offset));
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      parts.push(await call(opts, 'PUT', `/api/uploads/${start.buildId}/parts/${n}`, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
      bar.update(offset + chunk.length, bytes);
    }
  } finally {
    fs.closeSync(fd);
    bar.end();
  }
  await call(opts, 'POST', `/api/uploads/${start.buildId}/complete`, { parts });

  let s = { status: 'uploaded', buildId: start.buildId };
  if (opts.wait) {
    log('Checking the build…');
    const until = Date.now() + opts.timeout * 1000;
    while (s.status === 'uploaded' || s.status === 'uploading') {
      if (Date.now() > until) break;
      await sleep(3000);
      s = { ...(await call(opts, 'GET', `/api/uploads/${start.buildId}`)), buildId: start.buildId };
    }
  }
  return s;
}

function report(opts, s) {
  const name = s.appName ? `${s.appName} ${s.version} (${s.build})` : 'The build';
  const ok = s.status === 'ok' || s.status === 'duplicate' || s.status === 'uploaded';
  if (opts.json) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  else {
    const lines = [];
    if (s.status === 'ok') lines.push(`✓ Added ${name}. ${s.testers ? `Signing it for ${s.testers} ${s.testers === 1 ? 'tester' : 'testers'}; their links update by themselves.` : 'Share the link below; you approve each iPhone.'}`);
    else if (s.status === 'duplicate') lines.push(`✓ Already uploaded: this file is ${name}. Nothing changed.`);
    else if (s.status === 'uploaded') lines.push('✓ Uploaded. BuildFerry is still checking it; the app updates when that finishes.');
    else lines.push(`✗ ${name} can't be shared:`, ...(s.errors?.length ? s.errors : ['the build was rejected']).map((e) => `  ${e}`));
    if (s.shareUrl) lines.push(`  Share link: ${s.shareUrl}`);
    if (s.appUrl) lines.push(`  App page:   ${s.appUrl}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  // GitHub Actions: step outputs and a job summary.
  const out = { status: s.status, 'build-id': s.buildId, 'app-id': s.appId ?? '', version: s.version ?? '', build: s.build ?? '', 'share-url': s.shareUrl ?? '', 'app-url': s.appUrl ?? '', testers: String(s.testers ?? 0) };
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`### ${ok ? '✅' : '❌'} BuildFerry: ${name}`, ''];
    if (s.status === 'ok') md.push(s.testers ? `Signing for ${s.testers} ${s.testers === 1 ? 'tester' : 'testers'}.` : 'Uploaded.');
    if (!ok) md.push(...(s.errors ?? []).map((e) => `- ${e}`));
    if (s.shareUrl) md.push('', `**Share link:** ${s.shareUrl}`);
    if (s.appUrl) md.push('', `[Open in BuildFerry](${s.appUrl})`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`);
  }
  return ok;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(command === 'upload' ? rest : [command, ...rest].filter(Boolean));
  if (opts.version) return console.log(VERSION);
  if (opts.help || command !== 'upload') {
    console.log(HELP);
    if (command && !opts.help && command !== 'help') process.exitCode = 1;
    return;
  }
  const s = await upload(opts);
  if (!report(opts, s)) process.exitCode = 1;
}

// Run when called as a command (npx links bin/ through a symlink), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`buildferry: ${e instanceof Failure ? e.message : e.stack}\n`);
    process.exitCode = 1;
  });
}
