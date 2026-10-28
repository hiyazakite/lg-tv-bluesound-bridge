#!/usr/bin/env node
'use strict';

// LG webOS TV volume/mute -> BluOS group volume/mute.
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

const DEFAULTS = {
  bluos: { port: 11000, timeoutMs: 2000 },
  mapping: { scale: 1, offset: -30, min: 0, max: 100 },
  debounceMs: 130,
  syncOnStart: true,
  reconcileMs: 5000,
  logLevel: 'info',
  dryRun: false,
};

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// TV 0..100 -> BluOS 0..100. With the shipped defaults TV 49 becomes 19.
function mapLevel(tvLevel, mapping) {
  const m = mapping || DEFAULTS.mapping;
  return clamp(Math.round(tvLevel * m.scale + m.offset), m.min, m.max);
}

// Decide what to send. `applied` is the last known device state (null when
// unknown). Returns an ordered list of actions.
function plan(applied, desired) {
  if (!applied) {
    return desired.mute ? [{ type: 'mute', mute: true }] : [{ type: 'level', level: desired.level }];
  }
  if (desired.mute) {
    // Never send a level while muted: BluOS would unmute.
    return applied.mute ? [] : [{ type: 'mute', mute: true }];
  }
  if (applied.mute) {
    // Level first, then unmute, so muteVolume is not restored over the new level.
    return [
      { type: 'level', level: desired.level },
      { type: 'mute', mute: false },
    ];
  }
  if (applied.level !== desired.level) return [{ type: 'level', level: desired.level }];
  return [];
}

function parseVolume(body) {
  const muteMatch = /mute="([01])"/.exec(body);
  const levelMatch = />(\d+)<\/volume>/.exec(body);
  const muteVolumeMatch = /muteVolume="(\d+)"/.exec(body);
  const mute = muteMatch ? muteMatch[1] === '1' : false;
  let level = levelMatch ? Number(levelMatch[1]) : null;
  if (mute && muteVolumeMatch) level = Number(muteVolumeMatch[1]);
  return { level, mute };
}

function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = {
    ...DEFAULTS,
    ...raw,
    bluos: { ...DEFAULTS.bluos, ...(raw.bluos || {}) },
    mapping: { ...DEFAULTS.mapping, ...(raw.mapping || {}) },
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
  };
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

  const state = { cfg, tv: null, applied: null, synced: false };
  let timer = null;
  let applying = false;
  let applyAgain = false;
  let activeChild = null;
  let stopping = false;
  let backoff = 1000;

  log.info('starting; bluos ' + cfg.bluos.host + ':' + cfg.bluos.port +
    ', mapping tv*' + cfg.mapping.scale + (cfg.mapping.offset >= 0 ? '+' : '') + cfg.mapping.offset);

  try {
    const initial = await client.getVolume();
    state.applied = { level: initial.level, mute: initial.mute };
    log.info('bluos state: level ' + initial.level + (initial.mute ? ' (muted)' : ''));
  } catch (error) {
    log.warn('could not read bluos state: ' + error.message);
    state.applied = null;
  }

  async function applyNow() {
    if (!state.tv) return;
    if (applying) {
      applyAgain = true;
      return;
    }
    applying = true;
    try {
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
        await applyNow();
      }
    }
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      applyNow();
    }, delay);
  }

  function connect() {
    if (stopping) return;
    log.info('subscribing to ' + LUNA_URI);
    const child = spawn(lunaBin, ['-i', LUNA_URI, '{"subscribe":true}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    let settled = false;

    function reconnect(reason) {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      if (stopping) return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, 30000);
      log.warn(reason + '; reconnecting in ' + delay + 'ms');
      setTimeout(connect, delay);
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
      const status = message && message.volumeStatus;
      if (!status) {
        log.debug('ignoring message: ' + trimmed.slice(0, 120));
        return;
      }
      backoff = 1000;
      const level = Number(status.volume);
      const mute = status.muteStatus === true || status.muteStatus === 'true';
      state.tv = { level, mute };
      log.debug('tv state: volume ' + level + ', mute ' + mute);
      if (!state.synced) {
        state.synced = true;
        if (!cfg.syncOnStart) {
          log.info('syncOnStart disabled; waiting for the next change');
          return;
        }
        schedule(0);
        return;
      }
      schedule(cfg.debounceMs);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log.debug('luna-send: ' + text);
    });
    child.on('error', (error) => reconnect('luna-send failed to start (' + error.message + ')'));
    child.on('exit', (code, signal) => reconnect('luna-send exited (code ' + code + ', signal ' + signal + ')'));
  }

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info('stopping (' + signal + ')');
    if (timer) clearTimeout(timer);
    if (activeChild) {
      try {
        activeChild.kill('SIGTERM');
      } catch (error) {
        // already gone
      }
    }
    setTimeout(() => process.exit(0), 100);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  setInterval(() => applyNow(), cfg.reconcileMs);
  connect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('bridge: ' + error.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULTS,
  mapLevel,
  plan,
  parseVolume,
  loadConfig,
  createLogger,
  createBluOSClient,
};
