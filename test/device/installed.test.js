'use strict';

// Post-deploy check: the service that actually runs on the TV (the init.d
// hook's process, the installed /var/lib/bluos-bridge/bridge.js) recovers the
// SPDIF input after the device is stopped.
//
// This is the only test that proves the deployed artifact. It is opt-in twice:
// CHECK_INSTALLED=1 (run.sh --installed) and ALLOW_WRITES=1, because it sends
// /Stop to the real device. It leaves the device on SPDIF.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('./lib.js');

const CHECK = process.env.CHECK_INSTALLED === '1' && lib.ALLOW_WRITES;
const APP_DIR = process.env.TV_APP_DIR || '/var/lib/bluos-bridge';
const INSTALLED_BRIDGE = path.join(APP_DIR, 'bridge.js');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const LOG_FILE = path.join(APP_DIR, 'bridge.log');
const PID_FILE = path.join(APP_DIR, 'bridge.pid');

const describeInstalled = CHECK ? describe : describe.skip;

function readPid() {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid in ' + PID_FILE);
  return pid;
}

function processCmdline(pid) {
  return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ');
}

function readInstalledConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const host = cfg && cfg.bluos && cfg.bluos.host;
  if (typeof host !== 'string' || host.length === 0) throw new Error(CONFIG_FILE + ' has no bluos.host');
  return { host, port: (cfg.bluos && cfg.bluos.port) || 11000 };
}

describeInstalled('installed service', () => {
  it('runs the build under test', () => {
    assert.ok(fs.existsSync(INSTALLED_BRIDGE), 'missing ' + INSTALLED_BRIDGE + '; run run.sh --installed');
    assert.ok(fs.existsSync(CONFIG_FILE), 'missing ' + CONFIG_FILE);
    assert.ok(fs.existsSync(LOG_FILE), 'missing ' + LOG_FILE);

    const installed = fs.readFileSync(INSTALLED_BRIDGE);
    const built = fs.readFileSync(lib.BRIDGE_JS);
    assert.ok(installed.equals(built),
      'the installed bridge differs from the build under test; deploy first (run.sh --installed)');

    const pid = readPid();
    const cmdline = processCmdline(pid);
    assert.match(cmdline, /bridge\.js/, 'pid ' + pid + ' is not the bridge: ' + cmdline);
    assert.doesNotThrow(() => process.kill(pid, 0), 'pid ' + pid + ' is not running');
  });

  it('re-asserts SPDIF after the device is stopped', async (t) => {
    const cfg = readInstalledConfig();
    const tv = await lib.getTvState();
    if (tv.mute) return t.skip('TV is muted; webOS exposes no luna mute setter');
    if (!(tv.level > 0)) return t.skip('TV volume is 0; the guard only runs when the TV is audible');

    const before = await lib.bluosStatus({ host: cfg.host, port: cfg.port });
    assert.equal(typeof before.state, 'string', 'BluOS /Status has no state');

    const offset = fs.statSync(LOG_FILE).size;

    // Straight to the device; the installed bridge polls /Status itself.
    await lib.bluosCommand('/Stop', { host: cfg.host, port: cfg.port });

    const reasserted = await lib.waitFor(() => {
      const size = fs.statSync(LOG_FILE).size;
      if (size <= offset) return false;
      return /re-asserting input/.test(fs.readFileSync(LOG_FILE, 'utf8').slice(offset));
    }, { timeoutMs: 30000, intervalMs: 250 });
    assert.ok(reasserted, 'the installed bridge did not log "re-asserting input"; last lines:\n' +
      fs.readFileSync(LOG_FILE, 'utf8').slice(-2000));

    const recovered = await lib.waitFor(async () => {
      const status = await lib.bluosStatus({ host: cfg.host, port: cfg.port });
      return (status.state === 'stream' || status.state === 'play') && status.inputTypeIndex === 'spdif-1'
        ? status : false;
    }, { timeoutMs: 10000 });
    assert.ok(recovered, 'BluOS did not return to SPDIF; status: ' +
      JSON.stringify(await lib.bluosStatus({ host: cfg.host, port: cfg.port })));

    // The service must still be alive after doing its job.
    const pid = readPid();
    assert.doesNotThrow(() => process.kill(pid, 0), 'the installed bridge exited');
  });
});
