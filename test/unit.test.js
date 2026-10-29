'use strict';

// Unit tests for the pure functions exported by bridge.js, plus the config
// loader and the logger. Everything here runs in-process: no sockets, no
// child processes.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULTS,
  parseTvLevel,
  mapLevel,
  tvLevelFor,
  plan,
  parseVolume,
  parseStatus,
  sourceMatches,
  planPlayback,
  derivePlayState,
  resolvePlaying,
  loadConfig,
  createLogger,
} = require('../bridge.js');

const { MAPPING } = require('./helpers.js');

function playbackCfg(overrides) {
  return { playback: Object.assign({}, DEFAULTS.playback, overrides || {}) };
}

// ---------------------------------------------------------------------------
// mapLevel
// ---------------------------------------------------------------------------

describe('mapLevel', () => {
  it('maps TV 49 to BluOS 19 with the shipped mapping', () => {
    assert.equal(mapLevel(49, MAPPING), 19);
  });

  it('rounds and clamps', () => {
    assert.equal(mapLevel(49.4, MAPPING), 19);
    assert.equal(mapLevel(49.6, MAPPING), 20);
    assert.equal(mapLevel(0, MAPPING), 0);
    assert.equal(mapLevel(100, MAPPING), 70);
    assert.equal(mapLevel(100, { scale: 2, offset: 0, min: 0, max: 100 }), 100);
    assert.equal(mapLevel(10, { scale: 1, offset: 20, min: 0, max: 100 }), 30);
    assert.equal(mapLevel(1, { scale: 1, offset: -30, min: 5, max: 100 }), 5);
  });

  it('rounds to nearest, and rounds halves up', () => {
    assert.equal(mapLevel(49.5, MAPPING), 20);
    assert.equal(mapLevel(-0.4, MAPPING), 0);
    assert.equal(mapLevel(79.5, MAPPING), 50);
  });

  it('falls back to the default mapping when none is given', () => {
    // The point is the fallback, not the constant: omitting the mapping must
    // behave exactly like passing the shipped default. The literal pins the
    // documented default, which is 1:1 (TV 49 -> BluOS 49).
    assert.equal(mapLevel(49), mapLevel(49, DEFAULTS.mapping));
    assert.equal(mapLevel(49, undefined), mapLevel(49, DEFAULTS.mapping));
    assert.equal(mapLevel(49, null), mapLevel(49, DEFAULTS.mapping));
    assert.equal(mapLevel(49), 49);
  });

  it('accepts numeric strings (validated, then mapped)', () => {
    assert.equal(mapLevel('49', MAPPING), 19);
    assert.equal(mapLevel('49.6', MAPPING), 20);
  });

  it('clamps large finite values into the mapping range', () => {
    assert.equal(mapLevel(1000, MAPPING), 100);
    assert.equal(mapLevel(-1000, MAPPING), 0);
  });

  // The volume path validates before mapping (parseTvLevel), so invalid input
  // yields null rather than NaN or a silent 0 that would look like minimum
  // volume. These are the Fix A regression tests.
  it('returns null for non-numeric and non-finite levels', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, 'abc', {}, [], '', '   ']) {
      assert.equal(mapLevel(bad, MAPPING), null, 'level: ' + String(bad));
    }
  });

  it('returns null for boolean and null levels instead of coercing them to 0/1', () => {
    assert.equal(mapLevel(null, MAPPING), null);
    assert.equal(mapLevel(false, MAPPING), null);
    assert.equal(mapLevel(true, MAPPING), null);
  });
});

// ---------------------------------------------------------------------------
// tvLevelFor
// ---------------------------------------------------------------------------

describe('tvLevelFor', () => {
  it('inverts the shipped mapping', () => {
    assert.equal(tvLevelFor(19, MAPPING), 49);
    assert.equal(tvLevelFor(0, MAPPING), 30);
    assert.equal(tvLevelFor(70, MAPPING), 100);
  });

  it('round-trips every reachable level through mapLevel', () => {
    for (let level = 0; level <= 70; level += 1) {
      const tv = tvLevelFor(level, MAPPING);
      assert.notEqual(tv, null, 'level ' + level + ' should be reachable');
      assert.equal(mapLevel(tv, MAPPING), level, 'level ' + level + ' -> tv ' + tv);
    }
  });

  it('returns null for levels the TV cannot represent', () => {
    assert.equal(tvLevelFor(71, MAPPING), null);
    assert.equal(tvLevelFor(100, MAPPING), null);
    assert.equal(tvLevelFor(-1, MAPPING), null);
    // With scale 2 the odd levels fall between two TV steps.
    const doubled = { scale: 2, offset: 0, min: 0, max: 100 };
    assert.equal(tvLevelFor(2, doubled), 1);
    assert.equal(tvLevelFor(1, doubled), null);
  });

  it('treats levels below a raised minimum as unreachable', () => {
    const raised = { scale: 1, offset: -30, min: 5, max: 100 };
    assert.equal(tvLevelFor(5, raised), 35);
    assert.equal(tvLevelFor(4, raised), null);
  });

  it('handles a negative scale', () => {
    const inverted = { scale: -1, offset: 100, min: 0, max: 100 };
    assert.equal(tvLevelFor(50, inverted), 50);
    assert.equal(tvLevelFor(30, inverted), 70);
    assert.equal(mapLevel(tvLevelFor(30, inverted), inverted), 30);
  });

  it('returns null for scale 0 and invalid levels', () => {
    assert.equal(tvLevelFor(10, { scale: 0, offset: 0, min: 0, max: 100 }), null);
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, false, true, '', '   ', 'abc', {}, []]) {
      assert.equal(tvLevelFor(bad, MAPPING), null, 'level: ' + String(bad));
    }
  });

  it('accepts numeric strings and falls back to the default mapping', () => {
    assert.equal(tvLevelFor('19', MAPPING), 49);
    // Same as above: the fallback must equal the shipped default mapping,
    // which is 1:1, so BluOS 19 is TV 19.
    assert.equal(tvLevelFor(19), tvLevelFor(19, DEFAULTS.mapping));
    assert.equal(tvLevelFor(19, undefined), tvLevelFor(19, DEFAULTS.mapping));
    assert.equal(tvLevelFor(19, null), tvLevelFor(19, DEFAULTS.mapping));
    assert.equal(tvLevelFor(19), 19);
  });
});

// ---------------------------------------------------------------------------
// parseTvLevel
// ---------------------------------------------------------------------------

describe('parseTvLevel', () => {
  it('accepts finite numbers and numeric strings', () => {
    assert.equal(parseTvLevel(0), 0);
    assert.equal(parseTvLevel(49), 49);
    assert.equal(parseTvLevel(49.6), 49.6);
    assert.equal(parseTvLevel(-5), -5);
    assert.equal(parseTvLevel('49'), 49);
    assert.equal(parseTvLevel(' 49.5 '), 49.5);
  });

  it('rejects values that Number() would coerce to a real level', () => {
    // Number(null), Number(false) and Number('') are all 0. None of these
    // may look like a genuine request to set the minimum volume.
    for (const bad of [null, false, true, '', '   ', undefined, NaN, Infinity, -Infinity, {}, [], 'abc']) {
      assert.equal(parseTvLevel(bad), null, 'value: ' + String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe('plan', () => {
  it('applies a level when unmuted and the level changed', () => {
    assert.deepEqual(plan({ level: 19, mute: false }, { level: 20, mute: false }), [
      { type: 'level', level: 20 },
    ]);
  });

  it('does nothing when state already matches', () => {
    assert.deepEqual(plan({ level: 19, mute: false }, { level: 19, mute: false }), []);
    assert.deepEqual(plan({ level: 19, mute: true }, { level: 19, mute: true }), []);
  });

  it('mutes without touching the level', () => {
    assert.deepEqual(plan({ level: 19, mute: false }, { level: 25, mute: true }), [
      { type: 'mute', mute: true },
    ]);
  });

  it('ignores level changes while already muted', () => {
    assert.deepEqual(plan({ level: 19, mute: true }, { level: 25, mute: true }), []);
  });

  it('sets the level before unmuting', () => {
    assert.deepEqual(plan({ level: 19, mute: true }, { level: 25, mute: false }), [
      { type: 'level', level: 25 },
      { type: 'mute', mute: false },
    ]);
  });

  it('handles unknown device state', () => {
    assert.deepEqual(plan(null, { level: 19, mute: false }), [{ type: 'level', level: 19 }]);
    assert.deepEqual(plan(null, { level: 19, mute: true }), [{ type: 'mute', mute: true }]);
  });

  it('never emits an action with a missing level', () => {
    // A null desired level means the TV volume was unusable: do nothing
    // rather than send /Volume?level=null or unmute to a stale level.
    assert.deepEqual(plan(null, { level: null, mute: false }), []);
    assert.deepEqual(plan({ level: 19, mute: false }, { level: null, mute: false }), []);
    assert.deepEqual(plan({ level: 19, mute: true }, { level: null, mute: false }), []);
    assert.deepEqual(plan(null, { level: NaN, mute: false }), []);
    // Muting does not need a level and is still allowed.
    assert.deepEqual(plan({ level: 19, mute: false }, { level: null, mute: true }), [
      { type: 'mute', mute: true },
    ]);
    assert.deepEqual(plan(null, { level: null, mute: true }), [{ type: 'mute', mute: true }]);
  });

  it('treats any falsy "applied" as unknown', () => {
    assert.deepEqual(plan(undefined, { level: 19, mute: false }), [{ type: 'level', level: 19 }]);
    assert.deepEqual(plan(false, { level: 19, mute: true }), [{ type: 'mute', mute: true }]);
    assert.deepEqual(plan({}, { level: 19, mute: false }), [{ type: 'level', level: 19 }]);
  });

  it('re-sends the level even when it only differs from the applied one', () => {
    // An applied mute flag of false with a matching level is a no-op.
    assert.deepEqual(plan({ level: 20, mute: false }, { level: 20, mute: false }), []);
    // …but a mute-state difference always produces an action.
    assert.deepEqual(plan({ level: 20, mute: true }, { level: 20, mute: false }), [
      { type: 'level', level: 20 },
      { type: 'mute', mute: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseVolume
// ---------------------------------------------------------------------------

describe('parseVolume', () => {
  it('reads level and mute', () => {
    const body = '<volume db="-32.4" offsetDb="0" mute="0" etag="x" source="">19</volume>';
    assert.deepEqual(parseVolume(body), { level: 19, mute: false });
  });

  it('uses muteVolume when muted', () => {
    const body = '<volume db="-100" offsetDb="0" mute="1" muteVolume="19" muteDb="-32.4" etag="x" source="">0</volume>';
    assert.deepEqual(parseVolume(body), { level: 19, mute: true });
  });

  it('ignores muteVolume while unmuted', () => {
    const body = '<volume db="-18" offsetDb="0" mute="0" muteVolume="19" etag="x" source="">33</volume>';
    assert.deepEqual(parseVolume(body), { level: 33, mute: false });
  });

  it('returns level null when there is no <volume> element value', () => {
    assert.deepEqual(parseVolume('<status etag="x"></status>'), { level: null, mute: false });
    assert.deepEqual(parseVolume('<volume db="-32.4" mute="0"></volume>'), { level: null, mute: false });
    assert.deepEqual(parseVolume('<volume mute="0">--</volume>'), { level: null, mute: false });
  });

  it('defaults mute to false when the mute attribute is absent', () => {
    assert.deepEqual(parseVolume('<volume>19</volume>'), { level: 19, mute: false });
    // A non 0/1 mute attribute does not match the regex at all -> not muted.
    assert.deepEqual(parseVolume('<volume mute="true">19</volume>'), { level: 19, mute: false });
  });

  it('falls back to the volume element when muted without muteVolume', () => {
    assert.deepEqual(parseVolume('<volume db="-100" mute="1">25</volume>'), { level: 25, mute: true });
  });

  it('reads multi-digit levels', () => {
    assert.deepEqual(parseVolume('<volume mute="0">100</volume>'), { level: 100, mute: false });
    assert.deepEqual(parseVolume('<volume mute="0">0</volume>'), { level: 0, mute: false });
  });

  it('takes the first <volume> element in the document', () => {
    assert.deepEqual(parseVolume('<other>5</other><volume mute="0">19</volume>'), { level: 19, mute: false });
  });

  it('parses the fixed-volume sentinel (-1) and other signed levels', () => {
    assert.deepEqual(parseVolume('<volume mute="0">-1</volume>'), { level: -1, mute: false });
    assert.deepEqual(parseVolume('<volume mute="0">-5</volume>'), { level: -5, mute: false });
    assert.deepEqual(parseVolume('<volume mute="1" muteVolume="-1">0</volume>'), { level: -1, mute: true });
  });

  it('rejects fractional levels (BluOS levels are integers)', () => {
    assert.deepEqual(parseVolume('<volume mute="0">19.5</volume>'), { level: null, mute: false });
    assert.deepEqual(parseVolume('<volume mute="0">-1.5</volume>'), { level: null, mute: false });
  });

  it('never throws on empty or garbage bodies', () => {
    for (const body of ['', '   ', 'not xml at all', '<>', '<?xml version="1.0"?>', null, undefined, 42]) {
      assert.deepEqual(parseVolume(body), { level: null, mute: false }, 'body: ' + String(body));
    }
  });
});

// ---------------------------------------------------------------------------
// parseStatus
// ---------------------------------------------------------------------------

describe('parseStatus', () => {
  it('reads state, service and name', () => {
    const stopped = '<status etag="x"><volume>19</volume><state>stop</state></status>';
    assert.deepEqual(parseStatus(stopped), { state: 'stop', service: null, name: null, inputTypeIndex: null });
    const streaming = '<status etag="x"><state>stream</state><service>Capture</service><name>Optical Input</name></status>';
    assert.deepEqual(parseStatus(streaming), { state: 'stream', service: 'Capture', name: 'Optical Input', inputTypeIndex: null });
    assert.deepEqual(parseStatus('<status etag="x"></status>'), { state: null, service: null, name: null, inputTypeIndex: null });
  });

  it('returns null per field when that element is missing', () => {
    assert.deepEqual(parseStatus('<status><state>play</state></status>'), { state: 'play', service: null, name: null, inputTypeIndex: null });
    assert.deepEqual(parseStatus('<status><service>Capture</service></status>'), { state: null, service: 'Capture', name: null, inputTypeIndex: null });
    assert.deepEqual(parseStatus('<status><name>Optical Input</name></status>'), { state: null, service: null, name: 'Optical Input', inputTypeIndex: null });
  });

  it('returns all nulls for an empty or garbage body', () => {
    const allNull = { state: null, service: null, name: null, inputTypeIndex: null };
    for (const body of ['', '   ', 'garbage', '<>', null, undefined]) {
      assert.deepEqual(parseStatus(body), allNull, 'body: ' + String(body));
    }
  });

  it('trims surrounding whitespace from values', () => {
    assert.deepEqual(
      parseStatus('<status>\n  <state>\tplay \n</state>\n  <service> Capture </service>\n</status>'),
      { state: 'play', service: 'Capture', name: null, inputTypeIndex: null },
    );
  });

  it('accepts an empty state element as the empty string, not null', () => {
    // Current behaviour: `state: ''` is falsy but not null, and planPlayback
    // treats it as "not playing", which is what triggers a re-assert.
    assert.deepEqual(parseStatus('<status><state></state></status>'), { state: '', service: null, name: null, inputTypeIndex: null });
  });

  it('does not match similarly named elements', () => {
    assert.deepEqual(parseStatus('<status><states>play</states></status>'), { state: null, service: null, name: null, inputTypeIndex: null });
    assert.deepEqual(parseStatus('<status><serviceType>x</serviceType></status>'), { state: null, service: null, name: null, inputTypeIndex: null });
  });

  it('takes the first match for repeated elements', () => {
    assert.equal(parseStatus('<status><state>stop</state><state>play</state></status>').state, 'stop');
  });

  it('reads inputTypeIndex, which distinguishes local inputs under service Capture', () => {
    assert.equal(
      parseStatus('<status><service>Capture</service><inputTypeIndex>spdif-1</inputTypeIndex></status>').inputTypeIndex,
      'spdif-1',
    );
    assert.equal(
      parseStatus('<status><service>Capture</service><inputTypeIndex>analog-1</inputTypeIndex></status>').inputTypeIndex,
      'analog-1',
    );
    assert.equal(parseStatus('<status><service>Capture</service></status>').inputTypeIndex, null);
    assert.equal(parseStatus('<status><inputTypeIndexes>x</inputTypeIndexes></status>').inputTypeIndex, null);
  });
});

// ---------------------------------------------------------------------------
// sourceMatches
// ---------------------------------------------------------------------------

describe('sourceMatches', () => {
  it('always matches when enforceSource is off', () => {
    assert.equal(sourceMatches(null, playbackCfg({ enforceSource: false })), true);
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: 'Perfect' }, playbackCfg({ enforceSource: false })), true);
    assert.equal(sourceMatches({ state: null, service: null, name: null }, playbackCfg({ enforceSource: false })), true);
  });

  it('never matches a missing status when enforceSource is on', () => {
    assert.equal(sourceMatches(null, playbackCfg()), false);
    assert.equal(sourceMatches(undefined, playbackCfg()), false);
  });

  it('matches the service case-insensitively', () => {
    assert.equal(sourceMatches({ state: 'stream', service: 'capture', name: null }, playbackCfg()), true);
    assert.equal(sourceMatches({ state: 'stream', service: 'CAPTURE', name: null }, playbackCfg()), true);
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: null }, playbackCfg()), false);
  });

  it('matches the name case-insensitively when the service does not match', () => {
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: 'Perfect' }, playbackCfg({ expectedName: 'perfect' })), true);
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: 'Perfect' }, playbackCfg({ expectedName: 'Other' })), false);
  });

  it('returns false when neither service nor name matches', () => {
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: 'Perfect' }, playbackCfg()), false);
    assert.equal(sourceMatches({ state: null, service: null, name: null }, playbackCfg()), false);
    assert.equal(sourceMatches({}, playbackCfg()), false);
  });

  it('skips an empty or null expectedName, and honours a null expectedService', () => {
    const status = { state: 'stream', service: 'Bluetooth', name: 'Perfect' };
    assert.equal(sourceMatches(status, playbackCfg({ expectedService: null, expectedName: '' })), false);
    assert.equal(sourceMatches(status, playbackCfg({ expectedService: null, expectedName: 'Perfect' })), true);
    assert.equal(sourceMatches(status, playbackCfg({ expectedService: null })), false);
  });

  it('falls back to the default playback config when cfg is missing', () => {
    // DEFAULTS.playback: enforceSource true, expectedService 'Capture'.
    assert.equal(sourceMatches({ state: 'stream', service: 'Capture', name: null }), true);
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: null }), false);
    assert.equal(sourceMatches(null), false);
  });

  it('distinguishes local inputs by inputTypeIndex (all report service Capture)', () => {
    const base = { state: 'stream', service: 'Capture', name: null };
    assert.equal(sourceMatches({ ...base, inputTypeIndex: 'spdif-1' }, playbackCfg()), true);
    assert.equal(sourceMatches({ ...base, inputTypeIndex: 'analog-1' }, playbackCfg()), false);
    assert.equal(sourceMatches({ ...base, inputTypeIndex: 'bluetooth-1' }, playbackCfg()), false);
    assert.equal(sourceMatches({ ...base, inputTypeIndex: 'SPDIF-1' }, playbackCfg()), true);
    assert.equal(sourceMatches({ ...base, inputTypeIndex: 'spdif' }, playbackCfg()), true);
  });

  it('falls back to the service when inputTypeIndex is absent', () => {
    assert.equal(sourceMatches({ state: 'stream', service: 'Capture', name: null }, playbackCfg()), true);
    assert.equal(sourceMatches({ state: 'stream', service: 'Bluetooth', name: null }, playbackCfg()), false);
  });

  it('lets an explicit expectedName override the input type', () => {
    const analog = { state: 'stream', service: 'Capture', name: 'Analog Input', inputTypeIndex: 'analog-1' };
    assert.equal(sourceMatches(analog, playbackCfg({ expectedName: 'Analog Input' })), true);
    assert.equal(sourceMatches(analog, playbackCfg({ expectedName: 'Other' })), false);
  });
});

// ---------------------------------------------------------------------------
// planPlayback
// ---------------------------------------------------------------------------

describe('planPlayback', () => {
  it('does nothing when the TV is not audible or not playing', () => {
    const cfg = playbackCfg();
    const status = { state: 'stop', service: 'Capture', name: null };
    assert.deepEqual(planPlayback({ tv: { level: 20, mute: true }, playing: true, status, cfg }), []);
    assert.deepEqual(planPlayback({ tv: { level: 0, mute: false }, playing: true, status, cfg }), []);
    assert.deepEqual(planPlayback({ tv: null, playing: true, status, cfg }), []);
    assert.deepEqual(planPlayback({ tv: { level: 20, mute: false }, playing: false, status, cfg }), []);
  });

  it('re-asserts the input when the device is stopped or on another source', () => {
    const cfg = playbackCfg();
    const tv = { level: 20, mute: false };
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: { state: 'stop', service: 'Capture', name: null }, cfg }),
      [{ type: 'input' }],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: { state: 'stream', service: 'Capture', name: null }, cfg }),
      [],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: { state: 'play', service: 'Capture', name: null }, cfg }),
      [],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: { state: 'stream', service: 'Bluetooth', name: null }, cfg }),
      [{ type: 'input' }],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: { state: 'stream', service: 'Bluetooth', name: 'Perfect' }, cfg }),
      [{ type: 'input' }],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: null, cfg }),
      [{ type: 'input' }],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status: { state: 'stop', service: 'Capture', name: null }, cfg: playbackCfg({ enabled: false }) }),
      [],
    );
  });

  it('honours enforceSource and expectedName', () => {
    const tv = { level: 20, mute: false };
    const status = { state: 'stream', service: 'Bluetooth', name: 'Perfect' };
    assert.deepEqual(
      planPlayback({ tv, playing: true, status, cfg: playbackCfg({ enforceSource: false }) }),
      [],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status, cfg: playbackCfg({ expectedName: 'Perfect' }) }),
      [],
    );
    assert.deepEqual(
      planPlayback({ tv, playing: true, status, cfg: playbackCfg({ expectedName: 'Other' }) }),
      [{ type: 'input' }],
    );
  });

  it('re-asserts for any state that is not play or stream', () => {
    const tv = { level: 20, mute: false };
    for (const state of ['stop', 'pause', '', 'buffering', undefined, null]) {
      assert.deepEqual(
        planPlayback({ tv, playing: true, status: { state: state, service: 'Capture', name: null }, cfg: playbackCfg() }),
        [{ type: 'input' }],
        'state: ' + String(state),
      );
    }
  });

  it('only treats playing === true as playing', () => {
    const tv = { level: 20, mute: false };
    const status = { state: 'stop', service: 'Capture', name: null };
    for (const playing of [false, null, undefined, 'true', 'unknown', 0, 1]) {
      assert.deepEqual(planPlayback({ tv, playing: playing, status, cfg: playbackCfg() }), [],
        'playing: ' + String(playing));
    }
  });

  it('documents the audibility check for missing and stringy levels', () => {
    const cfg = playbackCfg();
    const status = { state: 'stop', service: 'Capture', name: null };
    assert.deepEqual(planPlayback({ tv: { level: undefined, mute: false }, playing: true, status, cfg }), []);
    assert.deepEqual(planPlayback({ tv: { level: null, mute: false }, playing: true, status, cfg }), []);
    assert.deepEqual(planPlayback({ tv: { level: NaN, mute: false }, playing: true, status, cfg }), []);
    // A string level compares numerically with >, so '0' is inaudible and '20' is audible.
    assert.deepEqual(planPlayback({ tv: { level: '0', mute: false }, playing: true, status, cfg }), []);
    assert.deepEqual(planPlayback({ tv: { level: '20', mute: false }, playing: true, status, cfg }), [{ type: 'input' }]);
  });

  it('does nothing when playback.enabled is false, whatever else says', () => {
    const cfg = playbackCfg({ enabled: false, enforceSource: true });
    assert.deepEqual(planPlayback({ tv: { level: 50, mute: false }, playing: true, status: null, cfg }), []);
  });

  it('falls back to the default playback config when cfg is missing', () => {
    // DEFAULTS.playback: enabled, enforceSource, expectedService 'Capture'.
    assert.deepEqual(
      planPlayback({ tv: { level: 20, mute: false }, playing: true, status: { state: 'play', service: 'Capture' } }),
      [],
    );
    assert.deepEqual(planPlayback({ tv: { level: 20, mute: false }, playing: true, status: null }), [{ type: 'input' }]);
  });
});

// ---------------------------------------------------------------------------
// derivePlayState
// ---------------------------------------------------------------------------

describe('derivePlayState', () => {
  it('collapses foregroundAppInfo into a tri-state', () => {
    assert.equal(derivePlayState([{ playState: 'playing' }]), 'playing');
    assert.equal(derivePlayState([{ playState: 'paused' }]), 'notplaying');
    assert.equal(derivePlayState([{ playState: 'unloaded' }]), 'notplaying');
    assert.equal(derivePlayState([{ playState: 'stopped' }]), 'notplaying');
    assert.equal(derivePlayState([]), 'unknown');
    assert.equal(derivePlayState([{ playState: '' }]), 'unknown');
    assert.equal(derivePlayState([{ playState: 'none' }]), 'unknown');
    assert.equal(derivePlayState([{ appId: 'x' }]), 'unknown');
    assert.equal(derivePlayState([{ playState: 'paused' }, { playState: 'playing' }]), 'playing');
    assert.equal(derivePlayState(null), 'unknown');
    assert.equal(derivePlayState('playing'), 'unknown');
    assert.equal(derivePlayState({ playState: 'playing' }), 'unknown');
    assert.equal(derivePlayState([null, { playState: 'paused' }]), 'notplaying');
    assert.equal(derivePlayState([null]), 'unknown');
  });

  it('treats an undefined array as unknown', () => {
    assert.equal(derivePlayState(undefined), 'unknown');
    assert.equal(derivePlayState(0), 'unknown');
    assert.equal(derivePlayState(false), 'unknown');
  });

  it('is case sensitive about playState values', () => {
    // Current behaviour: only the exact lowercase spellings count.
    assert.equal(derivePlayState([{ playState: 'PLAYING' }]), 'unknown');
    assert.equal(derivePlayState([{ playState: 'Paused' }]), 'unknown');
  });

  it('still returns playing when it appears after inactive entries', () => {
    assert.equal(derivePlayState([{ playState: 'stopped' }, { playState: 'unloaded' }, { playState: 'playing' }]), 'playing');
  });
});

// ---------------------------------------------------------------------------
// resolvePlaying
// ---------------------------------------------------------------------------

describe('resolvePlaying', () => {
  it('applies fail-open and treatUnknownAsPlaying', () => {
    // API unavailable -> fail-open decides.
    assert.equal(resolvePlaying({ playStateAvailable: false, tvPlayState: 'unknown' }, playbackCfg()), true);
    assert.equal(resolvePlaying({ playStateAvailable: false, tvPlayState: 'unknown' }, playbackCfg({ failOpen: false })), false);
    assert.equal(resolvePlaying({ playStateAvailable: null, tvPlayState: 'unknown' }, playbackCfg()), true);
    assert.equal(resolvePlaying({ playStateAvailable: false, tvPlayState: 'notplaying' }, playbackCfg()), true);
    // Available -> the explicit playState wins, whatever the knobs say.
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'playing' }, playbackCfg({ failOpen: false })), true);
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'notplaying' }, playbackCfg()), false);
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'notplaying' }, playbackCfg({ treatUnknownAsPlaying: true })), false);
    // Available but unknown -> treatUnknownAsPlaying decides.
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'unknown' }, playbackCfg()), true);
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'unknown' }, playbackCfg({ treatUnknownAsPlaying: false })), false);
  });

  it('only treats playStateAvailable === true as available', () => {
    // A truthy-but-not-true value still means "unavailable" -> fail-open rules.
    assert.equal(resolvePlaying({ playStateAvailable: 'yes', tvPlayState: 'notplaying' }, playbackCfg()), true);
    assert.equal(resolvePlaying({ playStateAvailable: 'yes', tvPlayState: 'notplaying' }, playbackCfg({ failOpen: false })), false);
    assert.equal(resolvePlaying({ playStateAvailable: 1, tvPlayState: 'playing' }, playbackCfg({ failOpen: false })), false);
  });

  it('falls back to the default playback config when cfg is missing', () => {
    assert.equal(resolvePlaying({ playStateAvailable: false, tvPlayState: 'notplaying' }, undefined), true);
    assert.equal(resolvePlaying({ playStateAvailable: false, tvPlayState: 'notplaying' }, {}), true);
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'unknown' }, {}), true);
  });

  it('coerces the return value to a boolean', () => {
    assert.equal(typeof resolvePlaying({ playStateAvailable: true, tvPlayState: 'unknown' }, playbackCfg({ treatUnknownAsPlaying: 0 })), 'boolean');
    assert.equal(resolvePlaying({ playStateAvailable: true, tvPlayState: 'unknown' }, playbackCfg({ treatUnknownAsPlaying: 0 })), false);
    assert.equal(resolvePlaying({ playStateAvailable: false, tvPlayState: 'unknown' }, playbackCfg({ failOpen: 1 })), true);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  const HOST = '192.0.2.10';
  let dir;
  let file;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluos-cfg-'));
    file = path.join(dir, 'config.json');
  });
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(config) {
    fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
    return file;
  }
  function load(config) {
    return loadConfig(write(config));
  }
  function rejects(config, expected) {
    assert.throws(() => load(config), expected);
  }

  it('loads a minimal valid config with every default filled in', () => {
    const cfg = load({ bluos: { host: HOST } });
    assert.equal(cfg.bluos.host, HOST);
    assert.equal(cfg.bluos.port, 11000);
    assert.equal(cfg.bluos.timeoutMs, 2000);
    assert.equal(cfg.mapping.scale, 1);
    assert.equal(cfg.mapping.offset, 0);
    assert.equal(cfg.mapping.min, 0);
    assert.equal(cfg.mapping.max, 100);
    assert.equal(cfg.debounceMs, 130);
    assert.equal(cfg.syncOnStart, true);
    assert.equal(cfg.reconcileMs, 5000);
    assert.equal(cfg.logLevel, 'info');
    assert.equal(cfg.dryRun, false);
    assert.deepEqual(cfg.bluosToTv, { enabled: true, pollMs: 1000, suppressMs: 1500 });
    assert.deepEqual(cfg.playback, {
      enabled: true,
      inputType: 'spdif',
      index: 0,
      playUrl: null,
      statusMs: 10000,
      minReassertMs: 10000,
      enforceSource: true,
      expectedService: 'Capture',
      expectedName: null,
      failOpen: true,
      treatUnknownAsPlaying: true,
    });
  });

  it('keeps unknown top-level and playback keys instead of validating them away', () => {
    const cfg = load({ bluos: { host: HOST }, someFutureOption: 7, playback: { expectdService: 'Bluetooth' } });
    assert.equal(cfg.someFutureOption, 7);
    // A typo in a playback key is silently ignored: the default stands.
    assert.equal(cfg.playback.expectdService, 'Bluetooth');
    assert.equal(cfg.playback.expectedService, 'Capture');
  });

  describe('bluos section', () => {
    it('rejects a missing or empty host', () => {
      rejects({}, /bluos\.host must be set to the BluOS group leader address/);
      rejects({ bluos: {} }, /bluos\.host must be set/);
      rejects({ bluos: { host: '' } }, /bluos\.host must be set/);
      rejects({ bluos: { host: 42 } }, /bluos\.host must be set/);
      rejects({ bluos: { host: null } }, /bluos\.host must be set/);
    });

    it('rejects an out-of-range or non-integer port', () => {
      rejects({ bluos: { host: HOST, port: 0 } }, /bluos\.port must be an integer 1\.\.65535/);
      rejects({ bluos: { host: HOST, port: -1 } }, /bluos\.port must be an integer 1\.\.65535/);
      rejects({ bluos: { host: HOST, port: 65536 } }, /bluos\.port must be an integer 1\.\.65535/);
      rejects({ bluos: { host: HOST, port: 11000.5 } }, /bluos\.port must be an integer 1\.\.65535/);
      rejects({ bluos: { host: HOST, port: '11000' } }, /bluos\.port must be an integer 1\.\.65535/);
      rejects({ bluos: { host: HOST, port: null } }, /bluos\.port must be an integer 1\.\.65535/);
    });

    it('accepts the port boundaries', () => {
      assert.equal(load({ bluos: { host: HOST, port: 1 } }).bluos.port, 1);
      assert.equal(load({ bluos: { host: HOST, port: 65535 } }).bluos.port, 65535);
    });

    it('rejects a non-positive or non-finite timeoutMs', () => {
      rejects({ bluos: { host: HOST, timeoutMs: 0 } }, /bluos\.timeoutMs must be > 0/);
      rejects({ bluos: { host: HOST, timeoutMs: -5 } }, /bluos\.timeoutMs must be > 0/);
      rejects({ bluos: { host: HOST, timeoutMs: 'fast' } }, /bluos\.timeoutMs must be > 0/);
      rejects({ bluos: { host: HOST, timeoutMs: null } }, /bluos\.timeoutMs must be > 0/);
      assert.equal(load({ bluos: { host: HOST, timeoutMs: 1 } }).bluos.timeoutMs, 1);
    });
  });

  describe('mapping section', () => {
    it('rejects a non-numeric scale', () => {
      rejects({ bluos: { host: HOST }, mapping: { scale: 'x' } }, /mapping\.scale must be a number/);
      rejects({ bluos: { host: HOST }, mapping: { scale: null } }, /mapping\.scale must be a number/);
    });
    it('rejects a non-numeric offset', () => {
      rejects({ bluos: { host: HOST }, mapping: { offset: 'x' } }, /mapping\.offset must be a number/);
      rejects({ bluos: { host: HOST }, mapping: { offset: null } }, /mapping\.offset must be a number/);
    });
    it('rejects non-finite or inverted min/max', () => {
      rejects({ bluos: { host: HOST }, mapping: { min: null } }, /mapping\.min\/mapping\.max are invalid/);
      rejects({ bluos: { host: HOST }, mapping: { max: 'x' } }, /mapping\.min\/mapping\.max are invalid/);
      rejects({ bluos: { host: HOST }, mapping: { min: 50, max: 10 } }, /mapping\.min\/mapping\.max are invalid/);
      rejects({ bluos: { host: HOST }, mapping: { min: 101 } }, /mapping\.min\/mapping\.max are invalid/);
    });
    it('accepts min === max and negative bounds', () => {
      const cfg = load({ bluos: { host: HOST }, mapping: { scale: 1, offset: 0, min: -10, max: -10 } });
      assert.equal(cfg.mapping.min, -10);
      assert.equal(cfg.mapping.max, -10);
    });
  });

  describe('top-level knobs', () => {
    it('rejects a negative debounceMs', () => {
      rejects({ bluos: { host: HOST }, debounceMs: -1 }, /debounceMs must be >= 0/);
      rejects({ bluos: { host: HOST }, debounceMs: 'x' }, /debounceMs must be >= 0/);
      rejects({ bluos: { host: HOST }, debounceMs: null }, /debounceMs must be >= 0/);
      assert.equal(load({ bluos: { host: HOST }, debounceMs: 0 }).debounceMs, 0);
    });

    it('rejects reconcileMs below 100', () => {
      rejects({ bluos: { host: HOST }, reconcileMs: 99 }, /reconcileMs must be >= 100/);
      rejects({ bluos: { host: HOST }, reconcileMs: 0 }, /reconcileMs must be >= 100/);
      rejects({ bluos: { host: HOST }, reconcileMs: 'x' }, /reconcileMs must be >= 100/);
      assert.equal(load({ bluos: { host: HOST }, reconcileMs: 100 }).reconcileMs, 100);
    });

    it('rejects an unknown logLevel', () => {
      rejects({ bluos: { host: HOST }, logLevel: 'verbose' }, /logLevel must be one of debug, info, warn, error/);
      rejects({ bluos: { host: HOST }, logLevel: '' }, /logLevel must be one of/);
      rejects({ bluos: { host: HOST }, logLevel: null }, /logLevel must be one of/);
      for (const level of ['debug', 'info', 'warn', 'error']) {
        assert.equal(load({ bluos: { host: HOST }, logLevel: level }).logLevel, level);
      }
    });

    it('coerces the boolean knobs', () => {
      assert.equal(load({ bluos: { host: HOST }, syncOnStart: 0 }).syncOnStart, false);
      assert.equal(load({ bluos: { host: HOST }, syncOnStart: 1 }).syncOnStart, true);
      assert.equal(load({ bluos: { host: HOST }, dryRun: 1 }).dryRun, true);
      assert.equal(load({ bluos: { host: HOST }, dryRun: null }).dryRun, false);
      // Current behaviour: the coercion is `!!`, so a non-empty string is
      // truthy no matter what it spells. Documented, not fixed.
      assert.equal(load({ bluos: { host: HOST }, dryRun: 'false' }).dryRun, true);
      assert.equal(load({ bluos: { host: HOST }, syncOnStart: 'off' }).syncOnStart, true);
    });
  });

  describe('playback section', () => {
    it('rejects an empty or non-string inputType', () => {
      rejects({ bluos: { host: HOST }, playback: { inputType: '' } }, /playback\.inputType must be a non-empty string/);
      rejects({ bluos: { host: HOST }, playback: { inputType: 42 } }, /playback\.inputType must be a non-empty string/);
      rejects({ bluos: { host: HOST }, playback: { inputType: null } }, /playback\.inputType must be a non-empty string/);
      assert.equal(load({ bluos: { host: HOST }, playback: { inputType: 'hdmi' } }).playback.inputType, 'hdmi');
    });

    it('rejects a non-integer or negative index', () => {
      rejects({ bluos: { host: HOST }, playback: { index: -1 } }, /playback\.index must be an integer >= 0/);
      rejects({ bluos: { host: HOST }, playback: { index: 1.5 } }, /playback\.index must be an integer >= 0/);
      rejects({ bluos: { host: HOST }, playback: { index: '0' } }, /playback\.index must be an integer >= 0/);
      rejects({ bluos: { host: HOST }, playback: { index: null } }, /playback\.index must be an integer >= 0/);
      assert.equal(load({ bluos: { host: HOST }, playback: { index: 0 } }).playback.index, 0);
    });

    it('rejects statusMs below 1000', () => {
      rejects({ bluos: { host: HOST }, playback: { statusMs: 100 } }, /playback\.statusMs must be >= 1000/);
      rejects({ bluos: { host: HOST }, playback: { statusMs: 999 } }, /playback\.statusMs must be >= 1000/);
      rejects({ bluos: { host: HOST }, playback: { statusMs: 'x' } }, /playback\.statusMs must be >= 1000/);
      assert.equal(load({ bluos: { host: HOST }, playback: { statusMs: 1000 } }).playback.statusMs, 1000);
    });

    it('rejects minReassertMs below 1000', () => {
      rejects({ bluos: { host: HOST }, playback: { minReassertMs: 100 } }, /playback\.minReassertMs must be >= 1000/);
      rejects({ bluos: { host: HOST }, playback: { minReassertMs: 999 } }, /playback\.minReassertMs must be >= 1000/);
      rejects({ bluos: { host: HOST }, playback: { minReassertMs: null } }, /playback\.minReassertMs must be >= 1000/);
      assert.equal(load({ bluos: { host: HOST }, playback: { minReassertMs: 1000 } }).playback.minReassertMs, 1000);
    });

    it('rejects an empty or non-string playUrl', () => {
      rejects({ bluos: { host: HOST }, playback: { playUrl: '' } }, /playback\.playUrl must be null or a non-empty string/);
      rejects({ bluos: { host: HOST }, playback: { playUrl: 42 } }, /playback\.playUrl must be null or a non-empty string/);
      rejects({ bluos: { host: HOST }, playback: { playUrl: false } }, /playback\.playUrl must be null or a non-empty string/);
      assert.equal(load({ bluos: { host: HOST }, playback: { playUrl: null } }).playback.playUrl, null);
      assert.equal(load({ bluos: { host: HOST }, playback: { playUrl: 'http://x/y' } }).playback.playUrl, 'http://x/y');
    });

    it('rejects a non-null, non-string expectedService', () => {
      rejects({ bluos: { host: HOST }, playback: { expectedService: 42 } }, /playback\.expectedService must be null or a string/);
      rejects({ bluos: { host: HOST }, playback: { expectedService: false } }, /playback\.expectedService must be null or a string/);
      assert.equal(load({ bluos: { host: HOST }, playback: { expectedService: null } }).playback.expectedService, null);
      assert.equal(load({ bluos: { host: HOST }, playback: { expectedService: '' } }).playback.expectedService, '');
    });

    it('rejects a non-null, non-string expectedName', () => {
      rejects({ bluos: { host: HOST }, playback: { expectedName: 42 } }, /playback\.expectedName must be null or a string/);
      rejects({ bluos: { host: HOST }, playback: { expectedName: true } }, /playback\.expectedName must be null or a string/);
      assert.equal(load({ bluos: { host: HOST }, playback: { expectedName: 'Perfect' } }).playback.expectedName, 'Perfect');
    });

    it('coerces the playback booleans', () => {
      const cfg = load({
        bluos: { host: HOST },
        playback: { enabled: 0, enforceSource: 'no', failOpen: '', treatUnknownAsPlaying: 1 },
      });
      assert.equal(cfg.playback.enabled, false);
      assert.equal(cfg.playback.enforceSource, true, 'a non-empty string is truthy');
      assert.equal(cfg.playback.failOpen, false);
      assert.equal(cfg.playback.treatUnknownAsPlaying, true);
    });

    it('merges a partial section over the defaults', () => {
      const cfg = load({
        bluos: { host: HOST },
        playback: { enabled: false, inputType: 'hdmi', statusMs: 30000 },
      });
      assert.equal(cfg.playback.enabled, false);
      assert.equal(cfg.playback.inputType, 'hdmi');
      assert.equal(cfg.playback.statusMs, 30000);
      assert.equal(cfg.playback.index, 0);
      assert.equal(cfg.playback.playUrl, null);
      assert.equal(cfg.playback.minReassertMs, 10000);
      assert.equal(cfg.playback.enforceSource, true);
      assert.equal(cfg.playback.expectedService, 'Capture');
      assert.equal(cfg.playback.expectedName, null);
      assert.equal(cfg.playback.failOpen, true);
      assert.equal(cfg.playback.treatUnknownAsPlaying, true);
      assert.equal(load({ bluos: { host: HOST }, playback: { treatUnknownAsPlaying: false } }).playback.treatUnknownAsPlaying, false);
    });
  });

  describe('bluosToTv section', () => {
    it('merges a partial section over the defaults', () => {
      const cfg = load({ bluos: { host: HOST }, bluosToTv: { enabled: false, pollMs: 500 } });
      assert.equal(cfg.bluosToTv.enabled, false);
      assert.equal(cfg.bluosToTv.pollMs, 500);
      assert.equal(cfg.bluosToTv.suppressMs, 1500);
    });

    it('coerces the enabled flag', () => {
      assert.equal(load({ bluos: { host: HOST }, bluosToTv: { enabled: 0 } }).bluosToTv.enabled, false);
      assert.equal(load({ bluos: { host: HOST }, bluosToTv: { enabled: 1 } }).bluosToTv.enabled, true);
      assert.equal(load({ bluos: { host: HOST }, bluosToTv: { enabled: '' } }).bluosToTv.enabled, false);
    });

    it('rejects a pollMs below 250 or non-finite', () => {
      rejects({ bluos: { host: HOST }, bluosToTv: { pollMs: 249 } }, /bluosToTv\.pollMs must be >= 250/);
      rejects({ bluos: { host: HOST }, bluosToTv: { pollMs: 0 } }, /bluosToTv\.pollMs must be >= 250/);
      rejects({ bluos: { host: HOST }, bluosToTv: { pollMs: 'fast' } }, /bluosToTv\.pollMs must be >= 250/);
      rejects({ bluos: { host: HOST }, bluosToTv: { pollMs: null } }, /bluosToTv\.pollMs must be >= 250/);
      assert.equal(load({ bluos: { host: HOST }, bluosToTv: { pollMs: 250 } }).bluosToTv.pollMs, 250);
    });

    it('rejects a negative or non-finite suppressMs', () => {
      rejects({ bluos: { host: HOST }, bluosToTv: { suppressMs: -1 } }, /bluosToTv\.suppressMs must be >= 0/);
      rejects({ bluos: { host: HOST }, bluosToTv: { suppressMs: 'x' } }, /bluosToTv\.suppressMs must be >= 0/);
      rejects({ bluos: { host: HOST }, bluosToTv: { suppressMs: null } }, /bluosToTv\.suppressMs must be >= 0/);
      assert.equal(load({ bluos: { host: HOST }, bluosToTv: { suppressMs: 0 } }).bluosToTv.suppressMs, 0);
    });

    it('rejects a non-object section instead of spreading it', () => {
      // A bare string/array would spread into a plain object and silently
      // keep the defaults, so it is rejected before the merge.
      rejects({ bluos: { host: HOST }, bluosToTv: 'off' }, /bluosToTv must be an object/);
      rejects({ bluos: { host: HOST }, bluosToTv: false }, /bluosToTv must be an object/);
      rejects({ bluos: { host: HOST }, bluosToTv: null }, /bluosToTv must be an object/);
      rejects({ bluos: { host: HOST }, bluosToTv: [1] }, /bluosToTv must be an object/);
    });
  });

  describe('malformed files', () => {
    it('throws on invalid JSON', () => {
      assert.throws(() => load('{not json'), SyntaxError);
      assert.throws(() => load(''), SyntaxError);
    });

    it('throws ENOENT for a missing file', () => {
      assert.throws(() => loadConfig(path.join(dir, 'does-not-exist.json')), { code: 'ENOENT' });
    });

    it('throws on a JSON document that is not an object', () => {
      // JSON.parse succeeds, then every property read of the primitive falls
      // back to the defaults, so a bare array/string fails on bluos.host.
      rejects('"192.0.2.10"', /bluos\.host must be set/);
      rejects('[]', /bluos\.host must be set/);
      // `null` is the one shape that gets further: spreading null is legal,
      // reading `.bluos` off it is not. Documented, not fixed.
      assert.throws(() => load('null'), TypeError);
    });
  });

  it('loads the shipped config.json that ships with the repo', () => {
    const cfg = loadConfig(path.join(__dirname, '..', 'config.json'));
    assert.equal(typeof cfg.bluos.host, 'string');
    assert.ok(cfg.bluos.host.length > 0);
    assert.equal(cfg.playback.inputType, 'spdif');
  });
});

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  function captureLogs(t, level, fn) {
    t.mock.method(console, 'log', () => {});
    fn(createLogger(level));
    return console.log.mock.calls.map((call) => String((call.arguments || call.args || [])[0]));
  }

  it('emits every level at debug', (t) => {
    const lines = captureLogs(t, 'debug', (log) => {
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    });
    assert.deepEqual(lines.map((line) => line.split(' ')[1]), ['DEBUG', 'INFO', 'WARN', 'ERROR']);
    assert.ok(lines[0].endsWith(' DEBUG d'));
  });

  it('filters below the configured threshold', (t) => {
    const lines = captureLogs(t, 'warn', (log) => {
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    });
    assert.deepEqual(lines.map((line) => line.split(' ')[1]), ['WARN', 'ERROR']);
  });

  it('filters everything but error at error', (t) => {
    const lines = captureLogs(t, 'error', (log) => {
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith(' ERROR e'), lines[0]);
  });

  it('silences everything above the threshold', (t) => {
    const lines = captureLogs(t, 'error', (log) => {
      log.debug('d'); log.info('i'); log.warn('w');
    });
    assert.deepEqual(lines, []);
  });

  it('defaults to info for an unknown level', (t) => {
    const lines = captureLogs(t, 'nope', (log) => {
      log.debug('d'); log.info('i'); log.warn('w');
    });
    assert.deepEqual(lines.map((line) => line.split(' ')[1]), ['INFO', 'WARN']);
  });

  it('prefixes each line with an ISO timestamp', (t) => {
    const lines = captureLogs(t, 'info', (log) => log.info('hello world'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO hello world$/);
  });
});
