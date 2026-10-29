#!/usr/bin/env node
'use strict';

// LG webOS TV volume/mute <-> BluOS group volume/mute.
//
// The TV is the slave for volume: bluosToTv polls the player and drives the TV
// volume, so the TV display matches what the soundbar is actually doing. TV
// volume changes still go the other way (the TV remote must keep working),
// with echo suppression so the two paths cannot fight.
//
// While the TV is audible and playing, the bridge also re-asserts the digital
// SPDIF input on the BluOS device, so a stopped or drifted player starts
// again. It only ever re-asserts play/input; it never sends Stop or Pause.
//
// Hardware quirks this code works around:
//  * luna-send silently does nothing unless stdin is not a tty (we use 'ignore').
//  * BluOS unmutes when a level is set while muted, so levels are never sent
//    while the TV is muted. On unmute the level is set before mute=0, otherwise
//    the stale muteVolume would be restored.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const LUNA_BIN_DEFAULT = '/usr/bin/luna-send';
const LUNA_URI = 'luna://com.webos.service.audio/master/getVolume';
const SET_VOLUME_URI = 'luna://com.webos.service.audio/master/setVolume';
const PLAY_STATE_URI = 'luna://com.webos.media/getForegroundAppInfo';
const LUNA_TIMEOUT_MS = 3000;

const DEFAULTS = {
  bluos: { port: 11000, timeoutMs: 2000 },
  mapping: { scale: 1, offset: 0, min: 0, max: 100 },
  debounceMs: 130,
  syncOnStart: true,
  reconcileMs: 5000,
  logLevel: 'info',
  dryRun: false,
  // BluOS -> TV: the soundbar is the authority, the TV display follows it.
  bluosToTv: { enabled: true, pollMs: 1000, suppressMs: 1500 },
  playback: {
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
  },
};

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Validate a TV volume value from luna. Returns a finite number or null.
// Booleans, null, undefined, objects and empty strings are rejected rather
// than coerced: Number(null) and Number(false) are both 0, which would look
// like a real request to drive the player to minimum volume.
function parseTvLevel(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

// TV 0..100 -> BluOS 0..100. With the shipped defaults TV 49 becomes 19.
// Invalid input yields null so callers can skip the update instead of sending
// a NaN or a bogus minimum level.
function mapLevel(tvLevel, mapping) {
  const m = mapping || DEFAULTS.mapping;
  const value = parseTvLevel(tvLevel);
  if (value === null) return null;
  return clamp(Math.round(value * m.scale + m.offset), m.min, m.max);
}

// Inverse of mapLevel: the TV level whose mapped value is `bluosLevel`.
// Returns null when no TV level maps back to exactly that level (an
// unreachable level, an out-of-range one, or scale 0). The exactness matters:
// a TV level that maps back to a different BluOS level would make the two
// sync directions fight each other forever.
function tvLevelFor(bluosLevel, mapping) {
  const m = mapping || DEFAULTS.mapping;
  const value = parseTvLevel(bluosLevel);
  if (value === null || !Number.isFinite(m.scale) || m.scale === 0) return null;
  const candidate = clamp(Math.round((value - m.offset) / m.scale), 0, 100);
  if (mapLevel(candidate, m) === value) return candidate;
  for (const delta of [-1, 1, -2, 2]) {
    const alternate = clamp(candidate + delta, 0, 100);
    if (mapLevel(alternate, m) === value) return alternate;
  }
  return null;
}

// Decide what to send. `applied` is the last known device state (null when
// unknown). Returns an ordered list of actions.
function plan(applied, desired) {
  const level = parseTvLevel(desired.level);
  if (!applied) {
    if (desired.mute) return [{ type: 'mute', mute: true }];
    return level === null ? [] : [{ type: 'level', level }];
  }
  if (desired.mute) {
    // Never send a level while muted: BluOS would unmute.
    return applied.mute ? [] : [{ type: 'mute', mute: true }];
  }
  // A missing level means the TV volume was unusable: never send null/NaN,
  // and never unmute without a level (BluOS would restore the stale
  // muteVolume over the current one).
  if (level === null) return [];
  if (applied.mute) {
    // Level first, then unmute, so muteVolume is not restored over the new level.
    return [
      { type: 'level', level },
      { type: 'mute', mute: false },
    ];
  }
  if (applied.level !== level) return [{ type: 'level', level }];
  return [];
}

// BluOS /Volume response -> { level, mute }. `level` is null when the body
// carries no integer level. -1 is BluOS's fixed-volume sentinel and is parsed
// as-is (not as null) so callers can recognise it. Fractional levels are not
// valid BluOS levels and parse as null.
function parseVolume(body) {
  const text = typeof body === 'string' ? body : '';
  const muteMatch = /mute="([01])"/.exec(text);
  const levelMatch = />(-?\d+)<\/volume>/.exec(text);
  const muteVolumeMatch = /muteVolume="(-?\d+)"/.exec(text);
  const mute = muteMatch ? muteMatch[1] === '1' : false;
  let level = levelMatch ? Number(levelMatch[1]) : null;
  if (mute && muteVolumeMatch) level = Number(muteVolumeMatch[1]);
  return { level, mute };
}

// BluOS /Status response -> { state, service, name }. Missing elements -> null.
// `play` and `stream` both mean "actively playing"; an external input reports
// service "Capture".
function parseStatus(body) {
  const stateMatch = /<state>([^<]*)<\/state>/.exec(body);
  const serviceMatch = /<service>([^<]*)<\/service>/.exec(body);
  const nameMatch = /<name>([^<]*)<\/name>/.exec(body);
  // Local inputs (analog, Bluetooth, SPDIF) all report service "Capture";
  // inputTypeIndex ("spdif-1", "analog-1", ...) is what tells them apart.
  const inputTypeIndexMatch = /<inputTypeIndex>([^<]*)<\/inputTypeIndex>/.exec(body);
  return {
    state: stateMatch ? stateMatch[1].trim() : null,
    service: serviceMatch ? serviceMatch[1].trim() : null,
    name: nameMatch ? nameMatch[1].trim() : null,
    inputTypeIndex: inputTypeIndexMatch ? inputTypeIndexMatch[1].trim() : null,
  };
}

// Collapse the foregroundAppInfo playState field into a tri-state. Tuner,
// HDMI and console sources report an empty/absent playState, so "unknown" is
// distinct from an explicit "notplaying".
function derivePlayState(foregroundAppInfo) {
  if (!Array.isArray(foregroundAppInfo) || foregroundAppInfo.length === 0) return 'unknown';
  let sawInactive = false;
  for (const entry of foregroundAppInfo) {
    const playState = entry && entry.playState;
    if (playState === 'playing') return 'playing';
    if (playState === 'paused' || playState === 'unloaded' || playState === 'stopped') {
      sawInactive = true;
    }
  }
  return sawInactive ? 'notplaying' : 'unknown';
}

// Decide whether the TV counts as playing for the guard: API unavailable ->
// fail-open; explicit playState wins; unknown sources count as playing unless
// treatUnknownAsPlaying is disabled.
function resolvePlaying(pb, cfg) {
  const playback = (cfg && cfg.playback) || DEFAULTS.playback;
  if (pb.playStateAvailable !== true) return !!playback.failOpen;
  if (pb.tvPlayState === 'playing') return true;
  if (pb.tvPlayState === 'notplaying') return false;
  return !!playback.treatUnknownAsPlaying;
}

// Does the device currently play the source we expect? Only relevant when
// enforceSource is on; without a status we can only say "no".
function sourceMatches(status, cfg) {
  const pb = (cfg && cfg.playback) || DEFAULTS.playback;
  if (!pb.enforceSource) return true;
  if (!status) return false;
  // An explicit name is an override for firmware whose status differs.
  if (typeof pb.expectedName === 'string' && pb.expectedName.length > 0 &&
      status.name && status.name.toLowerCase() === pb.expectedName.toLowerCase()) {
    return true;
  }
  // All local inputs report service "Capture", so the service alone cannot
  // tell SPDIF from analog or Bluetooth. When /Status exposes inputTypeIndex,
  // require the configured input type ("spdif" matches "spdif-1").
  if (typeof status.inputTypeIndex === 'string' && status.inputTypeIndex.length > 0 &&
      typeof pb.inputType === 'string' && pb.inputType.length > 0) {
    const index = status.inputTypeIndex.toLowerCase();
    const type = pb.inputType.toLowerCase();
    return index === type || index.startsWith(type + '-');
  }
  if (typeof pb.expectedService === 'string' && status.service &&
      status.service.toLowerCase() === pb.expectedService.toLowerCase()) {
    return true;
  }
  return false;
}

// Decide whether the SPDIF input must be re-asserted. Pure: `playing` is the
// resolved TV play state (the caller has already applied the fail-open rule),
// `status` may be null when /Status could not be read.
function planPlayback(input) {
  const tv = input.tv;
  const playing = input.playing;
  const status = input.status;
  const cfg = input.cfg;
  const pb = (cfg && cfg.playback) || DEFAULTS.playback;
  if (!pb.enabled) return [];
  const tvAudible = !!tv && !tv.mute && tv.level > 0;
  if (!tvAudible) return [];
  if (playing !== true) return [];
  const goodState = !!status && (status.state === 'play' || status.state === 'stream');
  if (goodState && sourceMatches(status, cfg)) return [];
  return [{ type: 'input' }];
}

function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Validate before the merge: spreading a string or an array into the
  // defaults would silently produce an object and hide the typo.
  if (raw.bluosToTv !== undefined &&
      (raw.bluosToTv === null || typeof raw.bluosToTv !== 'object' || Array.isArray(raw.bluosToTv))) {
    throw new Error('bluosToTv must be an object');
  }
  const cfg = {
    ...DEFAULTS,
    ...raw,
    bluos: { ...DEFAULTS.bluos, ...(raw.bluos || {}) },
    mapping: { ...DEFAULTS.mapping, ...(raw.mapping || {}) },
    bluosToTv: { ...DEFAULTS.bluosToTv, ...(raw.bluosToTv || {}) },
    playback: { ...DEFAULTS.playback, ...(raw.playback || {}) },
  };
  if (typeof cfg.bluos.host !== 'string' || cfg.bluos.host.length === 0) {
    throw new Error('bluos.host must be set to the BluOS group leader address');
  }
  if (!Number.isInteger(cfg.bluos.port) || cfg.bluos.port < 1 || cfg.bluos.port > 65535) {
    throw new Error('bluos.port must be an integer 1..65535');
  }
  if (!Number.isFinite(cfg.bluos.timeoutMs) || cfg.bluos.timeoutMs <= 0) {
    throw new Error('bluos.timeoutMs must be > 0');
  }
  if (!Number.isFinite(cfg.mapping.scale)) throw new Error('mapping.scale must be a number');
  if (!Number.isFinite(cfg.mapping.offset)) throw new Error('mapping.offset must be a number');
  if (!Number.isFinite(cfg.mapping.min) || !Number.isFinite(cfg.mapping.max) || cfg.mapping.min > cfg.mapping.max) {
    throw new Error('mapping.min/mapping.max are invalid');
  }
  if (!Number.isFinite(cfg.debounceMs) || cfg.debounceMs < 0) {
    throw new Error('debounceMs must be >= 0');
  }
  if (!Number.isFinite(cfg.reconcileMs) || cfg.reconcileMs < 100) {
    throw new Error('reconcileMs must be >= 100');
  }
  if (!LOG_LEVELS[cfg.logLevel]) {
    throw new Error('logLevel must be one of ' + Object.keys(LOG_LEVELS).join(', '));
  }
  cfg.bluosToTv.enabled = !!cfg.bluosToTv.enabled;
  if (!Number.isFinite(cfg.bluosToTv.pollMs) || cfg.bluosToTv.pollMs < 250) {
    throw new Error('bluosToTv.pollMs must be >= 250');
  }
  if (!Number.isFinite(cfg.bluosToTv.suppressMs) || cfg.bluosToTv.suppressMs < 0) {
    throw new Error('bluosToTv.suppressMs must be >= 0');
  }
  if (typeof cfg.playback.inputType !== 'string' || cfg.playback.inputType.length === 0) {
    throw new Error('playback.inputType must be a non-empty string');
  }
  if (!Number.isInteger(cfg.playback.index) || cfg.playback.index < 0) {
    throw new Error('playback.index must be an integer >= 0');
  }
  if (!Number.isFinite(cfg.playback.statusMs) || cfg.playback.statusMs < 1000) {
    throw new Error('playback.statusMs must be >= 1000');
  }
  if (!Number.isFinite(cfg.playback.minReassertMs) || cfg.playback.minReassertMs < 1000) {
    throw new Error('playback.minReassertMs must be >= 1000');
  }
  if (cfg.playback.playUrl !== null && (typeof cfg.playback.playUrl !== 'string' || cfg.playback.playUrl.length === 0)) {
    throw new Error('playback.playUrl must be null or a non-empty string');
  }
  if (cfg.playback.expectedService !== null && typeof cfg.playback.expectedService !== 'string') {
    throw new Error('playback.expectedService must be null or a string');
  }
  if (cfg.playback.expectedName !== null && typeof cfg.playback.expectedName !== 'string') {
    throw new Error('playback.expectedName must be null or a string');
  }
  cfg.playback.enabled = !!cfg.playback.enabled;
  cfg.playback.enforceSource = !!cfg.playback.enforceSource;
  cfg.playback.failOpen = !!cfg.playback.failOpen;
  cfg.playback.treatUnknownAsPlaying = !!cfg.playback.treatUnknownAsPlaying;
  cfg.syncOnStart = !!cfg.syncOnStart;
  cfg.dryRun = !!cfg.dryRun;
  return cfg;
}

function createLogger(level) {
  const threshold = LOG_LEVELS[level] || LOG_LEVELS.info;
  function emit(lvl, message) {
    if (LOG_LEVELS[lvl] < threshold) return;
    console.log(new Date().toISOString() + ' ' + lvl.toUpperCase() + ' ' + message);
  }
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

function createBluOSClient(options) {
  const host = options.host;
  const port = options.port;
  const timeoutMs = options.timeoutMs;

  function request(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host, port, path: pathname, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('HTTP ' + res.statusCode + ' for ' + pathname));
            return;
          }
          resolve(body);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms for ' + pathname)));
      req.on('error', reject);
    });
  }

  return {
    getVolume: () => request('/Volume').then(parseVolume),
    setLevel: (level) => request('/Volume?level=' + level),
    setMute: (mute) => request('/Volume?mute=' + (mute ? 1 : 0)),
    getStatus: () => request('/Status').then(parseStatus),
    // Selects the configured input and starts it. /Play?inputType=... also
    // resumes from `stop`, which plain /Play cannot. playUrl, when set,
    // selects a stream by URL instead (escape hatch for newer firmware).
    selectInput: (cfg) => request(cfg.playback.playUrl
      ? '/Play?url=' + encodeURIComponent(cfg.playback.playUrl)
      : '/Play?inputType=' + encodeURIComponent(cfg.playback.inputType) + '&index=' + cfg.playback.index),
  };
}

// One-shot luna-send for the reverse sync. stdin is 'ignore' for the same
// reason the subscriptions use it (luna-send does nothing on a tty), and a
// hung call must not stall the poll.
function setTvVolume(lunaBin, level) {
  return new Promise((resolve, reject) => {
    const child = spawn(lunaBin, ['-n', '1', SET_VOLUME_URI, JSON.stringify({ volume: level })], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (error) { /* already gone */ }
      finish(new Error('setVolume timed out after ' + LUNA_TIMEOUT_MS + 'ms'));
    }, LUNA_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      const line = stdout.split('\n').filter(Boolean).pop() || '';
      if (code !== 0) {
        finish(new Error('luna-send exited ' + code + ': ' + (stderr || stdout).trim().slice(0, 120)));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        finish(new Error('invalid luna response: ' + line.slice(0, 120)));
        return;
      }
      if (message.returnValue !== true) {
        finish(new Error('setVolume failed: ' + line.slice(0, 120)));
        return;
      }
      finish(null, message);
    });
  });
}

async function applyActions(actions, ctx) {
  const state = ctx.state;
  const mapping = ctx.cfg.mapping;
  for (const action of actions) {
    if (action.type === 'level') {
      const tvLevel = state.tv ? state.tv.level : '?';
      ctx.log.info('tv ' + tvLevel + ' -> bluos ' + action.level +
        ' (scale ' + mapping.scale + ', offset ' + mapping.offset + ')');
      if (!ctx.cfg.dryRun) await ctx.client.setLevel(action.level);
      state.applied = {
        level: action.level,
        mute: state.applied ? state.applied.mute : false,
      };
    } else {
      if (action.mute) {
        ctx.log.info('mute on');
      } else {
        ctx.log.info('unmute -> level ' + (state.applied ? state.applied.level : '?'));
      }
      if (!ctx.cfg.dryRun) await ctx.client.setMute(action.mute);
      state.applied = {
        level: state.applied ? state.applied.level : 0,
        mute: action.mute,
      };
    }
  }
}

function usage() {
  console.log('Usage: bridge.js [--config <path>] [--help]');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  let configPath = path.join(__dirname, 'config.json');
  const configIndex = args.indexOf('--config');
  if (configIndex !== -1) {
    if (!args[configIndex + 1]) throw new Error('--config requires a path');
    configPath = path.resolve(args[configIndex + 1]);
  }

  const cfg = loadConfig(configPath);
  const log = createLogger(cfg.logLevel);
  const client = createBluOSClient(cfg.bluos);
  const lunaBin = process.env.LUNA_SEND_BIN || LUNA_BIN_DEFAULT;

  const state = {
    cfg,
    tv: null,
    applied: null,
    synced: false,
    // Last genuine (non-echo) TV volume message, used to keep the reverse
    // sync from overriding a change the user just made with the TV remote.
    tvChangedAt: 0,
    // The TV level this bridge just wrote, so its subscription echo is not
    // mistaken for a user change (and does not drive BluOS back).
    expectingTvLevel: null,
    expectingUntil: 0,
  };
  // Playback-guard state: playStateAvailable null = not heard from yet,
  // true = getForegroundAppInfo works, false = unavailable (fail open).
  // tvPlayState is the tri-state derived from the subscription.
  const pb = {
    playStateAvailable: null,
    tvPlayState: 'unknown',
    lastStatusAt: 0,
    lastInputAt: 0,
    busy: false,
  };
  let timer = null;
  let applying = false;
  let applyAgain = false;
  let applyAgainForce = false;
  let stopping = false;
  let tvWasAudible = false;
  let reverseBusy = false;
  let reverseWarned = false;
  let reverseErrorLogged = false;
  const subscriptions = [];

  log.info('starting; bluos ' + cfg.bluos.host + ':' + cfg.bluos.port +
    ', mapping tv*' + cfg.mapping.scale + (cfg.mapping.offset >= 0 ? '+' : '') + cfg.mapping.offset);

  try {
    const initial = await client.getVolume();
    state.applied = { level: initial.level, mute: initial.mute };
    log.info('bluos state: level ' + initial.level + (initial.mute ? ' (muted)' : ''));
    if (initial.level === -1) {
      log.warn('bluos reports fixed volume (-1); level changes may be ignored');
    }
  } catch (error) {
    log.warn('could not read bluos state: ' + error.message);
    state.applied = null;
  }

  // `force` bypasses the authority check below. Only the startup fallback
  // uses it: when the TV cannot take the BluOS level, the original TV ->
  // BluOS sync is allowed to run even if the first TV message is already
  // older than the suppression window by the time the read finishes.
  async function applyNow(force) {
    if (!state.tv) return;
    if (applying) {
      applyAgain = true;
      applyAgainForce = applyAgainForce || !!force;
      return;
    }
    applying = true;
    try {
      // With bluosToTv on the player is authoritative. The TV drives it only
      // after a genuine TV change (the remote, or the startup fallback): a
      // stale TV reading must not undo a BluOS-app change, and an unmuted TV
      // is not evidence that the player was unmuted (the TV cannot represent
      // a muted player: there is no luna mute setter).
      if (cfg.bluosToTv.enabled && !force &&
          Date.now() - state.tvChangedAt >= cfg.bluosToTv.suppressMs) {
        return;
      }
      const desired = { level: mapLevel(state.tv.level, cfg.mapping), mute: state.tv.mute };
      const actions = plan(state.applied, desired);
      if (actions.length === 0) return;
      await applyActions(actions, { cfg, client, log, state });
    } catch (error) {
      log.warn('bluos update failed: ' + error.message);
    } finally {
      applying = false;
      if (applyAgain) {
        applyAgain = false;
        const nextForce = applyAgainForce;
        applyAgainForce = false;
        await applyNow(nextForce);
      }
    }
  }

  function schedule(delay, force) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      applyNow(force);
    }, delay);
  }

  function tvIsAudible() {
    return !!state.tv && !state.tv.mute && state.tv.level > 0;
  }

  // True when this message is the subscription echo of a TV volume this
  // bridge just wrote. A genuine change from the TV remote clears the
  // expectation and is handled by the forward path instead.
  function consumeTvEcho(level) {
    if (state.expectingTvLevel === null) return false;
    if (Date.now() > state.expectingUntil) {
      state.expectingTvLevel = null;
      return false;
    }
    if (level !== state.expectingTvLevel) {
      state.expectingTvLevel = null;
      return false;
    }
    state.expectingTvLevel = null;
    return true;
  }

  // BluOS -> TV. Returns a short status so the startup path can decide
  // whether to fall back to the forward sync.
  async function syncReverse(force) {
    if (!cfg.bluosToTv.enabled || stopping) return 'disabled';
    if (reverseBusy || applying) return 'busy';
    if (!state.tv) return 'no-tv';
    if (!force && Date.now() - state.tvChangedAt < cfg.bluosToTv.suppressMs) return 'suppressed';
    reverseBusy = true;
    try {
      const volume = await client.getVolume();
      reverseErrorLogged = false;
      // The device is the authority. Refreshing `applied` here also means the
      // echo of the TV write below cannot be mistaken for a BluOS change.
      state.applied = { level: volume.level, mute: volume.mute };
      if (state.tv.mute) return 'muted-tv';
      const target = tvLevelFor(volume.level, cfg.mapping);
      if (target === null) {
        if (!reverseWarned) {
          reverseWarned = true;
          log.warn('cannot map bluos level ' + volume.level + ' to a TV level; the TV will not follow');
        }
        return 'no-target';
      }
      if (target === state.tv.level) return 'same';
      if (!cfg.dryRun) {
        state.expectingTvLevel = target;
        state.expectingUntil = Date.now() + LUNA_TIMEOUT_MS;
        try {
          await setTvVolume(lunaBin, target);
        } catch (error) {
          state.expectingTvLevel = null;
          throw error;
        }
      }
      log.info('bluos ' + volume.level + ' -> tv ' + target + ' (reverse sync)');
      return 'applied';
    } catch (error) {
      if (!reverseErrorLogged) {
        reverseErrorLogged = true;
        log.warn('reverse sync failed: ' + error.message);
      }
      return 'failed';
    } finally {
      reverseBusy = false;
    }
  }

  function syncReverseSafe(force) {
    syncReverse(force).catch((error) => log.warn('reverse sync failed: ' + error.message));
  }

  // Re-assert the SPDIF input when the TV is audible and playing but the
  // BluOS device is stopped or on another source. Never sends Stop/Pause.
  async function runGuard(force) {
    if (!cfg.playback.enabled || pb.busy) return;
    if (!tvIsAudible()) return;
    const playing = resolvePlaying(pb, cfg);
    if (!playing) return;
    const now = Date.now();
    if (!force && now - pb.lastStatusAt < cfg.playback.statusMs) return;
    pb.busy = true;
    try {
      pb.lastStatusAt = now;
      let status = null;
      try {
        status = await client.getStatus();
      } catch (error) {
        log.debug('status poll failed: ' + error.message);
      }
      const actions = planPlayback({ tv: state.tv, playing, status, cfg });
      if (!actions.some((action) => action.type === 'input')) return;
      const sendAt = Date.now();
      if (sendAt - pb.lastInputAt < cfg.playback.minReassertMs) {
        log.debug('input re-assert throttled (minReassertMs)');
        return;
      }
      log.info('tv audible & playing; bluos state=' + (status && status.state) +
        ' service=' + (status && status.service) + ' -> re-asserting input');
      if (!cfg.dryRun) {
        try {
          await client.selectInput(cfg);
        } catch (error) {
          log.warn('selecting input failed: ' + error.message);
        }
      }
      pb.lastInputAt = sendAt;
    } finally {
      pb.busy = false;
    }
  }

  function runGuardSafe(force) {
    runGuard(force).catch((error) => log.warn('playback guard failed: ' + error.message));
  }

  // Subscribe to a luna topic via `luna-send -i <uri> '{"subscribe":true}'`.
  // Each subscription has its own exponential backoff (1 s .. 30 s) on child
  // error/exit. onMessage(message, rawLine) returns truthy when the message
  // was relevant (which resets the backoff). When isFatal(message) matches,
  // onMessage is called once more and the subscription stops for good; onExit
  // (called on every unexpected exit before reconnecting) may also return
  // true to stop it, so a missing webOS API never spins forever.
  function subscribe(spec) {
    const sub = { name: spec.name, uri: spec.uri, backoff: 1000, stopped: false, child: null };

    function start() {
      if (sub.stopped || stopping) return;
      log.info('subscribing to ' + sub.uri);
      const child = spawn(lunaBin, ['-i', sub.uri, '{"subscribe":true}'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      sub.child = child;
      let settled = false;

      function reconnect(reason) {
        if (settled) return;
        settled = true;
        if (sub.child === child) sub.child = null;
        if (sub.stopped || stopping) return;
        if (spec.onExit && spec.onExit(reason)) {
          sub.stopped = true;
          return;
        }
        const delay = sub.backoff;
        sub.backoff = Math.min(sub.backoff * 2, 30000);
        log.warn(reason + '; reconnecting in ' + delay + 'ms');
        setTimeout(start, delay);
      }

      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch (error) {
          log.debug('ignoring non-JSON line: ' + trimmed.slice(0, 120));
          return;
        }
        if (spec.isFatal && spec.isFatal(message)) {
          spec.onMessage(message, trimmed);
          sub.stopped = true;
          try {
            child.kill('SIGTERM');
          } catch (error) {
            // already gone
          }
          return;
        }
        if (spec.onMessage(message, trimmed)) sub.backoff = 1000;
      });

      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) log.debug('luna-send: ' + text);
      });
      child.on('error', (error) => reconnect(sub.name + ' failed to start (' + error.message + ')'));
      child.on('exit', (code, signal) => reconnect(sub.name + ' exited (code ' + code + ', signal ' + signal + ')'));
    }

    subscriptions.push(sub);
    start();
    return sub;
  }

  function onVolumeMessage(message, rawLine) {
    const status = message && message.volumeStatus;
    if (!status) {
      log.debug('ignoring message: ' + String(rawLine || '').slice(0, 120));
      return false;
    }
    const level = parseTvLevel(status.volume);
    if (level === null) {
      // A malformed volume must not become 0 (a silent minimum-volume
      // request) or NaN (an invalid /Volume?level= request).
      log.warn('ignoring TV volume message with invalid volume: ' +
        String(rawLine || status.volume || '').slice(0, 120));
      return false;
    }
    const mute = status.muteStatus === true || status.muteStatus === 'true';
    const first = !state.synced;
    const echo = consumeTvEcho(level);
    const previous = state.tv;
    const changed = !previous || previous.level !== level || previous.mute !== mute;
    state.tv = { level, mute };
    // Duplicate subscription messages are not a user change, and neither is
    // the first message (a startup snapshot): with bluosToTv on, letting the
    // snapshot open the forward-sync window would let an unmuted TV unmute a
    // player that was muted from the BluOS app.
    if (!echo && changed && !first) state.tvChangedAt = Date.now();
    log.debug('tv state: volume ' + level + ', mute ' + mute + (echo ? ' (echo)' : ''));
    const audible = tvIsAudible();
    if (audible && !tvWasAudible) runGuardSafe(true);
    tvWasAudible = audible;
    if (first) {
      state.synced = true;
      if (!cfg.syncOnStart) {
        log.info('syncOnStart disabled; waiting for the next change');
        return true;
      }
      if (cfg.bluosToTv.enabled) {
        // BluOS is the authority at startup: adopt its level on the TV, and
        // fall back to the original TV -> BluOS sync only when the TV cannot
        // take it (muted, unreachable level, or a write that failed).
        syncReverse(true).then((result) => {
          if (result === 'no-target' || result === 'muted-tv' || result === 'failed') schedule(0, true);
        }).catch(() => schedule(0, true));
        return true;
      }
      schedule(0);
      return true;
    }
    // Our own write's echo must not drive BluOS back (in particular it must
    // not unmute a player that is muted while the TV is not).
    if (echo) return true;
    schedule(cfg.debounceMs);
    return true;
  }

  function playStateIsFatal(message) {
    if (!message || typeof message !== 'object') return false;
    return message.returnValue === false ||
      message.errorCode !== undefined ||
      message.errorText !== undefined;
  }

  function onPlayStateMessage(message, rawLine) {
    if (message && Array.isArray(message.foregroundAppInfo)) {
      pb.playStateAvailable = true;
      const derived = derivePlayState(message.foregroundAppInfo);
      if (derived !== pb.tvPlayState) {
        log.debug('tv playState: ' + derived);
        pb.tvPlayState = derived;
        if (resolvePlaying(pb, cfg) && tvIsAudible()) runGuardSafe(true);
      }
      return true;
    }
    if (playStateIsFatal(message)) {
      if (pb.playStateAvailable !== false) {
        pb.playStateAvailable = false;
        log.warn('getForegroundAppInfo unavailable (' + String(rawLine || '').slice(0, 120) +
          '); play-state check disabled, relying on volume/mute (fail-open)');
      }
      return true;
    }
    log.debug('ignoring message: ' + String(rawLine || '').slice(0, 120));
    return false;
  }

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('stopping (' + signal + ')');
    if (timer) clearTimeout(timer);
    for (const sub of subscriptions) {
      if (sub.child) {
        try {
          sub.child.kill('SIGTERM');
        } catch (error) {
          // already gone
        }
      }
    }
    setTimeout(() => process.exit(0), 100);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  setInterval(() => applyNow(), cfg.reconcileMs);

  // BluOS has no volume event stream, so a 1 s /Volume poll is the efficient
  // option: a tiny response on the LAN, and no /Status hammering.
  if (cfg.bluosToTv.enabled) {
    setInterval(() => syncReverseSafe(false), cfg.bluosToTv.pollMs);
  }

  subscribe({ name: 'luna-send (volume)', uri: LUNA_URI, onMessage: onVolumeMessage });
  if (cfg.playback.enabled) {
    subscribe({
      name: 'luna-send (play state)',
      uri: PLAY_STATE_URI,
      onMessage: onPlayStateMessage,
      isFatal: playStateIsFatal,
      onExit: () => {
        // Never even got a foregroundAppInfo answer: the API is missing on
        // this firmware. Stop reconnecting and fail open.
        if (pb.playStateAvailable === null) {
          pb.playStateAvailable = false;
          log.warn('getForegroundAppInfo never responded; play-state check disabled, relying on volume/mute (fail-open)');
          return true;
        }
        return false;
      },
    });
    setInterval(() => runGuardSafe(false), cfg.playback.statusMs);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('bridge: ' + error.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULTS,
  parseTvLevel,
  mapLevel,
  tvLevelFor,
  plan,
  parseVolume,
  parseStatus,
  derivePlayState,
  resolvePlaying,
  sourceMatches,
  planPlayback,
  loadConfig,
  createLogger,
  createBluOSClient,
};
