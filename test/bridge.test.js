'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { mapLevel, plan, parseVolume, loadConfig } = require('../bridge.js');

const MAPPING = { scale: 1, offset: -30, min: 0, max: 100 };

test('mapLevel maps TV 49 to BluOS 19', () => {
  assert.equal(mapLevel(49, MAPPING), 19);
});

test('mapLevel rounds and clamps', () => {
  assert.equal(mapLevel(49.4, MAPPING), 19);
  assert.equal(mapLevel(49.6, MAPPING), 20);
  assert.equal(mapLevel(0, MAPPING), 0);
  assert.equal(mapLevel(100, MAPPING), 70);
  assert.equal(mapLevel(100, { scale: 2, offset: 0, min: 0, max: 100 }), 100);
  assert.equal(mapLevel(10, { scale: 1, offset: 20, min: 0, max: 100 }), 30);
  assert.equal(mapLevel(1, { scale: 1, offset: -30, min: 5, max: 100 }), 5);
});

test('plan applies a level when unmuted and the level changed', () => {
  assert.deepEqual(plan({ level: 19, mute: false }, { level: 20, mute: false }), [
    { type: 'level', level: 20 },
  ]);
});

test('plan does nothing when state already matches', () => {
  assert.deepEqual(plan({ level: 19, mute: false }, { level: 19, mute: false }), []);
  assert.deepEqual(plan({ level: 19, mute: true }, { level: 19, mute: true }), []);
});

test('plan mutes without touching the level', () => {
  assert.deepEqual(plan({ level: 19, mute: false }, { level: 25, mute: true }), [
    { type: 'mute', mute: true },
  ]);
});

test('plan ignores level changes while already muted', () => {
  assert.deepEqual(plan({ level: 19, mute: true }, { level: 25, mute: true }), []);
});

test('plan sets the level before unmuting', () => {
  assert.deepEqual(plan({ level: 19, mute: true }, { level: 25, mute: false }), [
    { type: 'level', level: 25 },
    { type: 'mute', mute: false },
  ]);
});

test('plan handles unknown device state', () => {
  assert.deepEqual(plan(null, { level: 19, mute: false }), [{ type: 'level', level: 19 }]);
  assert.deepEqual(plan(null, { level: 19, mute: true }), [{ type: 'mute', mute: true }]);
});

test('parseVolume reads level and mute', () => {
  const body = '<volume db="-32.4" offsetDb="0" mute="0" etag="x" source="">19</volume>';
  assert.deepEqual(parseVolume(body), { level: 19, mute: false });
});

test('parseVolume uses muteVolume when muted', () => {
  const body = '<volume db="-100" offsetDb="0" mute="1" muteVolume="19" muteDb="-32.4" etag="x" source="">0</volume>';
  assert.deepEqual(parseVolume(body), { level: 19, mute: true });
});

test('loadConfig merges defaults and validates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluos-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ bluos: { host: '192.0.2.10' } }));
    const cfg = loadConfig(file);
    assert.equal(cfg.bluos.host, '192.0.2.10');
    assert.equal(cfg.bluos.port, 11000);
    assert.equal(cfg.mapping.offset, -30);

    fs.writeFileSync(file, JSON.stringify({ bluos: { host: '192.0.2.10', port: 99999 } }));
    assert.throws(() => loadConfig(file), /port/);

    fs.writeFileSync(file, JSON.stringify({ bluos: { host: '192.0.2.10' }, mapping: { min: 50, max: 10 } }));
    assert.throws(() => loadConfig(file), /mapping/);

    fs.writeFileSync(file, JSON.stringify({ bluos: {} }));
    assert.throws(() => loadConfig(file), /bluos\.host/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge follows TV volume and mute end to end', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluos-bridge-'));
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?>\n<volume db="-32.4" offsetDb="0" mute="0" etag="x" source="">19</volume>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const fakeLuna = path.join(dir, 'fake-luna-send');
  fs.writeFileSync(fakeLuna, `#!/usr/bin/env node
const messages = [
  { returnValue: true, volumeStatus: { volume: 49, muteStatus: false, maxVolume: 100 } },
  { returnValue: true, volumeStatus: { volume: 50, muteStatus: false, maxVolume: 100 } },
  { returnValue: true, volumeStatus: { volume: 50, muteStatus: true, maxVolume: 100 } },
];
let i = 0;
const timer = setInterval(() => {
  if (i < messages.length) {
    process.stdout.write(JSON.stringify(messages[i++]) + '\\n');
  } else {
    clearInterval(timer);
  }
}, 40);
`);
  fs.chmodSync(fakeLuna, 0o755);

  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    bluos: { host: '127.0.0.1', port, timeoutMs: 1000 },
    mapping: MAPPING,
    debounceMs: 20,
    syncOnStart: true,
    reconcileMs: 60000,
    logLevel: 'debug',
  }));

  const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge.js'), '--config', configFile], {
    env: { ...process.env, LUNA_SEND_BIN: fakeLuna },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  bridge.stdout.on('data', (chunk) => { output += chunk; });
  bridge.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => bridge.once('exit', resolve));

  t.after(async () => {
    bridge.kill('SIGTERM');
    await exited;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5000;
  while (requests.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.deepEqual(
    requests,
    ['/Volume', '/Volume?level=20', '/Volume?mute=1'],
    'unexpected requests: ' + JSON.stringify(requests) + '\nlog:\n' + output,
  );
});
