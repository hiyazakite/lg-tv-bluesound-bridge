# tv-bluos-bridge

Keeps a BluOS group in step with the volume and mute state of an LG webOS TV.

The TV has no IR blaster, so its remote cannot be learned by the soundbar. Both
devices are on the LAN, so this service runs on the TV and forwards every
volume/mute change to the BluOS group leader over HTTP.

```
LG remote
   |
   v
com.webos.service.audio/master/getVolume   (luna subscription)
   |
   v
bridge.js  -- debounce, map TV 0..100 -> BluOS 0..100, dedupe
   |
   v
http://<bluos-host>:11000/Volume?level=N   (group leader)
   |
   v
slaves follow the master, keeping their own trims
```

## What it does

- Subscribes to `luna://com.webos.service.audio/master/getVolume` and reacts to
  every change, including mute.
- Maps the TV level with `clamp(round(tv * scale + offset), min, max)`. The
  shipped default (`scale: 1`, `offset: -30`) maps TV 49 to BluOS 19.
- Sends `GET /Volume?level=N` and `GET /Volume?mute=1|0` to the group leader.
- Debounces rapid key presses (130 ms) and only sends when the device state
  actually differs from the target.
- Reads the device state at startup and reconciles every 5 s, so a dropped
  update or a short network failure heals itself.
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
| `debounceMs` | `130` | coalesce rapid changes |
| `syncOnStart` | `true` | apply the TV level once at startup |
| `reconcileMs` | `5000` | retry interval for failed updates |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error` |
| `dryRun` | `false` | log requests without sending them |

`config.json` in this repository is a template. The live copy on the TV is
preserved on upgrade, so editing it there is the normal workflow.

Mapping examples with the defaults: TV 0 -> 0, TV 49 -> 19, TV 100 -> 70.
Raise `scale` if the top of the TV range should reach BluOS 100.

After editing the config, restart:

```sh
/var/lib/webosbrew/init.d/70-bluos-bridge
```

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
- **Mute behaves oddly.** Do not send a level while muted by hand: BluOS
  unmutes when a level is set. The bridge already orders unmute correctly.
- **Boot timing.** webOS Homebrew runs `init.d` hooks about 35-40 s after
  power-on, so changes made before that are not mirrored. Standby/resume is
  unaffected.

## Limitations

- One-way sync. Changes made in the BluOS app are not reflected back to the TV,
  and the next TV volume change will overwrite them.
- Only the group leader is addressed; slaves follow it with their own trims.
- The service depends on `luna-send` and the webOS audio service; if either is
  unavailable it logs and retries but cannot do anything else.

## License

MIT - see [LICENSE](LICENSE).
