# tv-bluos-bridge

Keeps the volume in step between an LG webOS TV and a BluOS group. The soundbar
is the authority; the TV display follows it, and the TV remote still works.

The TV has no IR blaster, so its remote cannot be learned by the soundbar. Both
devices are on the LAN, so this service runs on the TV: it polls the BluOS group
leader and writes the TV level, and forwards TV remote changes back to the
group.

```
BluOS app / soundbar remote              LG remote
          |                                 |
          v                                 v
  GET /Volume (1 s poll)        getVolume (luna subscription)
          |                                 |
          +---------------+-----------------+
                          v
   bridge.js -- inverse map BluOS 0..100 -> TV 0..100,
                echo suppression, debounce, dedupe
          |                                 |
          v                                 v
luna .../master/setVolume            /Volume?level=N (group leader)
   (TV display follows)                        |
                                               v
                                 slaves follow the master, keeping trims
```

## What it does

- Polls `GET /Volume` every second and writes the TV level with
  `luna://com.webos.service.audio/master/setVolume`, so the TV display matches
  what the soundbar is actually doing. BluOS has no volume event stream, so a
  1 s poll of a tiny LAN response is the efficient option.
- Inverse-maps the BluOS level with `tvLevelFor()`: the TV only moves when a TV
  level maps back to exactly the BluOS level. Levels the TV cannot represent
  (above the mapping's top, or the fixed-volume `-1` sentinel) are skipped and
  logged once, so the two directions cannot fight each other.
- Subscribes to `luna://com.webos.service.audio/master/getVolume`; a genuine TV
  change (the remote) is still forwarded to the group leader, including mute.
- Recognizes the TV subscription echo of its own write and never mirrors it
  back. This matters most for a player muted in the BluOS app: the TV cannot
  show mute, and its unmuted echo must not unmute the player.
- Debounces rapid key presses (130 ms) and only sends when the device state
  actually differs from the target.
- BluOS wins at startup: the first TV message adopts the BluOS level. The old
  TV -> BluOS sync runs as a fallback only when the TV cannot take it (muted,
  unrepresentable level, or a failed write).
- With `bluosToTv` on, the 5 s reconcile no longer pushes stale TV state to
  BluOS; the forward path only acts after a genuine TV change. That keeps a
  BluOS-app volume or mute change from being undone.
- While the TV is audible and playing, re-asserts the BluOS digital input so a
  stopped or drifted player starts again (see
  [Playback](#playback-spdif-input-keep-alive)).
- Reconnects the luna subscription with exponential backoff (1 s .. 30 s).

## Group behaviour (verified on this hardware)

- Setting the level on the group leader propagates to every slave. Each slave
  keeps its own trim, so a surround speaker set 5 levels below the master stays
  there.
- `mute=1` on the leader mutes the whole group and preserves `muteVolume`.
- **Setting a level while muted unmutes the device.** The bridge therefore never
  sends a level while the TV is muted, and on unmute it sends the level first
  and `mute=0` second.
- `tell_slaves` is not used and not needed.

## Files

| Path | Purpose |
|---|---|
| `bridge.js` | the service (Node 20, no dependencies) |
| `config.json` | default configuration |
| `install.sh` | installer, local or over SSH |
| `init.d/70-bluos-bridge` | webOS Homebrew boot hook |
| `test/bridge.test.js` | unit + subprocess tests |

## Install

From the workstation (`TV_HOST` is required; SSH connects as `root` and uses
your own SSH config, agent and identities):

```sh
cd lg-labs/tv-bluos-bridge
TV_HOST=192.168.1.50 ./install.sh
```

Installer environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `TV_HOST` | *(required)* | address of the TV |
| `TV_USER` | `root` | SSH user |
| `TV_KEY` | *(unset)* | passed to `ssh -i`; when unset your SSH config, agent and default identities decide |

Directly on the TV (after copying the directory there):

```sh
sh /tmp/tv-bluos-bridge/install.sh
```

The installer writes:

- `/var/lib/bluos-bridge/bridge.js`
- `/var/lib/bluos-bridge/config.json` (existing config is preserved; use
  `--force-config` to overwrite)
- `/var/lib/webosbrew/init.d/70-bluos-bridge`

and starts the service. Logs go to `/var/lib/bluos-bridge/bridge.log`.

Nothing is written to `/`, `/etc` or `/usr`; those are read-only on this
firmware and stay untouched.

## Configuration

`/var/lib/bluos-bridge/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `bluos.host` | *(required)* | address of the BluOS group leader |
| `bluos.port` | `11000` | BluOS control API port (port 80 is the web UI) |
| `bluos.timeoutMs` | `2000` | HTTP request timeout |
| `mapping.scale` | `1.0` | TV units per BluOS unit |
| `mapping.offset` | `-30` | added after scaling |
| `mapping.min` / `mapping.max` | `0` / `100` | clamp range |
| `bluosToTv.enabled` | `true` | the TV follows the BluOS level (the TV is the slave) |
| `bluosToTv.pollMs` | `1000` | BluOS `/Volume` poll interval (ms, min 250); BluOS has no volume events |
| `bluosToTv.suppressMs` | `1500` | after a genuine TV change, how long the poll leaves the TV alone so the remote wins |
| `debounceMs` | `130` | coalesce rapid changes |
| `syncOnStart` | `true` | at startup, adopt the BluOS level on the TV (falls back to the TV -> BluOS sync when the TV cannot take it) |
| `reconcileMs` | `5000` | retry interval for failed updates |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error` |
| `dryRun` | `false` | log requests without sending them |
| `playback.enabled` | `true` | enable the SPDIF input keep-alive (see below) |
| `playback.inputType` | `"spdif"` | input type sent to `/Play?inputType=` |
| `playback.index` | `0` | input index sent to `/Play?index=` |
| `playback.playUrl` | `null` | escape hatch: when a non-empty string, select the source with `/Play?url=...` instead of the `inputType`/`index` form |
| `playback.statusMs` | `10000` | how often the guard polls BluOS `/Status` (ms, min 1000) |
| `playback.minReassertMs` | `10000` | minimum gap between two `/Play` re-asserts (ms, min 1000) |
| `playback.enforceSource` | `true` | also re-assert when the device plays *another* source (e.g. Bluetooth/Spotify drifted in via the BluOS app) |
| `playback.expectedService` | `"Capture"` | BluOS `service` of the digital input (`Capture` for external inputs) |
| `playback.expectedName` | `null` | optional device input name, matched case-insensitively as an alternative to `expectedService` |
| `playback.failOpen` | `true` | if `getForegroundAppInfo` is unavailable on the firmware, treat the TV as playing and rely on volume/mute only |
| `playback.treatUnknownAsPlaying` | `true` | treat an empty/absent `playState` (tuner, HDMI, console sources) as playing; an explicit `paused`/`stopped`/`unloaded` still suppresses the re-assert |

`config.json` in this repository is a template. The live copy on the TV is
preserved on upgrade, so editing it there is the normal workflow.

Mapping examples with the defaults: TV 0 -> 0, TV 49 -> 19, TV 100 -> 70.
Raise `scale` if the top of the TV range should reach BluOS 100.

The reverse direction uses the same mapping: BluOS 19 -> TV 49, BluOS 0 -> TV 30.
Only exact inverses are used, so with the defaults every BluOS level 0..70 is
representable and 71..100 is not (TV 100 already maps to 70). Set
`bluosToTv.enabled: false` for the old one-way TV -> BluOS behaviour.

After editing the config, restart:

```sh
/var/lib/webosbrew/init.d/70-bluos-bridge
```

## Playback (SPDIF input keep-alive)

If someone "stops" playback on the BluOS device (or it drifts to Bluetooth,
Spotify, ...), the bridge would keep mirroring volume to a silent player. The
playback guard closes that gap:

1. **Trigger:** the TV must be audible — unmuted **and** volume > 0 — **and**
   report a playing signal. The playing signal comes from a second luna
   subscription, `luna://com.webos.media/getForegroundAppInfo`: the TV counts
   as playing when any `foregroundAppInfo` entry has `playState === "playing"`.
   Tuner, HDMI and console sources report an **empty/absent** `playState`, so
   while no entry says `paused`/`stopped`/`unloaded` such unknown states also
   count as playing (`playback.treatUnknownAsPlaying`, default `true`; set it
   to `false` to require an explicit `playing`). An explicit pause always
   wins. If that API does not exist on the firmware (error or no answer), the
   guard **fails open**: the volume/mute precondition alone is enough
   (`playback.failOpen`). The bridge never re-asserts while the TV is muted or
   at volume 0.
2. **Check:** while the guard considers the TV playing, every
   `playback.statusMs` it reads `GET /Status` and parses `<state>`, `<service>`
   and `<name>`. `play` and `stream` both count as playing; for the digital
   input `service` is `Capture`. If the device is stopped, or is playing
   something else and `enforceSource` is on, the guard re-asserts. When the TV
   is not considered playing, `/Status` is not polled at all.
3. **Action:** `GET /Play?inputType=spdif&index=0` — this selects the input
   *and* starts it (`/Play` alone cannot resume from `stop`). Sends are
   rate-limited to one per `playback.minReassertMs`.

Notes:

- The bridge **only ever re-asserts play/input**. It never sends `/Stop` or
  `/Pause`, and enforcement overrides a source you started in the BluOS app
  while the TV is audible — that is the intended behaviour. Set
  `playback.enabled: false` if you want the old volume-only behaviour.
- Newer firmware that does not accept the `inputType` form can use the
  `playback.playUrl` escape hatch: set it to the stream URL of your input and
  the guard sends `/Play?url=<encoded>` instead.
- `/Status` is polled on its own `playback.statusMs` interval, never on the
  5 s volume reconcile. BluOS asks that `/Status` not be hammered without
  long-polling; 10 s is a local-network compromise, so raise `statusMs` if the
  extra request ever matters.
- A dead BluOS device or a missing webOS API is logged and retried; it can
  never crash the bridge.

## Test manually

On the TV:

```sh
tail -f /var/lib/bluos-bridge/bridge.log

# move the TV volume; the log should show "tv 50 -> bluos 20"
luna-send -n 1 luna://com.webos.service.audio/master/setVolume '{"volume":50}' </dev/null

# check the group
curl -s http://<bluos-host>:11000/Volume
# repeat for each slave's address
```

`luna-send` needs stdin redirected (`</dev/null`), otherwise it exits without
doing anything.

## On-device end-to-end tests

`test/device/` drives the real TV and the real BluOS device. It runs on the TV
over SSH, because GitHub-hosted runners cannot reach a home LAN:

```sh
TV_HOST=<tv> npm run test:device              # read-only preflight + dryRun
TV_HOST=<tv> npm run test:device:writes       # + volume, stop and drift tests
TV_HOST=<tv> npm run test:device:installed    # + deploy and check the service
```

`TV_USER` (default `root`) and `TV_KEY` (optional) mirror `install.sh`. The
BluOS address is discovered from the installed config; `BLUOS_HOST` and
`BLUOS_PORT` override it.

How it works: the suite is copied to `/tmp/tv-bluos-bridge-e2e` and started
with `node --test`. The bridge under test talks to a recording reverse proxy on
the TV instead of the device, so its requests are asserted verbatim while the
device behaviour stays real. The test's own `/Stop` and input changes go
straight to the device, so the proxy log contains bridge traffic only — which
is what makes "the bridge never sent `/Stop` or `/Pause`" a meaningful check.

| Test | Needs `--allow-writes` | Proves |
| --- | --- | --- |
| preflight | no | node, luna, TV volume, BluOS `/Status` and `/Volume` are usable |
| dryRun | no | the bridge reads the device and sends no writes |
| volume mirror | yes | a TV volume change becomes the mapped `/Volume?level=` |
| reverse sync | yes | a BluOS volume change moves the TV and the echo is not mirrored back |
| stop re-assert | yes | `/Stop` is followed by `/Play?inputType=spdif&index=0` |
| drift re-assert | yes | analog/Bluetooth is returned to SPDIF |
| installed check | yes (`--allow-writes --installed`) | the deployed service recovers SPDIF |

Safety rails: the script stops the installed bridge for the duration (two
bridges would both mirror volume and mask a broken guard), snapshots the TV
volume and the BluOS volume/mute first, restores them from a `trap` even on
failure, and leaves the BluOS on the SPDIF input. It never launches apps or
changes the TV input, and it removes `/tmp/tv-bluos-bridge-e2e` afterwards.
`--installed` deploys with `install.sh`, which keeps the existing config.

Two device limitations make individual tests skip rather than fail: webOS
exposes no luna mute setter (the write tests skip while the TV is muted), and a
BluOS in Fixed Volume mode ignores level writes (the volume test skips).

For CI, run it on a self-hosted runner on the same LAN as the TV; a
GitHub-hosted runner cannot reach it.

## Uninstall

```sh
./install.sh --uninstall          # from the workstation
sh install.sh --uninstall         # on the TV
```

This stops the process and removes the boot hook and `/var/lib/bluos-bridge`
(including its log). The TV returns to its previous behaviour immediately; the
BluOS group keeps whatever volume it had.

## Troubleshooting

- **Nothing happens.** Check `tail -n 50 /var/lib/bluos-bridge/bridge.log`; the first
  lines show the BluOS state read and the luna subscription. A subscription
  error is logged with its reason and retried.
- **TV volume changes but BluOS does not.** Confirm the TV is actually changing
  `volume`/`muteStatus`:
  `luna-send -i luna://com.webos.service.audio/master/getVolume '{"subscribe":true}' </dev/null`
  then press the remote. If no lines appear, the TV is not reporting changes.
- **Volume is too loud or too quiet.** Adjust `mapping.offset` (one step per
  BluOS level) and restart the hook.
- **The log says `bluos reports fixed volume (-1)`.** The player has Fixed
  Volume enabled in the BluOS app, so it ignores `/Volume?level=` requests and
  its level cannot be shown on the TV. Switch it to Variable Volume if the TV
  should follow it.
- **The TV level does not follow BluOS.** Look for `reverse sync` lines in the
  log. `cannot map bluos level N to a TV level` means no TV level maps back
  exactly (default mapping: BluOS 71..100); the TV must also be unmuted, since
  webOS exposes no luna mute setter.
- **Mute behaves oddly.** Do not send a level while muted by hand: BluOS
  unmutes when a level is set. The bridge already orders unmute correctly.
- **Boot timing.** webOS Homebrew runs `init.d` hooks about 35-40 s after
  power-on, so changes made before that are not mirrored. Standby/resume is
  unaffected.

## Limitations

- The TV is the slave for level, not for mute. webOS has no luna mute setter, so
  a BluOS mute is not shown on the TV and an unmuted TV never unmutes the
  player. Mute from the BluOS app when the soundbar should be silent.
- Only exact inverse mappings are applied; a BluOS level the TV cannot
  represent leaves the TV where it is (it keeps following once the level is
  representable again).
- Only the group leader is addressed; slaves follow it with their own trims.
- The service depends on `luna-send` and the webOS audio service; if either is
  unavailable it logs and retries but cannot do anything else.

## License

MIT - see [LICENSE](LICENSE).
