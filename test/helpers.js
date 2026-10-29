'use strict';

// Shared fixtures and helpers for the tv-bluos-bridge test suite.
//
// This file is NOT a test file: it declares no tests, starts no processes and
// registers no timers on import. The `npm test` script names the three
// `*.test.js` files explicitly, so the runner never loads it as one. Keep it
// that way: `node --test test/` (a bare directory argument) would also try to
// run it, which is harmless but noisy.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BRIDGE_JS = path.join(__dirname, '..', 'bridge.js');

const MAPPING = { scale: 1, offset: -30, min: 0, max: 100 };

const LUNA_VOLUME_URI = 'luna://com.webos.service.audio/master/getVolume';
const LUNA_PLAY_STATE_URI = 'luna://com.webos.media/getForegroundAppInfo';

// ---------------------------------------------------------------------------
// XML fixtures (BluOS /Volume, /Status and /Play response bodies)
// ---------------------------------------------------------------------------

function volumeXml(options) {
  const opts = options || {};
  const level = opts.level === undefined ? 19 : opts.level;
  const mute = opts.mute === undefined ? 0 : opts.mute;
  const attrs = ['db="' + (opts.db === undefined ? '-32.4' : opts.db) + '"', 'offsetDb="0"', 'mute="' + mute + '"'];
  if (opts.muteVolume !== undefined) attrs.push('muteVolume="' + opts.muteVolume + '"');
  attrs.push('etag="x"', 'source=""');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<volume ' + attrs.join(' ') + '>' + level + '</volume>';
}

function statusXml(options) {
  const opts = options || {};
  const parts = ['<status etag="x">'];
  if (opts.volume !== undefined) parts.push('<volume>' + opts.volume + '</volume>');
  if (opts.state !== undefined) parts.push('<state>' + opts.state + '</state>');
  if (opts.service !== undefined) parts.push('<service>' + opts.service + '</service>');
  if (opts.name !== undefined) parts.push('<name>' + opts.name + '</name>');
  parts.push('</status>');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + parts.join('');
}

const PLAY_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<state>stream</state>';

// ---------------------------------------------------------------------------
// Fake luna-send messages
// ---------------------------------------------------------------------------

function tvMessage(volume, mute) {
  return {
    returnValue: true,
    subscribed: true,
    volumeStatus: { volume: volume, muteStatus: !!mute, maxVolume: 100 },
  };
}

function playStateMessage(playState, appId) {
  return {
    returnValue: true,
    subscribed: true,
    foregroundAppInfo: [{ appId: appId || 'com.webos.app.livetv', playState: playState }],
  };
}

// A payload entry may be an object (JSON.stringify'd by the fake) or, wrapped
// in raw(), a verbatim string — used for the non-JSON line paths.
function raw(text) {
  return { __raw: text };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'bluos-bridge-'));
}

function writeJsonConfig(dir, config) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Fake BluOS HTTP server
//
// Routes are matched in order by prefix or RegExp against `req.url`; the first
// match wins. Anything unmatched falls back to the default bodies, so a test
// only declares the deviations it cares about.
//   { match: '/Volume?level', status: 500, body: '' }
//   { match: /^\/Status/, never: true }         -> accept the socket, never reply
//   { match: /^\/Play/, delayMs: 300, body: … } -> reply after a delay
// ---------------------------------------------------------------------------

async function startFakeBluOS(options) {
  const opts = options || {};
  const requests = [];
  const routes = opts.routes || [];

  function replyFor(url) {
    for (const route of routes) {
      // `times` lets a test fail only the first N matches of a route.
      if (route.times !== undefined && route.times <= 0) continue;
      const hit = route.match instanceof RegExp
        ? route.match.test(url)
        : String(url).startsWith(String(route.match));
      if (hit) {
        if (route.times !== undefined) route.times -= 1;
        return {
          status: route.status === undefined ? 200 : route.status,
          body: route.body === undefined ? '' : route.body,
          never: !!route.never,
          delayMs: route.delayMs || 0,
        };
      }
    }
    if (url.startsWith('/Status')) return { status: 200, body: opts.statusBody === undefined ? statusXml({ state: 'stop', service: 'Capture', name: 'Optical Input' }) : opts.statusBody, delayMs: 0 };
    if (url.startsWith('/Play')) return { status: 200, body: opts.playBody === undefined ? PLAY_XML : opts.playBody, delayMs: 0 };
    return { status: 200, body: opts.volumeBody === undefined ? volumeXml() : opts.volumeBody, delayMs: 0 };
  }

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (opts.onRequest) opts.onRequest(req.url);
    if (opts.handle) return opts.handle(req, res, requests);
    const reply = replyFor(req.url);
    if (reply.never) return; // hang: exercises the client timeout
    const send = () => {
      if (res.writableEnded || res.destroyed) return; // client gave up already
      res.writeHead(reply.status, { 'Content-Type': 'application/xml' });
      res.end(reply.body);
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;

  async function close() {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, port, requests, close, urls: () => requests.slice() };
}

// Reserve a port by opening and immediately closing a listener: nothing is
// listening there afterwards, so requests to it get ECONNREFUSED.
async function getClosedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// Polling helpers
//
// Integration tests are timing-driven, so every wait is a poll with a generous
// deadline that returns as soon as the condition holds. `until` reports success
// instead of throwing so the caller can attach a rich failure context.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? 5000 : opts.timeoutMs;
  const intervalMs = opts.intervalMs === undefined ? 25 : opts.intervalMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await predicate();
    } catch (error) {
      value = false;
    }
    if (value) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// ---------------------------------------------------------------------------
// Fake `luna-send`
//
// One generic script; behaviour comes from the FAKE_LUNA_SPEC env var so each
// test declares its own subscriptions declaratively:
//
//   {
//     volume:    { messages: [...], stderrLines: [...], intervalMs, startDelayMs,
//                  repeat, exitAfterMs, exitAfterMessages, exitCode,
//                  phases: [ ...same shape... ], stateFile },
//     playState: { … }
//   }
//
// `messages` entries are objects (JSON.stringify'd) or raw strings. A `phases`
// array replays differently on each (re)launch: the phase index is a counter
// kept in `stateFile`, which is how the reconnect test makes the second
// instance behave differently from the first.
// ---------------------------------------------------------------------------

const FAKE_LUNA_SEND_SRC = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const spec = JSON.parse(process.env.FAKE_LUNA_SPEC || '{}');
const argv = process.argv.slice(2).join(' ');
const section = argv.indexOf('getForegroundAppInfo') !== -1
  ? spec.playState
  : argv.indexOf('getVolume') !== -1 ? spec.volume : null;

function pickPhase(s) {
  const phases = s && s.phases ? s.phases : [s || {}];
  let n = 0;
  if (s && s.stateFile) {
    try { n = Number(fs.readFileSync(s.stateFile, 'utf8')) || 0; } catch (e) { n = 0; }
    try { fs.writeFileSync(s.stateFile, String(n + 1)); } catch (e) { /* ignore */ }
  }
  return phases[Math.min(n, phases.length - 1)] || {};
}

const s = section ? pickPhase(section) : {};
const lines = (s.messages || []).map((m) => (typeof m === 'string' ? m : String(m && m.__raw !== undefined ? m.__raw : JSON.stringify(m))));
const intervalMs = s.intervalMs === undefined ? 40 : s.intervalMs;
const startDelayMs = s.startDelayMs === undefined ? 0 : s.startDelayMs;
const exitCode = s.exitCode === undefined ? 0 : s.exitCode;
let i = 0;
let timer = null;

function die() {
  process.exit(exitCode);
}

function emit() {
  if (lines.length === 0) return;
  if (!s.repeat && i >= lines.length) {
    if (timer) { clearInterval(timer); timer = null; }
    return;
  }
  const payload = s.repeat ? lines[i % lines.length] : lines[i];
  i += 1;
  process.stdout.write(payload + '\\n');
  if (s.exitAfterMessages !== undefined && i >= s.exitAfterMessages) die();
}

setTimeout(() => {
  for (const line of s.stderrLines || []) process.stderr.write(line + '\\n');
  emit();
  if (intervalMs > 0 && (s.repeat || i < lines.length)) timer = setInterval(emit, intervalMs);
  if (s.exitAfterMs !== undefined) setTimeout(die, s.exitAfterMs);
}, startDelayMs);

// Stay alive even when there is nothing to emit, like the real luna-send -i.
setInterval(() => {}, 1 << 30);
`;

function writeFakeLunaSend(dir) {
  const bin = path.join(dir, 'fake-luna-send');
  fs.writeFileSync(bin, FAKE_LUNA_SEND_SRC);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// ---------------------------------------------------------------------------
// Bridge harness
// ---------------------------------------------------------------------------

function bridgeConfig(fake, opts) {
  const options = opts || {};
  const cfg = {
    bluos: {
      host: '127.0.0.1',
      port: options.port !== undefined ? options.port : (fake ? fake.port : 1),
      timeoutMs: options.timeoutMs === undefined ? 1000 : options.timeoutMs,
    },
    mapping: options.mapping || MAPPING,
    debounceMs: options.debounceMs === undefined ? 20 : options.debounceMs,
    syncOnStart: options.syncOnStart === undefined ? true : options.syncOnStart,
    reconcileMs: options.reconcileMs === undefined ? 60000 : options.reconcileMs,
    logLevel: options.logLevel || 'debug',
    dryRun: !!options.dryRun,
  };
  if (options.playback !== null) {
    cfg.playback = Object.assign({ enabled: false }, options.playback || {});
  }
  return cfg;
}

// Spawn bridge.js with a fake luna-send and, unless `serve: false`, a fake
// BluOS HTTP server; everything is torn down in `t.after`.
//
// Returns { dir, fake, port, requests, child, exited, output, context, config,
//          configFile, alive, waitFor, waitForRequest, waitForLog }.
const START_BRIDGE_OPTIONS = [
  'prefix', 'serve', 'bluos', 'config', 'configFile', 'args', 'luna', 'env',
  'port', 'mapping', 'debounceMs', 'syncOnStart', 'reconcileMs', 'logLevel', 'dryRun', 'playback', 'timeoutMs',
];

async function startBridge(t, options) {
  const opts = options || {};
  // Typos in an option name would otherwise silently fall back to a default.
  for (const key of Object.keys(opts)) {
    if (START_BRIDGE_OPTIONS.indexOf(key) === -1) throw new Error('startBridge: unknown option "' + key + '"');
  }
  const dir = mkTmpDir(opts.prefix || 'bluos-bridge-');
  const fake = opts.serve === false ? null : await startFakeBluOS(opts.bluos || {});
  const config = opts.config !== undefined ? opts.config : bridgeConfig(fake, opts);
  const configFile = opts.configFile !== undefined ? opts.configFile : writeJsonConfig(dir, config);
  const lunaBin = writeFakeLunaSend(dir);
  const args = opts.args === undefined ? ['--config', configFile] : opts.args;

  const env = Object.assign({}, process.env, { LUNA_SEND_BIN: lunaBin });
  if (opts.luna) env.FAKE_LUNA_SPEC = JSON.stringify(opts.luna).split('{dir}').join(dir);
  if (opts.env) Object.assign(env, opts.env);

  const child = spawn(process.execPath, [BRIDGE_JS].concat(args), {
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { state.stdout += chunk; });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code: code, signal: signal })));

  if (t && typeof t.after === 'function') {
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (fake) await fake.close();
      removeDir(dir);
    });
  }

  const output = () => state.stdout + state.stderr;
  const context = () => 'requests: ' + JSON.stringify(fake ? fake.requests : []) +
    '\nexitCode: ' + String(child.exitCode) + ' signal: ' + String(child.signalCode) +
    '\nconfig: ' + JSON.stringify(config) +
    '\nlog:\n' + output();

  return {
    dir,
    fake,
    port: fake ? fake.port : null,
    requests: fake ? fake.requests : [],
    child,
    exited,
    config,
    configFile,
    output,
    stdout: () => state.stdout,
    stderr: () => state.stderr,
    context,
    alive: () => child.exitCode === null && child.signalCode === null,
    waitFor: (predicate, waitOptions) => until(predicate, waitOptions),
    waitForRequest: (matcher, waitOptions) => until(() => {
      const test = typeof matcher === 'string'
        ? (url) => url.startsWith(matcher)
        : (url) => matcher.test(url);
      return fake && fake.requests.some(test);
    }, waitOptions),
    waitForLog: (pattern, waitOptions) => until(() => {
      const text = output();
      return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
    }, waitOptions),
  };
}

module.exports = {
  BRIDGE_JS,
  MAPPING,
  LUNA_VOLUME_URI,
  LUNA_PLAY_STATE_URI,
  PLAY_XML,
  volumeXml,
  statusXml,
  tvMessage,
  playStateMessage,
  raw,
  mkTmpDir,
  writeJsonConfig,
  removeDir,
  startFakeBluOS,
  getClosedPort,
  sleep,
  until,
  countOccurrences,
  writeFakeLunaSend,
  bridgeConfig,
  startBridge,
};
