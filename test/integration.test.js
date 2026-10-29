'use strict';

// Integration tests: the real bridge.js process, the real spawn()/subscribe
// path, a fake `luna-send` (driven by FAKE_LUNA_SPEC, see helpers.js) and a
// fake BluOS HTTP server. Every wait is a poll with a generous deadline.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  LUNA_VOLUME_URI,
  LUNA_PLAY_STATE_URI,
  startBridge,
  getClosedPort,
  sleep,
  countOccurrences,
  tvMessage,
  playStateMessage,
  raw,
  statusXml,
  volumeXml,
} = require('./helpers.js');

const PLAY_SPDIF = '/Play?inputType=spdif&index=0';

function playbackFast(overrides) {
  return Object.assign({ enabled: true, statusMs: 1000, minReassertMs: 1000 }, overrides || {});
}

const STOPPED = statusXml({ state: 'stop', service: 'Capture', name: 'Optical Input' });
const STOPPED_NO_SERVICE = statusXml({ state: 'stop', service: 'Capture' });
const PLAYING_CAPTURE = statusXml({ state: 'stream', service: 'Capture', name: 'Optical Input' });
const DRIFTED = statusXml({ state: 'stream', service: 'Bluetooth', name: 'Perfect' });

describe('bridge.js (spawned)', () => {
  // -------------------------------------------------------------------------
  // Volume / mute mirroring
  // -------------------------------------------------------------------------

  describe('volume and mute mirroring', () => {
    it('follows TV volume and mute end to end (playback disabled)', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-bridge-',
        playback: { enabled: false },
        luna: {
          volume: {
            messages: [
              raw('this line is not json'),
              { returnValue: true, subscribed: true }, // no volumeStatus -> ignored
              tvMessage(49, false),
              tvMessage(50, false),
              tvMessage(50, true),
            ],
            intervalMs: 40,
          },
        },
      });

      assert.ok(
        await h.waitFor(() => h.requests.length >= 3, { timeoutMs: 6000 }),
        'timed out waiting for 3 requests; ' + h.context(),
      );
      assert.deepEqual(h.requests, ['/Volume', '/Volume?level=20', '/Volume?mute=1'], h.context());
      assert.ok(h.alive(), h.context());
      // The two junk lines are logged and skipped, not fatal.
      assert.match(h.output(), /ignoring non-JSON line: this line is not json/);
      assert.match(h.output(), /ignoring message: \{"returnValue":true,"subscribed":true\}/);
      assert.match(h.output(), /tv 50 -> bluos 20 \(scale 1, offset -30\)/);
      assert.match(h.output(), /mute on/);
    });

    it('ignores malformed TV volume messages instead of sending NaN or a bogus level', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-invalid-volume-',
        playback: { enabled: false },
        luna: {
          volume: {
            messages: [
              { returnValue: true, subscribed: true, volumeStatus: { volume: null, muteStatus: false } },
              { returnValue: true, subscribed: true, volumeStatus: { volume: 'abc', muteStatus: false } },
              { returnValue: true, subscribed: true, volumeStatus: { volume: false, muteStatus: false } },
              tvMessage(50, false),
            ],
            intervalMs: 40,
          },
        },
      });

      assert.ok(await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 }), h.context());
      assert.ok(h.alive(), h.context());
      // Fix A: null/false used to coerce to 0 (a silent minimum-volume
      // request) and 'abc' to NaN; both must be ignored instead.
      assert.ok(
        !h.requests.some((url) => /level=(NaN|null|undefined|0)/.test(url)),
        'malformed volumes must not reach BluOS; ' + h.context(),
      );
      assert.match(h.output(), /ignoring TV volume message with invalid volume/);
      // The valid message that followed still mirrors normally.
      assert.deepEqual(h.requests, ['/Volume', '/Volume?level=20'], h.context());
    });

    it('warns when the device reports BluOS fixed volume (-1) at startup', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-fixed-volume-',
        playback: { enabled: false },
        bluos: { volumeBody: volumeXml({ level: -1 }) },
        luna: { volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 } },
      });

      assert.ok(
        await h.waitForLog(/bluos reports fixed volume \(-1\); level changes may be ignored/, { timeoutMs: 6000 }),
        h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('does not send anything when the TV state already matches the device', async (t) => {
      // The fake device sits at level 19, unmuted, which is exactly what the
      // default mapping makes of TV 49: plan() returns no actions.
      const h = await startBridge(t, {
        prefix: 'bluos-mirror-',
        playback: { enabled: false },
        bluos: {},
        luna: { volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 } },
      });

      assert.ok(await h.waitForLog(/bluos state: level 19/, { timeoutMs: 6000 }), h.context());
      await sleep(400);
      assert.deepEqual(h.requests, ['/Volume'], 'no write should have been needed; ' + h.context());
      assert.ok(h.alive(), h.context());
    });

    it('mutes the device while the TV is muted and never sends /Play', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-muted-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, true)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(
        await h.waitForRequest('/Volume?mute=1', { timeoutMs: 6000 }),
        'expected the device to be muted; ' + h.context(),
      );
      // Let a full guard interval pass: an inaudible TV must not wake the device.
      await sleep(1300);
      assert.equal(
        h.requests.filter((url) => url.startsWith('/Play')).length,
        0,
        'a muted TV is not audible, so no re-assert; ' + h.context(),
      );
      // BluOS unmutes when a level is set while muted, so no level either.
      assert.equal(
        h.requests.filter((url) => url.startsWith('/Volume?level=')).length,
        0,
        'never send a level while muted; ' + h.context(),
      );
      assert.match(h.output(), /mute on/);
      assert.ok(h.alive(), h.context());
    });

    it('waits for the next change when syncOnStart is disabled', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-syncstart-',
        playback: { enabled: false },
        syncOnStart: false,
        luna: {
          volume: { messages: [tvMessage(50, false), tvMessage(60, false)], intervalMs: 40 },
        },
      });

      assert.ok(await h.waitForRequest('/Volume?level=30', { timeoutMs: 6000 }), h.context());
      assert.equal(
        h.requests.filter((url) => url.startsWith('/Volume?level=20')).length,
        0,
        'the first message must not be applied; ' + h.context(),
      );
      assert.match(h.output(), /syncOnStart disabled; waiting for the next change/);
      assert.ok(h.alive(), h.context());
    });

    it('logs and survives a device that answers 500 to a level change', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-500-',
        playback: { enabled: false },
        bluos: { routes: [{ match: '/Volume?level', status: 500, body: 'nope' }] },
        luna: { volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 } },
      });

      assert.ok(
        await h.waitForLog(/WARN bluos update failed: HTTP 500 for \/Volume\?level=20/, { timeoutMs: 6000 }),
        h.context(),
      );
      assert.ok(h.alive(), 'the bridge must stay up on a device error; ' + h.context());
    });

    it('retries a failed update on the next reconcile tick', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reconcile-',
        playback: { enabled: false },
        reconcileMs: 500,
        // Only the first level write fails; the retry must succeed.
        bluos: { routes: [{ match: '/Volume?level', status: 500, body: 'nope', times: 1 }] },
        luna: { volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 } },
      });

      assert.ok(
        await h.waitForLog(/WARN bluos update failed/, { timeoutMs: 6000 }),
        'the first write should fail; ' + h.context(),
      );
      assert.ok(
        await h.waitFor(() => h.requests.filter((url) => url === '/Volume?level=20').length >= 2, { timeoutMs: 6000 }),
        'the reconcile tick should retry the failed write; ' + h.context(),
      );
      await sleep(700);
      assert.equal(
        h.requests.filter((url) => url === '/Volume?level=20').length,
        2,
        'once applied, the reconcile tick should settle; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('coalesces a TV change that lands while an update is in flight', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-inflight-',
        playback: { enabled: false },
        debounceMs: 10,
        // A slow device: the second TV change arrives while the first write
        // is still pending, so it must be applied afterwards, not dropped.
        bluos: { routes: [{ match: '/Volume?level', delayMs: 400, body: volumeXml() }] },
        luna: { volume: { messages: [tvMessage(50, false), tvMessage(60, false)], intervalMs: 60 } },
      });

      assert.ok(
        await h.waitForRequest('/Volume?level=30', { timeoutMs: 6000 }),
        'the mid-flight change must still be applied; ' + h.context(),
      );
      assert.equal(h.requests.filter((url) => url === '/Volume?level=20').length, 1, h.context());
      assert.equal(h.requests.filter((url) => url === '/Volume?level=30').length, 1, h.context());
      assert.ok(h.alive(), h.context());
    });
  });

  // -------------------------------------------------------------------------
  // Reverse sync: BluOS is the authority, the TV display follows it
  // -------------------------------------------------------------------------

  // The TV's luna subscription echoes whatever the bridge writes. The fake
  // luna appends that echo to `file`; the next subscription emit picks it up.
  function tvEchoLuna(extra) {
    return Object.assign({
      volume: {
        messages: [tvMessage(49, false)],
        repeat: true,
        intervalMs: 40,
        file: '{dir}/tv-echo.jsonl',
      },
      setVolumeEchoFile: '{dir}/tv-echo.jsonl',
    }, extra || {});
  }

  describe('reverse sync (bluosToTv)', () => {
    it('adopts the BluOS level on the TV at startup and ignores the echo', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-startup-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: tvEchoLuna(),
      });

      assert.ok(await h.waitForSetVolume(51, { timeoutMs: 6000 }), h.context());
      assert.ok(await h.waitForLog(/bluos 21 -> tv 51 \(reverse sync\)/, { timeoutMs: 6000 }), h.context());
      await sleep(600);
      assert.equal(
        h.setVolumeCalls().filter((call) => call.payload.volume === 51).length, 1,
        'the TV level is written once; ' + h.context(),
      );
      // The echo of 51 must not be mirrored back to BluOS (which would map it
      // to 21 and could unmute or re-level the player).
      assert.ok(
        !h.requests.some((url) => url.startsWith('/Volume?')),
        'the echo must not write to BluOS; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('follows a BluOS volume change from the poll without writing back', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-poll-',
        playback: { enabled: false },
        bluos: { volume: { level: 19 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: tvEchoLuna(),
      });

      // Startup: TV 49 and BluOS 19 already agree, so nothing is written.
      assert.ok(await h.waitForLog(/bluos state: level 19/, { timeoutMs: 6000 }), h.context());
      await sleep(300);
      assert.equal(h.setVolumeCalls().length, 0, h.context());

      // The BluOS app raises the volume; the next poll must move the TV.
      h.fake.setVolume({ level: 21 });
      assert.ok(await h.waitForSetVolume(51, { timeoutMs: 6000 }), h.context());
      assert.ok(await h.waitForLog(/bluos 21 -> tv 51 \(reverse sync\)/, { timeoutMs: 6000 }), h.context());

      await sleep(400);
      assert.ok(
        !h.requests.some((url) => url.startsWith('/Volume?')),
        'the echo must not write to BluOS; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('does not unmute a player muted from the BluOS app', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-muted-player-',
        playback: { enabled: false },
        bluos: { volume: { level: 21, mute: true } },
        bluosToTv: { enabled: true, pollMs: 250 },
        debounceMs: 50,
        luna: tvEchoLuna({
          volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 200, file: '{dir}/tv-echo.jsonl' },
        }),
      });

      assert.ok(await h.waitForSetVolume(51, { timeoutMs: 6000 }), h.context());
      await sleep(900);
      // The TV cannot represent a muted player, so its unmuted echo must not
      // become an unmute command (the forward reconcile runs between messages).
      assert.ok(
        !h.requests.some((url) => url.includes('mute')),
        'the unmuted TV must not unmute BluOS; ' + h.context(),
      );
      assert.ok(
        !h.requests.some((url) => url.startsWith('/Volume?level=')),
        'the echo must not write a level; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('skips the TV write while the TV is muted and keeps the old fallback', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-muted-tv-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: { volume: { messages: [tvMessage(49, true)], repeat: true, intervalMs: 40 } },
      });

      // The TV cannot be muted by luna, so the reverse sync cannot represent
      // a muted TV: the startup fallback keeps the original TV -> BluOS sync.
      assert.ok(await h.waitForRequest('/Volume?mute=1', { timeoutMs: 6000 }), h.context());
      await sleep(400);
      assert.equal(h.setVolumeCalls().length, 0, 'a muted TV must not be written; ' + h.context());
      assert.ok(h.alive(), h.context());
    });

    it('does not touch the TV when the BluOS level is not representable', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-fixed-',
        playback: { enabled: false },
        bluos: { volumeBody: volumeXml({ level: -1 }) },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: { volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 } },
      });

      assert.ok(
        await h.waitForLog(/cannot map bluos level -1 to a TV level; the TV will not follow/, { timeoutMs: 6000 }),
        h.context(),
      );
      await sleep(300);
      assert.equal(h.setVolumeCalls().length, 0, h.context());
      assert.ok(h.alive(), h.context());
    });

    it('warns and falls back when the TV write is refused', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-refused-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: {
          setVolumeOk: false,
          volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN reverse sync failed: setVolume failed/, { timeoutMs: 6000 }),
        h.context(),
      );
      // The startup fallback still applies the original TV -> BluOS sync.
      assert.ok(await h.waitForRequest('/Volume?level=19', { timeoutMs: 6000 }), h.context());
      assert.ok(h.alive(), h.context());
    });

    it('warns when luna-send returns malformed JSON', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-bad-json-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: {
          setVolumeRaw: 'not json',
          volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN reverse sync failed: invalid luna response: not json/, { timeoutMs: 6000 }),
        h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('warns when luna-send exits non-zero', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-exit-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: {
          setVolumeExit: 3,
          setVolumeStderr: 'boom',
          volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN reverse sync failed: luna-send exited 3: boom/, { timeoutMs: 6000 }),
        h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('times out a hung luna write instead of stalling the poll', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-timeout-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: {
          setVolumeNever: true,
          volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN reverse sync failed: setVolume timed out after 3000ms/, { timeoutMs: 8000 }),
        h.context(),
      );
      // The startup fallback still runs after the timeout.
      assert.ok(await h.waitForRequest('/Volume?level=19', { timeoutMs: 6000 }), h.context());
      assert.ok(h.alive(), h.context());
    });

    it('reports a spawn failure when luna-send disappears mid-run', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-spawn-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        syncOnStart: false,
        luna: { volume: { messages: [tvMessage(49, false)], repeat: true, intervalMs: 40 } },
      });

      assert.ok(await h.waitForLog(/syncOnStart disabled/, { timeoutMs: 6000 }), h.context());
      fs.unlinkSync(path.join(h.dir, 'fake-luna-send'));
      assert.ok(
        await h.waitForLog(/WARN reverse sync failed: spawn .*ENOENT/, { timeoutMs: 6000 }),
        h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('keeps retrying the volume subscription when luna-send is missing', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-no-luna-',
        playback: { enabled: false },
        env: { LUNA_SEND_BIN: '/nonexistent/luna-send' },
      });

      assert.ok(
        await h.waitForLog(/luna-send \(volume\) failed to start .*ENOENT.*; reconnecting in 1000ms/, { timeoutMs: 6000 }),
        h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('treats a TV that lands on another level as a user change', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-mismatch-',
        playback: { enabled: false },
        bluos: { volume: { level: 21 } },
        bluosToTv: { enabled: true, pollMs: 250 },
        luna: tvEchoLuna({ setVolumeEchoLevel: 50 }),
      });

      assert.ok(await h.waitForSetVolume(51, { timeoutMs: 6000 }), h.context());
      // The TV reports 50 instead of the requested 51: that is not our echo,
      // so the forward path applies it (50 maps to 20).
      assert.ok(await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 }), h.context());
      assert.ok(h.alive(), h.context());
    });

    it('lets a TV change through, then suppresses the poll for the window', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reverse-window-',
        playback: { enabled: false },
        bluos: { volume: { level: 19 } },
        bluosToTv: { enabled: true, pollMs: 250, suppressMs: 1500 },
        luna: tvEchoLuna(),
      });

      // Startup: 49 <-> 19, nothing written.
      assert.ok(await h.waitForLog(/bluos state: level 19/, { timeoutMs: 6000 }), h.context());
      await sleep(300);

      // The TV remote moves to 50: the forward sync is allowed and writes 20.
      fs.appendFileSync(path.join(h.dir, 'tv-echo.jsonl'), JSON.stringify(tvMessage(50, false)) + '\n');
      assert.ok(await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 }), h.context());

      // A BluOS-app change inside the window must not drag the TV back...
      h.fake.setVolume({ level: 21 });
      await sleep(900);
      assert.ok(
        !h.setVolumeCalls().some((call) => call.payload.volume === 51),
        'the reverse sync must be suppressed right after a TV change; ' + h.context(),
      );

      // ...but once the window closes, BluOS wins again.
      assert.ok(await h.waitForSetVolume(51, { timeoutMs: 4000 }), h.context());
      assert.ok(await h.waitForLog(/bluos 21 -> tv 51 \(reverse sync\)/, { timeoutMs: 4000 }), h.context());
    });
  });

  // -------------------------------------------------------------------------
  // Playback guard: re-asserting the digital input
  // -------------------------------------------------------------------------

  describe('playback guard', () => {
    it('re-asserts SPDIF when the TV is playing but the device is stopped', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-playback-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(await h.waitForRequest('/Status', { timeoutMs: 6000 }), 'expected at least one /Status poll; ' + h.context());
      assert.ok(await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }), 'expected ' + PLAY_SPDIF + '; ' + h.context());
      assert.match(h.output(), /tv audible & playing; bluos state=stop service=Capture -> re-asserting input/);
      assert.ok(
        !h.requests.some((url) => /stop|pause/i.test(url)),
        'bridge must never send stop/pause; ' + h.context(),
      );
    });

    it('re-asserts the input for a tuner/HDMI source that reports an empty playState', async (t) => {
      // The play-state fake answers immediately; the volume fake starts after
      // 400 ms so the guard decision runs against the known (unknown) play
      // state, not against the startup fail-open path.
      const h = await startBridge(t, {
        prefix: 'bluos-emptystate-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED_NO_SERVICE },
        luna: {
          playState: { messages: [playStateMessage('', 'com.webos.app.hdmi1')], repeat: true, intervalMs: 50 },
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50, startDelayMs: 400 },
        },
      });

      assert.ok(
        await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }),
        'expected ' + PLAY_SPDIF + ' for an empty playState; ' + h.context(),
      );
      assert.ok(h.requests.some((url) => url.startsWith('/Status')), 'expected at least one /Status poll; ' + h.context());
      assert.ok(!h.requests.some((url) => /stop|pause/i.test(url)), 'bridge must never send stop/pause; ' + h.context());
    });

    it('does not re-assert the input when the foreground app is paused', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-paused-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED_NO_SERVICE },
        luna: {
          playState: { messages: [playStateMessage('paused', 'com.webos.app.netflix')], repeat: true, intervalMs: 50 },
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50, startDelayMs: 400 },
        },
      });

      // Let the TV go audible (volume fake starts at ~400 ms) and run through
      // at least one full guard interval on top.
      const mirrored = await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 });
      await sleep(1200);

      const context = h.context();
      assert.ok(mirrored, 'expected the volume mirror to keep working; ' + context);
      assert.ok(!h.requests.some((url) => url.startsWith('/Play')), 'bridge must not re-assert while the foreground app is paused; ' + context);
      assert.ok(h.alive(), 'bridge crashed; ' + context);
      assert.ok(
        h.requests.some((url) => url.startsWith('/Volume?level=20')),
        'expected the volume mirror to keep working; ' + context,
      );
    });

    it('re-asserts when the device drifted to another source', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-drift-',
        playback: playbackFast(),
        bluos: { statusBody: DRIFTED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(
        await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }),
        'a device streaming from Bluetooth must be pulled back to SPDIF; ' + h.context(),
      );
      // The drift decision needs the status read first.
      assert.match(h.output(), /bluos state=stream service=Bluetooth -> re-asserting input/);
      assert.ok(!h.requests.some((url) => /stop|pause/i.test(url)), 'bridge must never send stop/pause; ' + h.context());
    });

    it('leaves the device alone when it is already playing the expected source', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-healthy-',
        playback: playbackFast(),
        bluos: { statusBody: PLAYING_CAPTURE },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(await h.waitForRequest('/Status', { timeoutMs: 6000 }), h.context());
      await sleep(1300);
      assert.equal(
        h.requests.filter((url) => url.startsWith('/Play')).length,
        0,
        'nothing to fix, so nothing to send; ' + h.context(),
      );
      assert.doesNotMatch(h.output(), /re-asserting input/, h.context());
    });

    it('selects the input by playUrl when one is configured', async (t) => {
      const playUrl = 'http://192.0.2.9:11000/Play?preset=spdif';
      const h = await startBridge(t, {
        prefix: 'bluos-playurl-',
        playback: playbackFast({ playUrl: playUrl }),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(
        await h.waitForRequest('/Play?url=' + encodeURIComponent(playUrl), { timeoutMs: 6000 }),
        h.context(),
      );
      assert.equal(h.requests.filter((url) => url.startsWith('/Play?inputType')).length, 0, h.context());
    });

    it('throttles re-asserts to minReassertMs', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-throttle-',
        playback: { enabled: true, statusMs: 1000, minReassertMs: 60000 },
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }), h.context());
      // The next guard tick (statusMs later) must spot the still-stopped
      // device and refuse to send a second /Play. Poll for it: the interval
      // and statusMs are the same number, so the tick lands a hair early.
      assert.ok(
        await h.waitForLog(/input re-assert throttled \(minReassertMs\)/, { timeoutMs: 8000 }),
        'expected a throttled re-assert; ' + h.context(),
      );
      assert.equal(
        h.requests.filter((url) => url.startsWith('/Play')).length,
        1,
        'a second re-assert inside minReassertMs must be throttled; ' + h.context(),
      );
    });

    it('does nothing at all when playback.enabled is false', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-noplayback-',
        playback: { enabled: false },
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 }), h.context());
      await sleep(1200);
      assert.equal(h.requests.filter((url) => url.startsWith('/Status')).length, 0, 'no guard, no status polls; ' + h.context());
      assert.equal(h.requests.filter((url) => url.startsWith('/Play')).length, 0, h.context());
      // The play-state subscription is not even started.
      assert.equal(countOccurrences(h.output(), 'subscribing to ' + LUNA_PLAY_STATE_URI), 0, h.context());
    });

    it('never sends stop or pause across a mixed scenario', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-neverstop-',
        playback: playbackFast(),
        bluos: { statusBody: statusXml({ state: 'pause', service: 'Bluetooth' }) },
        luna: {
          volume: {
            messages: [tvMessage(60, false), tvMessage(35, false), tvMessage(35, true), tvMessage(50, false)],
            repeat: true,
            intervalMs: 60,
          },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 60 },
        },
      });

      // Make sure the scenario really exercised both the mirror and the guard.
      assert.ok(await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 }), h.context());
      assert.ok(await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }), h.context());
      assert.ok(await h.waitForRequest('/Volume?mute=1', { timeoutMs: 6000 }), h.context());
      assert.ok(!h.requests.some((url) => /stop|pause/i.test(url)), 'bridge must never send stop/pause; ' + h.context());
    });
  });

  // -------------------------------------------------------------------------
  // dryRun
  // -------------------------------------------------------------------------

  describe('dryRun', () => {
    it('logs the intent but sends no mutating request', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-dryrun-',
        dryRun: true,
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      // Both decisions have to be reached: the level write and the input
      // re-assert. The reads must still happen.
      assert.ok(await h.waitForLog(/tv 50 -> bluos 20/, { timeoutMs: 6000 }), h.context());
      assert.ok(await h.waitForLog(/-> re-asserting input/, { timeoutMs: 6000 }), h.context());
      assert.ok(await h.waitForRequest('/Status', { timeoutMs: 6000 }), 'status must still be polled; ' + h.context());
      await sleep(300);

      const mutating = h.requests.filter((url) => /^\/Volume\?/.test(url) || url.startsWith('/Play'));
      assert.deepEqual(mutating, [], 'dryRun must not write to the device; ' + h.context());
      assert.ok(h.requests.includes('/Volume'), 'the read-only /Volume poll still runs; ' + h.context());
      assert.ok(h.alive(), h.context());
    });
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  describe('robustness', () => {
    it('keeps running when BluOS is unreachable', async (t) => {
      const port = await getClosedPort();
      const h = await startBridge(t, {
        prefix: 'bluos-down-',
        serve: false,
        port: port,
        playback: playbackFast(),
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN could not read bluos state: /, { timeoutMs: 6000 }),
        'the startup read should warn; ' + h.context(),
      );
      // Guard polls keep failing too; that must be swallowed at debug level.
      assert.ok(
        await h.waitForLog(/status poll failed/, { timeoutMs: 6000 }),
        'a failing status poll should be logged, not thrown; ' + h.context(),
      );
      await sleep(1200);
      assert.ok(h.alive(), 'the bridge must not crash when the device is down; ' + h.context());
      assert.equal(h.child.exitCode, null, h.context());
      assert.equal(h.child.signalCode, null, h.context());
    });

    it('reconnects a luna-send subscription that exits', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-reconnect-',
        playback: { enabled: false },
        luna: {
          volume: {
            stateFile: '{dir}/volume-phase',
            phases: [
              { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50, exitAfterMs: 300 },
              { messages: [tvMessage(60, false)], repeat: true, intervalMs: 50 },
            ],
          },
        },
      });

      assert.ok(
        await h.waitForLog(/luna-send \(volume\) exited \(code 0, signal null\); reconnecting in 1000ms/, { timeoutMs: 6000 }),
        'the exit should schedule a reconnect; ' + h.context(),
      );
      assert.ok(
        await h.waitFor(() => countOccurrences(h.output(), 'subscribing to ' + LUNA_VOLUME_URI) >= 2, { timeoutMs: 8000 }),
        'expected a second "subscribing to" after the reconnect; ' + h.context(),
      );
      // …and the fresh subscription keeps mirroring: TV 60 -> BluOS 30.
      assert.ok(
        await h.waitForRequest('/Volume?level=30', { timeoutMs: 8000 }),
        'the bridge should keep working after reconnecting; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('fails open and stops reconnecting when getForegroundAppInfo reports an error', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-fatal-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: {
            messages: [{ returnValue: false, errorCode: 1, errorText: 'API not available' }],
            intervalMs: 50,
          },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN getForegroundAppInfo unavailable/, { timeoutMs: 6000 }),
        'a fatal play-state response should warn; ' + h.context(),
      );
      assert.ok(
        await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }),
        'fail-open must keep the guard alive without a play-state API; ' + h.context(),
      );
      await sleep(1300);
      assert.equal(
        countOccurrences(h.output(), 'subscribing to ' + LUNA_PLAY_STATE_URI),
        1,
        'a fatal response stops the subscription for good; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });

    it('stops reconnecting when getForegroundAppInfo never answers at all', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-noanswer-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [], exitAfterMs: 60 },
        },
      });

      assert.ok(
        await h.waitForLog(/WARN getForegroundAppInfo never responded/, { timeoutMs: 6000 }),
        'a silent subscription should be given up on; ' + h.context(),
      );
      assert.ok(await h.waitForRequest('/Volume?level=20', { timeoutMs: 6000 }), 'volume must keep working; ' + h.context());
      await sleep(1300);
      assert.equal(
        countOccurrences(h.output(), 'subscribing to ' + LUNA_PLAY_STATE_URI),
        1,
        'it must not spin reconnecting; ' + h.context(),
      );
      assert.ok(h.alive(), h.context());
    });
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  describe('subscriptions and lifecycle', () => {
    it('passes luna-send stderr through to the log', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-stderr-',
        playback: { enabled: false },
        luna: {
          volume: {
            messages: [tvMessage(49, false)],
            stderrLines: ['warning: something the tool said', '   '],
            repeat: true,
            intervalMs: 50,
          },
        },
      });

      assert.ok(
        await h.waitForLog(/DEBUG luna-send: warning: something the tool said/, { timeoutMs: 6000 }),
        h.context(),
      );
      // A blank stderr line is dropped rather than logged as "luna-send: ".
      assert.doesNotMatch(h.output(), /luna-send: \s*$/m, h.context());
      assert.ok(h.alive(), h.context());
    });

    it('reconnects the play-state subscription after it has answered once', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-ps-reconnect-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: {
            stateFile: '{dir}/ps-phase',
            phases: [
              { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50, exitAfterMs: 300 },
              { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
            ],
          },
        },
      });

      assert.ok(
        await h.waitFor(() => countOccurrences(h.output(), 'subscribing to ' + LUNA_PLAY_STATE_URI) >= 2, { timeoutMs: 8000 }),
        'a play-state subscription that already answered should reconnect; ' + h.context(),
      );
      assert.ok(
        await h.waitForLog(/luna-send \(play state\) exited \(code 0, signal null\); reconnecting in 1000ms/, { timeoutMs: 8000 }),
        h.context(),
      );
      assert.equal(
        countOccurrences(h.output(), 'WARN getForegroundAppInfo never responded'),
        0,
        'it did answer, so it is not "unavailable"; ' + h.context(),
      );
      assert.ok(await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }), h.context());
      assert.ok(h.alive(), h.context());
    });

    it('shuts down cleanly on SIGINT', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-sigint-',
        playback: { enabled: false },
        luna: { volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 } },
      });

      assert.ok(await h.waitForLog(/subscribing to /, { timeoutMs: 6000 }), h.context());
      h.child.kill('SIGINT');
      const result = await h.exited;
      assert.equal(result.code, 0, 'SIGINT should exit 0; ' + h.context());
      assert.match(h.output(), /INFO stopping \(SIGINT\)/);
    });

    it('shuts down cleanly on SIGTERM', async (t) => {
      const h = await startBridge(t, {
        prefix: 'bluos-sigterm-',
        playback: playbackFast(),
        bluos: { statusBody: STOPPED },
        luna: {
          volume: { messages: [tvMessage(50, false)], repeat: true, intervalMs: 50 },
          playState: { messages: [playStateMessage('playing')], repeat: true, intervalMs: 50 },
        },
      });

      assert.ok(await h.waitForRequest(PLAY_SPDIF, { timeoutMs: 6000 }), h.context());
      h.child.kill('SIGTERM');
      const result = await h.exited;
      assert.equal(result.code, 0, 'SIGTERM should exit 0; ' + h.context());
      assert.match(h.output(), /INFO stopping \(SIGTERM\)/);
    });
  });

  describe('command line', () => {
    it('--help prints usage and exits 0', async (t) => {
      const h = await startBridge(t, { serve: false, args: ['--help'], luna: {} });
      const result = await h.exited;
      assert.equal(result.code, 0, 'exit: ' + JSON.stringify(result) + '\nlog:\n' + h.output());
      assert.match(h.stdout(), /Usage: bridge\.js \[--config <path>\] \[--help\]/);
      assert.equal(h.stderr(), '');
    });

    it('-h prints usage and exits 0', async (t) => {
      const h = await startBridge(t, { serve: false, args: ['-h'], luna: {} });
      const result = await h.exited;
      assert.equal(result.code, 0, h.context());
      assert.match(h.stdout(), /Usage:/);
    });

    it('exits non-zero with an error on stderr for a missing config file', async (t) => {
      const h = await startBridge(t, {
        serve: false,
        args: ['--config', '/definitely/not/a/real/config.json'],
        luna: {},
      });
      const result = await h.exited;
      assert.notEqual(result.code, 0, 'expected a non-zero exit; ' + h.context());
      assert.equal(result.code, 1, h.context());
      assert.match(h.stderr(), /bridge: /);
      assert.match(h.stderr(), /ENOENT/);
      assert.equal(h.stdout(), '', 'the error belongs on stderr; ' + h.context());
    });

    it('exits non-zero when --config has no value', async (t) => {
      const h = await startBridge(t, { serve: false, args: ['--config'], luna: {} });
      const result = await h.exited;
      assert.notEqual(result.code, 0, h.context());
      assert.match(h.stderr(), /--config requires a path/);
    });

    it('exits non-zero when the config is invalid', async (t) => {
      const h = await startBridge(t, {
        serve: false,
        config: { bluos: { host: '' } },
        luna: {},
      });
      const result = await h.exited;
      assert.notEqual(result.code, 0, h.context());
      assert.match(h.stderr(), /bluos\.host must be set/);
    });
  });
});
