# lg-tv-bluesound-bridge

Run this on an LG webOS TV to keep its volume in step with a Bluesound (BluOS)
player. The player is the authority: change the volume in the Bluesound app and
the TV display follows. The TV remote still works, and changes made with it go
back to the player.

The TV has no IR blaster, so its remote cannot be learned by the soundbar. Both
devices are on the LAN, so this service runs on the TV: it polls the BluOS group
leader and writes the TV level, and forwards TV remote changes back to the
group.

```
Bluesound app / player remote            LG remote
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

- **The TV follows the player.** A 1 s poll of `GET /Volume` writes the TV
  level with `luna://com.webos.service.audio/master/setVolume`, so the TV
  display matches the soundbar. BluOS has no volume event stream; a tiny LAN
  poll is the efficient option.
- **Only exact inverses move the TV.** `tvLevelFor()` returns a TV level only
  when that level maps back to exactly the BluOS level. Unrepresentable levels
  (default mapping: BluOS 71..100) and the fixed-volume `-1` sentinel are
  skipped and warned once, so the two directions cannot fight.
- **The remote still works.** A genuine TV volume or mute change is forwarded
  to the group leader, debounced (130 ms) and deduplicated.
- **Echoes are ignored.** The TV subscription echoes the bridge's own write;
  that echo is recognized and never mirrored back. This matters most for a
  player muted in the Bluesound app: the TV cannot show mute, and its unmuted
  echo must not unmute the player.
- **BluOS wins at startup.** The first TV message adopts the BluOS level. The
  old TV -> BluOS sync runs as a fallback only when the TV cannot take it
  (muted, unrepresentable level, or a failed write).
- **The guard keeps the input alive.** While the TV is audible and playing, a
  stopped or drifted player is returned to its digital input. It only ever
  re-asserts play/input; it never sends `/Stop` or `/Pause`.
- **It reconnects.** The luna subscription retries with exponential backoff
  (1 s .. 30 s); a dead player or missing webOS API is logged, never fatal.

## Requirements

- An LG TV running webOS with the
  [Homebrew Channel](https://www.webosbrew.org/) installed. The installer uses
  its `init.d` hook and root SSH.
- Node 18+ on the TV at `/usr/bin/node` (the Homebrew Channel provides it).
- `luna-send` at `/usr/bin/luna-send` (part of webOS).
- A Bluesound/BluOS player on the same network. If you have a group, note the
  IP of the **group leader**.
- A workstation with `ssh` and `tar` for the remote install.

Check the TV and the player from the workstation:

```sh
ssh root@<tv-ip> '/usr/bin/node -v && test -x /usr/bin/luna-send && echo luna-ok'
curl -s http://<player-ip>:11000/Volume
```

The first command prints `v18` or newer and `luna-ok`. The second prints a
`<volume ...>19</volume>` document.

## Install

### 1. Find the two addresses

- **TV:** Settings -> Connection -> Network (wired or wireless) -> IP address.
- **Player:** Bluesound app -> your player -> Settings / Information -> IP
  address.

### 2. Check SSH to the TV

```sh
ssh root@<tv-ip> true
```

If this fails, install or enable the Homebrew Channel's SSH server first.
`TV_USER` (default `root`) and `TV_KEY` (optional, passed to `ssh -i`) cover
setups where root or the key path differs.

### 3. Run the installer

```sh
git clone https://github.com/hiyazakite/lg-tv-bluesound-bridge.git
cd lg-tv-bluesound-bridge
TV_HOST=<tv-ip> BLUOS_HOST=<player-ip> ./install.sh
```

`BLUOS_HOST` is optional; without it the template's example address is kept
and you can edit the config in step 4. The installer deploys over SSH, starts
the service, and prints its log. There is no `npm install`: the bridge has no
dependencies.

### 4. Point it at the player (only if you skipped `BLUOS_HOST`)

```sh
scp root@<tv-ip>:/var/lib/bluos-bridge/config.json .
# edit "bluos.host" in config.json
scp config.json root@<tv-ip>:/var/lib/bluos-bridge/config.json
ssh root@<tv-ip> /var/lib/webosbrew/init.d/70-bluos-bridge
```

### 5. Verify

```sh
ssh root@<tv-ip> tail -n 20 /var/lib/bluos-bridge/bridge.log
```

You should see `starting; bluos <ip>:11000`, `bluos state: level N`, and two
`subscribing to` lines. Then:

- change the TV volume with the remote: the Bluesound app should follow;
- change the volume in the Bluesound app: the TV display should follow within
  a second.

If nothing follows, check that the TV is unmuted and the player is in
Variable Volume mode (see [Limitations](#limitations)).

### What the installer writes

| Path | Purpose |
|---|---|
| `/var/lib/bluos-bridge/bridge.js` | the service |
| `/var/lib/bluos-bridge/config.json` | configuration; an existing file is kept on upgrade |
| `/var/lib/webosbrew/init.d/70-bluos-bridge` | webOS Homebrew boot hook |
| `/var/lib/bluos-bridge/bridge.log` | log (rotated at 2 MB on boot) |

Nothing is written to `/`, `/etc` or `/usr`; those are read-only on this
firmware and stay untouched.

The installed service keeps the internal name `bluos-bridge` (the paths above)
for upgrade compatibility, even though the project is now
`lg-tv-bluesound-bridge`.

### Install directly on the TV

Copy the installer files to the TV and run the installer there:

```sh
ssh root@<tv-ip> 'mkdir -p /tmp/lg-tv-bluesound-bridge'
scp -r bridge.js config.json install.sh init.d root@<tv-ip>:/tmp/lg-tv-bluesound-bridge
ssh root@<tv-ip> sh /tmp/lg-tv-bluesound-bridge/install.sh
```

## Upgrading

```sh
git pull
TV_HOST=<tv-ip> ./install.sh
```

The existing `/var/lib/bluos-bridge/config.json` is preserved, and every
setting in it is kept. `BLUOS_HOST=<player-ip>` updates just the `bluos.host`
field, so an upgrade can point at a new player without touching the rest of
the config:

```sh
TV_HOST=<tv-ip> BLUOS_HOST=<player-ip> ./install.sh
```

Add `--force-config` if you want the repository template instead; that discards
any local edits, and `BLUOS_HOST` is then applied to the fresh file. The
installer stops the old process before starting the new one.

## Configuration

The live config is `/var/lib/bluos-bridge/config.json`. `config.json` in this
repository is only a template.

### Connection and volume

| Key | Default | Meaning |
|---|---|---|
| `bluos.host` | *(required)* | address of the BluOS group leader |
| `bluos.port` | `11000` | BluOS control API port (port 80 is the web UI) |
| `bluos.timeoutMs` | `2000` | HTTP request timeout |
| `mapping.scale` | `1.0` | TV units per BluOS unit |
| `mapping.offset` | `-30` | added after scaling |
| `mapping.min` / `mapping.max` | `0` / `100` | clamp range |
| `bluosToTv.enabled` | `true` | the TV follows the BluOS level (the TV is the slave) |
| `bluosToTv.pollMs` | `1000` | BluOS `/Volume` poll interval (ms, min 250) |
| `bluosToTv.suppressMs` | `1500` | after a genuine TV change, how long the poll leaves the TV alone so the remote wins |
| `debounceMs` | `130` | coalesce rapid changes |
| `syncOnStart` | `true` | at startup, adopt the BluOS level on the TV (falls back to the TV -> BluOS sync when the TV cannot take it) |
| `reconcileMs` | `5000` | retry interval for failed updates |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error` |
| `dryRun` | `false` | log requests without sending them |

### Playback guard

| Key | Default | Meaning |
|---|---|---|
| `playback.enabled` | `true` | enable the digital-input keep-alive |
| `playback.inputType` | `"spdif"` | input type sent to `/Play?inputType=` |
| `playback.index` | `0` | input index sent to `/Play?index=` |
| `playback.playUrl` | `null` | escape hatch: when a non-empty string, select the source with `/Play?url=...` instead of the `inputType`/`index` form |
| `playback.statusMs` | `10000` | how often the guard polls BluOS `/Status` (ms, min 1000) |
| `playback.minReassertMs` | `10000` | minimum gap between two `/Play` re-asserts (ms, min 1000) |
| `playback.enforceSource` | `true` | also re-assert when the device plays *another* source (e.g. Bluetooth/Spotify drifted in via the Bluesound app) |
| `playback.expectedService` | `"Capture"` | BluOS `service` of the digital input (`Capture` for external inputs) |
| `playback.expectedName` | `null` | optional device input name, matched case-insensitively as an alternative to `expectedService` |
| `playback.failOpen` | `true` | if `getForegroundAppInfo` is unavailable on the firmware, treat the TV as playing and rely on volume/mute only |
| `playback.treatUnknownAsPlaying` | `true` | treat an empty/absent `playState` (tuner, HDMI, console sources) as playing; an explicit `paused`/`stopped`/`unloaded` still suppresses the re-assert |

### Mapping

With the defaults: TV 0 -> BluOS 0, TV 49 -> BluOS 19, TV 100 -> BluOS 70.
Raise `scale` if the top of the TV range should reach BluOS 100.

The reverse direction uses the same mapping: BluOS 19 -> TV 49, BluOS 0 ->
TV 30. Only exact inverses are used, so with the defaults every BluOS level
0..70 is representable and 71..100 is not (TV 100 already maps to 70). Set
`bluosToTv.enabled: false` for the old one-way TV -> BluOS behaviour.

### Editing and restarting

```sh
scp root@<tv-ip>:/var/lib/bluos-bridge/config.json .
# edit config.json
scp config.json root@<tv-ip>:/var/lib/bluos-bridge/config.json
ssh root@<tv-ip> /var/lib/webosbrew/init.d/70-bluos-bridge
```

The hook stops the previous process and starts a new one, so no reboot is
needed.

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
  `/Pause`, and enforcement overrides a source you started in the Bluesound app
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
curl -s http://<player-ip>:11000/Volume
# repeat for each slave's address
```

`luna-send` needs stdin redirected (`</dev/null`), otherwise it exits without
doing anything.

## On-device end-to-end tests

`test/device/` drives the real TV and the real Bluesound player. It runs on the
TV over SSH, because GitHub-hosted runners cannot reach a home LAN:

```sh
TV_HOST=<tv-ip> npm run test:device              # read-only preflight + dryRun
TV_HOST=<tv-ip> npm run test:device:writes       # + volume, reverse and guard tests
TV_HOST=<tv-ip> npm run test:device:installed    # + deploy and check the service
```

`TV_USER` (default `root`) and `TV_KEY` (optional) mirror `install.sh`. The
BluOS address is discovered from the installed config; `BLUOS_HOST` and
`BLUOS_PORT` override it.

How it works: the suite is copied to `/tmp/lg-tv-bluesound-bridge-e2e` and
started with `node --test`. The bridge under test talks to a recording reverse
proxy on the TV instead of the device, so its requests are asserted verbatim
while the device behaviour stays real. The test's own `/Stop` and input changes
go straight to the device, so the proxy log contains bridge traffic only —
which is what makes "the bridge never sent `/Stop` or `/Pause`" a meaningful
check.

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
changes the TV input, and it removes `/tmp/lg-tv-bluesound-bridge-e2e`
afterwards. `--installed` deploys with `install.sh`, which keeps the existing
config.

Two device limitations make individual tests skip rather than fail: webOS
exposes no luna mute setter (the write tests skip while the TV is muted), and a
BluOS player in Fixed Volume mode ignores level writes (the volume test skips).

For CI, run it on a self-hosted runner on the same LAN as the TV; a
GitHub-hosted runner cannot reach it.

## Troubleshooting

### Install

- **`install.sh: TV_HOST is required`.** Pass the TV address:
  `TV_HOST=192.168.1.50 ./install.sh`.
- **`Permission denied (publickey)`.** The installer uses your SSH config,
  agent and default keys. Try `ssh root@<tv-ip>` first, or pass
  `TV_KEY=~/.ssh/id_ed25519`.
- **`/usr/bin/node` or `luna-send` not found.** Install the Homebrew Channel
  (which provides Node) and check the paths in [Requirements](#requirements).
- **`bridge did not start`.** The installer prints the last log lines. Run the
  checks above, then start the hook by hand:
  `ssh root@<tv-ip> /var/lib/webosbrew/init.d/70-bluos-bridge`.

### Runtime

- **Nothing happens.** Check `tail -n 50 /var/lib/bluos-bridge/bridge.log`; the
  first lines show the BluOS state read and the luna subscriptions. A
  subscription error is logged with its reason and retried.
- **TV volume changes but BluOS does not.** Confirm the TV is actually changing
  `volume`/`muteStatus`:
  `luna-send -i luna://com.webos.service.audio/master/getVolume '{"subscribe":true}' </dev/null`
  then press the remote. If no lines appear, the TV is not reporting changes.
- **The TV level does not follow BluOS.** Look for `reverse sync` lines in the
  log. `cannot map bluos level N to a TV level` means no TV level maps back
  exactly (default mapping: BluOS 71..100); the TV must also be unmuted, since
  webOS exposes no luna mute setter.
- **Volume is too loud or too quiet.** Adjust `mapping.offset` (one step per
  BluOS level) and restart the hook.
- **The log says `bluos reports fixed volume (-1)`.** The player has Fixed
  Volume enabled in the Bluesound app, so it ignores `/Volume?level=` requests
  and its level cannot be shown on the TV. Switch it to Variable Volume if the
  TV should follow it.
- **Mute behaves oddly.** Do not send a level while muted by hand: BluOS
  unmutes when a level is set. The bridge already orders unmute correctly.
- **Boot timing.** webOS Homebrew runs `init.d` hooks about 35-40 s after
  power-on, so changes made before that are not mirrored. Standby/resume is
  unaffected.

## Uninstall

```sh
TV_HOST=<tv-ip> ./install.sh --uninstall   # from the workstation
sh install.sh --uninstall                  # on the TV
```

This stops the process and removes the boot hook and `/var/lib/bluos-bridge`
(including its log). The TV returns to its previous behaviour immediately; the
Bluesound player keeps whatever volume it had.

## Limitations

- The TV is the slave for level, not for mute. webOS has no luna mute setter, so
  a BluOS mute is not shown on the TV and an unmuted TV never unmutes the
  player. Mute from the Bluesound app when the soundbar should be silent.
- Only exact inverse mappings are applied; a BluOS level the TV cannot
  represent leaves the TV where it is (it keeps following once the level is
  representable again).
- Only the group leader is addressed; slaves follow it with their own trims.
- The service depends on `luna-send` and the webOS audio service; if either is
  unavailable it logs and retries but cannot do anything else.

## License

MIT - see [LICENSE](LICENSE).
