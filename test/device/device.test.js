'use strict';

// On-device end-to-end suite. Runs ON the TV (see run.sh) against the real
// webOS audio service and the real BluOS device:
//
//   workstation --ssh--> TV: node --test test/device/device.test.js
//                          bridge.js --config /tmp/.../config.json
//                            bluos.host = 127.0.0.1:<proxy port>
//                          proxy.js --forwards--> real BluOS
//
// The proxy is what makes the assertions possible: the bridge's requests are
// recorded verbatim while the device behaviour stays real. The test's own
// stop/drift commands go straight to the device, so the proxy log contains
// only bridge traffic.
//
// Without ALLOW_WRITES=1 only the read-only preflight and the dryRun test run.

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { startProxy } = require('./proxy.js');
const lib = require('./lib.js');
const { mapLevel, parseStatus, parseVolume } = require('../../bridge.js');

const MAPPING = { scale: 1, offset: -30, min: 0, max: 100 };
const HAVE_DEVICE = lib.BLUOS_HOST.length > 0;
const WRITE_SKIP = lib.ALLOW_WRITES ? false : 'writes are opt-in: run with --allow-writes';
const describeDevice = HAVE_DEVICE ? describe : describe.skip;

function bridgeConfig(proxyPort, overrides) {
  const base = {
    bluos: { host: '127.0.0.1', port: proxyPort, timeoutMs: 2000 },
    mapping: MAPPING,
    debounceMs: 80,
    syncOnStart: true,
    reconcileMs: 5000,
    logLevel: 'debug',
    dryRun: false,
    playback: {
      enabled: true,
      inputType: 'spdif',
      index: 0,
      playUrl: null,
      // The device's minimums are 1000 ms; the suite wants the guard to react
      // within a few seconds, not ten.
      statusMs: 1000,
      minReassertMs: 1000,
      enforceSource: true,
      expectedService: 'Capture',
      expectedName: null,
      failOpen: true,
      treatUnknownAsPlaying: true,
    },
  };
  const opts = overrides || {};
  return Object.assign({}, base, opts, {
    bluos: Object.assign({}, base.bluos, opts.bluos || {}),
    mapping: Object.assign({}, base.mapping, opts.mapping || {}),
    playback: Object.assign({}, base.playback, opts.playback || {}),
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (error) { /* already gone */ }
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch (error) { clearTimeout(timer); resolve(); }
  });
}

// Start a bridge instance pointed at a fresh recording proxy. The proxy, the
// child and the temporary config are always torn down, even on failure.
async function startTestBridge(t, overrides) {
  const proxy = await startProxy({
    targetHost: lib.BLUOS_HOST,
    targetPort: lib.BLUOS_PORT,
    timeoutMs: 5000,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(bridgeConfig(proxy.port, overrides), null, 2));

  const child = spawn(process.execPath, [lib.BRIDGE_JS, '--config', configFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env),
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const handle = {
    proxy,
    child,
    configFile,
    output: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
    waitForLog: (re, timeoutMs) => lib.waitFor(() => re.test(output), { timeoutMs: timeoutMs || 10000 }),
    waitForRequest: (predicate, timeoutMs) =>
      lib.waitFor(() => proxy.requests.find(predicate) || false, { timeoutMs: timeoutMs || 10000 }),
    // Wait until the luna volume subscription has delivered its first message,
    // which is also when the startup sync happens.
    waitForVolumeSubscription: (timeoutMs) => lib.waitFor(() => /tv state: volume/.test(output), { timeoutMs: timeoutMs || 10000 }),
    stop: async () => {
      await stopChild(child);
      await proxy.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  t.after(async () => { await handle.stop(); });
  return handle;
}

function isWrite(url) {
  return url.startsWith('/Volume?') || url.startsWith('/Play') ||
    url.startsWith('/Stop') || url.startsWith('/Pause');
}

function writeRequests(handle) {
  return handle.proxy.requests.map((request) => request.url).filter(isWrite);
}

function assertNeverStopped(handle) {
  const forbidden = handle.proxy.requests
    .map((request) => request.url)
    .filter((url) => url.startsWith('/Stop') || url.startsWith('/Pause'));
  assert.deepEqual(forbidden, [], 'the bridge must never send Stop or Pause');
}

// ---------------------------------------------------------------------------
// Preflight: read-only, always runs
// ---------------------------------------------------------------------------

it('preflight: BLUOS_HOST is set', () => {
  assert.ok(HAVE_DEVICE, 'BLUOS_HOST is empty; run.sh discovers it from the installed config');
});

describeDevice('preflight (read-only)', () => {
  const pre = { tv: null, status: null, volume: null };

  before(async () => {
    pre.tv = await lib.getTvState();
    pre.status = parseStatus(await lib.bluosGet('/Status'));
    pre.volume = parseVolume(await lib.bluosGet('/Volume'));
  });

  it('finds a supported node and luna-send on the TV', () => {
    assert.ok(fs.existsSync(lib.LUNA_BIN), 'missing ' + lib.LUNA_BIN);
    assert.ok(Number(process.versions.node.split('.')[0]) >= 18, 'node ' + process.versions.node);
  });

  it('reads a usable TV volume', () => {
    assert.ok(Number.isFinite(pre.tv.level), 'TV level: ' + String(pre.tv.level));
    assert.ok(pre.tv.level >= 0 && pre.tv.level <= 100, 'TV level out of range: ' + pre.tv.level);
    assert.equal(typeof pre.tv.mute, 'boolean');
  });

  it('reads the TV foreground app info (or a known-unavailable answer)', async () => {
    const info = await lib.getForegroundAppInfo();
    // [] is normal for the tuner, HDMI and the home screen; null means the
    // firmware lacks the API and the bridge fails open.
    assert.ok(info === null || Array.isArray(info), 'foregroundAppInfo: ' + JSON.stringify(info));
  });

  it('reaches BluOS /Status and /Volume', () => {
    assert.equal(typeof pre.status.state, 'string', 'BluOS /Status has no state: ' + JSON.stringify(pre.status));
    assert.ok(Number.isFinite(pre.volume.level), 'BluOS level: ' + String(pre.volume.level));
    assert.equal(typeof pre.volume.mute, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// dryRun: proves the bridge reads the device and sends no writes, without
// needing --allow-writes (nothing on the device changes).
// ---------------------------------------------------------------------------

describeDevice('dryRun (read-only)', () => {
  it('reads the device but sends no writes', async (t) => {
    const tv = await lib.getTvState();
    const bluos = await lib.bluosVolume();

    // Pick a mapping that forces a level action, so the test proves dryRun
    // suppresses a write it would otherwise make.
    let mapping = null;
    for (const offset of [20, 21, 22, 19, 18, 25, 15, -20, -21, -19]) {
      const candidate = { scale: 1, offset, min: 0, max: 100 };
      if (mapLevel(tv.level, candidate) !== bluos.level) {
        mapping = candidate;
        break;
      }
    }
    assert.ok(mapping, 'could not build a mapping distinct from the current level');

    const h = await startTestBridge(t, { dryRun: true, mapping });
    assert.ok(await h.waitForVolumeSubscription(), 'no volume subscription; log:\n' + h.output());
    assert.ok(await h.waitForLog(/tv \d+ -> bluos \d+/, 10000),
      'dryRun did not plan a level action; log:\n' + h.output());
    assert.ok(h.alive(), 'bridge exited; log:\n' + h.output());

    // Give the debounce and one reconcile pass time to run.
    await lib.sleep(500);
    assert.deepEqual(writeRequests(h), [], 'dryRun sent writes');
    assert.ok(h.proxy.requests.some((request) => request.url === '/Volume'),
      'the bridge did not read /Volume through the proxy');
    assertNeverStopped(h);
  });
});

// ---------------------------------------------------------------------------
// Writes: opt-in, restore device state afterwards
// ---------------------------------------------------------------------------

describeDevice('writes (opt-in)', () => {
  it('mirrors a TV volume change to the BluOS level', { skip: WRITE_SKIP }, async (t) => {
    const tv0 = await lib.getTvState();
    if (tv0.mute) return t.skip('TV is muted; webOS exposes no luna mute setter');
    const bluos0 = await lib.bluosVolume();
    if (bluos0.level === -1) return t.skip('BluOS reports fixed volume (-1) and ignores level writes');

    // Any target that maps to a level the device is not already at.
    const candidates = [tv0.level - 10, tv0.level + 10, tv0.level - 20, tv0.level + 20, tv0.level - 5, tv0.level + 5];
    const target = candidates
      .map((level) => Math.min(100, Math.max(1, level)))
      .find((level) => level !== tv0.level && mapLevel(level, MAPPING) !== bluos0.level);
    assert.notEqual(target, undefined, 'no distinct TV volume target available');

    const h = await startTestBridge(t);
    try {
      assert.ok(await h.waitForVolumeSubscription(), 'no volume subscription; log:\n' + h.output());
      h.proxy.reset();

      await lib.setTvVolume(target);
      const reported = await lib.getTvState();
      assert.notEqual(reported.level, tv0.level, 'the TV did not change volume');
      const expected = mapLevel(reported.level, MAPPING);

      const hit = await h.waitForRequest((request) => request.url === '/Volume?level=' + expected, 10000);
      assert.ok(hit, 'expected /Volume?level=' + expected + '; log:\n' + h.output() +
        '\nrequests: ' + h.proxy.requests.map((request) => request.url).join(', '));
      assertNeverStopped(h);
    } finally {
      await lib.setTvVolume(tv0.level);
    }
  });

  it('re-asserts SPDIF after the BluOS device is stopped', { skip: WRITE_SKIP }, async (t) => {
    const tv = await lib.getTvState();
    if (tv.mute) return t.skip('TV is muted; webOS exposes no luna mute setter');
    if (!(tv.level > 0)) return t.skip('TV volume is 0; the guard only runs when the TV is audible');

    const h = await startTestBridge(t);
    try {
      assert.ok(await h.waitForVolumeSubscription(), 'no volume subscription; log:\n' + h.output());
      h.proxy.reset();

      // Straight to the device: the proxy log must contain bridge traffic only.
      await lib.bluosCommand('/Stop');

      const hit = await h.waitForRequest((request) => request.url === lib.SPDIF_PLAY, 15000);
      assert.ok(hit, 'the guard did not re-assert SPDIF after /Stop; log:\n' + h.output() +
        '\nrequests: ' + h.proxy.requests.map((request) => request.url).join(', '));
      assert.ok(await h.waitForLog(/re-asserting input/, 5000), 'no re-assert log line; log:\n' + h.output());

      const recovered = await lib.waitFor(async () => {
        const status = await lib.bluosStatus();
        return (status.state === 'stream' || status.state === 'play') && status.inputTypeIndex === 'spdif-1'
          ? status : false;
      }, { timeoutMs: 5000 });
      assert.ok(recovered, 'BluOS did not return to SPDIF; status: ' + JSON.stringify(await lib.bluosStatus()));

      const writes = writeRequests(h);
      assert.ok(writes.every((url) => url === lib.SPDIF_PLAY), 'unexpected writes: ' + writes.join(', '));
      assertNeverStopped(h);
    } finally {
      await lib.bluosCommand(lib.SPDIF_PLAY);
    }
  });

  it('re-asserts SPDIF after the source drifts to another local input', { skip: WRITE_SKIP }, async (t) => {
    const tv = await lib.getTvState();
    if (tv.mute) return t.skip('TV is muted; webOS exposes no luna mute setter');
    if (!(tv.level > 0)) return t.skip('TV volume is 0; the guard only runs when the TV is audible');

    const h = await startTestBridge(t);
    try {
      assert.ok(await h.waitForVolumeSubscription(), 'no volume subscription; log:\n' + h.output());
      h.proxy.reset();

      // Analog reports service=Capture too; only inputTypeIndex tells it apart.
      await lib.bluosCommand('/Play?inputType=analog&index=0');
      const drifted = await lib.waitFor(async () => {
        const status = await lib.bluosStatus();
        return status.inputTypeIndex === 'analog-1' ? status : false;
      }, { timeoutMs: 5000 });
      assert.ok(drifted, 'the test could not select the analog input');

      const hit = await h.waitForRequest((request) => request.url === lib.SPDIF_PLAY, 15000);
      assert.ok(hit, 'the guard did not re-assert SPDIF after source drift; log:\n' + h.output() +
        '\nrequests: ' + h.proxy.requests.map((request) => request.url).join(', '));

      const recovered = await lib.waitFor(async () => {
        const status = await lib.bluosStatus();
        return (status.state === 'stream' || status.state === 'play') && status.inputTypeIndex === 'spdif-1'
          ? status : false;
      }, { timeoutMs: 5000 });
      assert.ok(recovered, 'BluOS did not return to SPDIF; status: ' + JSON.stringify(await lib.bluosStatus()));

      const writes = writeRequests(h);
      assert.ok(writes.every((url) => url === lib.SPDIF_PLAY), 'unexpected writes: ' + writes.join(', '));
      assertNeverStopped(h);
    } finally {
      await lib.bluosCommand(lib.SPDIF_PLAY);
    }
  });
});
