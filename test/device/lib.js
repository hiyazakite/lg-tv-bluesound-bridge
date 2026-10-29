'use strict';

// Shared helpers for the on-device e2e suite. This file is NOT a test file: it
// declares no tests and starts nothing on import. `run.sh` copies bridge.js and
// test/device to the TV, where `node --test` runs only the *.test.js files.
//
// It doubles as the CLI run.sh uses for its safety net:
//   node test/device/lib.js snapshot        JSON on stdout
//   node test/device/lib.js restore [file]  JSON from a file or stdin
//   node test/device/lib.js status          human-readable state

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The bridge under test and the parser it uses. Requiring bridge.js is safe:
// main() only runs under require.main.
const BRIDGE_JS = process.env.BRIDGE_JS || path.join(__dirname, '..', '..', 'bridge.js');
const { parseStatus, parseVolume, parseTvLevel } = require(BRIDGE_JS);

const LUNA_BIN = process.env.LUNA_SEND_BIN || '/usr/bin/luna-send';
const BLUOS_HOST = process.env.BLUOS_HOST || '';
const BLUOS_PORT = Number(process.env.BLUOS_PORT || 11000);
const ALLOW_WRITES = process.env.ALLOW_WRITES === '1';

// The bridge's normal state, and the one the suite leaves the device in.
const SPDIF_PLAY = '/Play?inputType=spdif&index=0';

const URIS = {
  getVolume: 'luna://com.webos.service.audio/master/getVolume',
  setVolume: 'luna://com.webos.service.audio/master/setVolume',
  foreground: 'luna://com.webos.media/getForegroundAppInfo',
};

// The real luna-send silently does nothing when stdin is a tty, so stdin is
// always 'ignore' (the same quirk the bridge works around).
function lunaSend(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(LUNA_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error('luna-send exited ' + code + ': ' + stderr.trim() + ' ' + stdout.trim()));
    });
  });
}

async function lunaJson(uri, payload) {
  const out = await lunaSend(['-n', '1', uri, JSON.stringify(payload || {})]);
  const line = out.split('\n').filter(Boolean).pop() || '';
  return JSON.parse(line);
}

async function getTvState() {
  const message = await lunaJson(URIS.getVolume, {});
  const status = message && message.volumeStatus;
  if (!status) throw new Error('getVolume returned no volumeStatus: ' + JSON.stringify(message));
  const level = parseTvLevel(status.volume);
  if (level === null) throw new Error('getVolume returned an unusable volume: ' + JSON.stringify(status.volume));
  return {
    level,
    mute: status.muteStatus === true || status.muteStatus === 'true',
  };
}

async function setTvVolume(level) {
  if (!Number.isInteger(level) || level < 0 || level > 100) {
    throw new Error('setTvVolume: level must be an integer 0..100, got ' + String(level));
  }
  const message = await lunaJson(URIS.setVolume, { volume: level });
  if (message.returnValue !== true) throw new Error('setVolume failed: ' + JSON.stringify(message));
}

// [] is a normal answer (tuner, HDMI, home screen); null means the firmware
// does not expose the API, which the bridge handles by failing open.
async function getForegroundAppInfo() {
  const message = await lunaJson(URIS.foreground, {});
  return message && Array.isArray(message.foregroundAppInfo) ? message.foregroundAppInfo : null;
}

function httpGet(pathname, options) {
  const opts = options || {};
  const host = opts.host || BLUOS_HOST;
  const port = opts.port || BLUOS_PORT;
  const timeoutMs = opts.timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.on('error', reject);
  });
}

async function bluosGet(pathname, options) {
  const res = await httpGet(pathname, options);
  if (res.status !== 200) throw new Error('BluOS ' + pathname + ' -> HTTP ' + res.status);
  return res.body;
}

// Commands the suite sends itself. They go straight to the device, never
// through the recording proxy, so they cannot be mistaken for bridge traffic.
function bluosCommand(pathname, options) {
  return bluosGet(pathname, options);
}

function bluosSetLevel(level, options) {
  if (!Number.isInteger(level) || level < 0) throw new Error('bluosSetLevel: invalid level ' + String(level));
  return bluosCommand('/Volume?level=' + level, options);
}

function bluosSetMute(mute, options) {
  return bluosCommand('/Volume?mute=' + (mute ? 1 : 0), options);
}

async function bluosStatus(options) {
  return parseStatus(await bluosGet('/Status', options));
}

async function bluosVolume(options) {
  return parseVolume(await bluosGet('/Volume', options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll until `predicate` is truthy; returns the truthy value or false on
// timeout. Errors are treated as "not yet" so a device restart is retryable.
async function waitFor(predicate, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? 5000 : opts.timeoutMs;
  const intervalMs = opts.intervalMs === undefined ? 50 : opts.intervalMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try { value = await predicate(); } catch (error) { value = false; }
    if (value) return value;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

async function snapshotState() {
  const tv = await getTvState();
  const volume = await bluosVolume();
  return { tv, bluos: { level: volume.level, mute: volume.mute } };
}

// Put the TV volume and the BluOS level/mute back, then leave the device on
// the SPDIF input. The TV mute is never changed by the suite (webOS exposes no
// luna setter), so a differing mute is reported rather than fixed.
async function restoreState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('restore: snapshot is required');
  const problems = [];
  const bluos = snapshot.bluos || {};
  // Level before mute: setting a level unmutes, so the mute is applied last.
  if (Number.isInteger(bluos.level) && bluos.level >= 0) {
    await bluosSetLevel(bluos.level);
  }
  if (typeof bluos.mute === 'boolean') {
    await bluosSetMute(bluos.mute);
  }

  if (snapshot.tv && Number.isFinite(snapshot.tv.level)) {
    await setTvVolume(snapshot.tv.level);
    try {
      const now = await getTvState();
      if (now.mute !== !!snapshot.tv.mute) {
        problems.push('TV mute is ' + now.mute + ' but the snapshot had ' + !!snapshot.tv.mute +
          '; webOS exposes no luna mute setter');
      }
    } catch (error) {
      problems.push('could not re-read the TV volume: ' + error.message);
    }
  }

  await bluosCommand(SPDIF_PLAY);
  return problems;
}

module.exports = {
  BRIDGE_JS,
  LUNA_BIN,
  BLUOS_HOST,
  BLUOS_PORT,
  ALLOW_WRITES,
  SPDIF_PLAY,
  URIS,
  lunaSend,
  lunaJson,
  getTvState,
  setTvVolume,
  getForegroundAppInfo,
  httpGet,
  bluosGet,
  bluosCommand,
  bluosSetLevel,
  bluosSetMute,
  bluosStatus,
  bluosVolume,
  sleep,
  waitFor,
  snapshotState,
  restoreState,
};

if (require.main === module) {
  const command = process.argv[2];
  const arg = process.argv[3];

  function readStdin() {
    return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
  }

  (async () => {
    if (command === 'snapshot') {
      process.stdout.write(JSON.stringify(await snapshotState()) + '\n');
      return;
    }
    if (command === 'restore') {
      const text = arg ? fs.readFileSync(arg, 'utf8') : await readStdin();
      const problems = await restoreState(JSON.parse(text));
      for (const problem of problems) console.error('restore: ' + problem);
      return;
    }
    if (command === 'status') {
      const state = await snapshotState();
      console.log('tv level ' + state.tv.level + (state.tv.mute ? ' (muted)' : '') +
        ', bluos level ' + state.bluos.level + (state.bluos.mute ? ' (muted)' : ''));
      return;
    }
    console.error('Usage: lib.js snapshot | restore [file] | status');
    process.exit(2);
  })().catch((error) => {
    console.error('lib.js: ' + error.message);
    process.exit(1);
  });
}
