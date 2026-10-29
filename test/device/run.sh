#!/bin/sh
# On-device end-to-end tests for the BluOS bridge.
#
# The suite runs ON the TV, over SSH, against the real webOS audio service and
# the real BluOS device. The bridge under test is pointed at a recording proxy
# on the TV, so its requests are asserted verbatim while device behaviour stays
# real. The installed service is stopped for the run (two bridges would both
# mirror volume and mask a broken guard) and restarted afterwards.
#
# Usage:
#   TV_HOST=192.168.1.50 sh test/device/run.sh                  # read-only
#   TV_HOST=192.168.1.50 sh test/device/run.sh --allow-writes   # + volume/input
#   TV_HOST=192.168.1.50 sh test/device/run.sh --allow-writes --installed
#
# Env: TV_HOST (required), TV_USER (default root), TV_KEY (optional),
#      BLUOS_HOST/BLUOS_PORT (optional; discovered from the TV config),
#      TV_APP_DIR (default /var/lib/bluos-bridge).
#
# Safety: TV volume and BluOS volume/mute are snapshotted before anything is
# stopped and restored on exit, including on failure. The BluOS device is left
# on the SPDIF input, which is the bridge's normal state.
set -eu

usage() {
  cat <<'EOS'
Usage: run.sh [--allow-writes] [--installed]

  --allow-writes  run the volume/stop/drift tests (they change the real device,
                  with a snapshot and restore around the whole run)
  --installed     deploy the current build and check the installed service;
                  requires --allow-writes

TV_HOST is required. TV_USER defaults to root; TV_KEY is optional.
EOS
}

ALLOW_WRITES=0
INSTALLED=0
for arg in "$@"; do
  case "$arg" in
    --allow-writes) ALLOW_WRITES=1 ;;
    --installed) INSTALLED=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$INSTALLED" = 1 ] && [ "$ALLOW_WRITES" != 1 ]; then
  echo "run.sh: --installed stops the real device, so it also needs --allow-writes" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

TV_HOST=${TV_HOST:-}
if [ -z "$TV_HOST" ]; then
  echo "run.sh: TV_HOST is required, e.g. TV_HOST=192.168.1.50 sh $0" >&2
  exit 2
fi
TV_USER=${TV_USER:-root}
TV_KEY=${TV_KEY:-}
TV_APP_DIR=${TV_APP_DIR:-/var/lib/bluos-bridge}
REMOTE_DIR=/tmp/lg-tv-bluesound-bridge-e2e

export TV_HOST TV_USER TV_KEY

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10"
if [ -n "$TV_KEY" ]; then
  SSH_OPTS="-i $TV_KEY $SSH_OPTS"
fi

SNAPSHOT_FILE=""
WAS_RUNNING=0
STATUS=0

ssh_run() {
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "$TV_USER@$TV_HOST" "$@"
}

stop_installed() {
  ssh_run "sh -s '$TV_APP_DIR'" <<'EOS'
APP_DIR=$1
if [ -f "$APP_DIR/bridge.pid" ]; then
  pid=$(cat "$APP_DIR/bridge.pid" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*) ;;
    *) kill "$pid" 2>/dev/null || true ;;
  esac
fi
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null || true)
  case "$c" in
    *"$APP_DIR/bridge.js"*) kill "${p#/proc/}" 2>/dev/null || true ;;
  esac
done
EOS
}

start_installed() {
  ssh_run "sh -s '$TV_APP_DIR'" <<'EOS'
APP_DIR=$1
HOOK=/var/lib/webosbrew/init.d/70-bluos-bridge
[ -x "$HOOK" ] || exit 1
"$HOOK"
sleep 1
pid=$(cat "$APP_DIR/bridge.pid" 2>/dev/null || true)
case "$pid" in
  ''|*[!0-9]*) exit 1 ;;
esac
kill -0 "$pid" 2>/dev/null || exit 1
echo "installed bridge running (pid $pid)"
EOS
}

cleanup() {
  status=$?
  trap - EXIT INT TERM

  echo "== cleanup: stopping test bridges"
  ssh_run "sh -s '$REMOTE_DIR'" <<'EOS' || true
REMOTE_DIR=$1
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null || true)
  case "$c" in
    *"$REMOTE_DIR/bridge.js"*) kill "${p#/proc/}" 2>/dev/null || true ;;
  esac
done
EOS

  if [ -n "$SNAPSHOT_FILE" ] && [ -s "$SNAPSHOT_FILE" ]; then
    echo "== cleanup: restoring TV and BluOS state"
    ssh_run "cd '$REMOTE_DIR' && BLUOS_HOST='$BLUOS_HOST' BLUOS_PORT='$BLUOS_PORT' /usr/bin/node test/device/lib.js restore" \
      < "$SNAPSHOT_FILE" || echo "run.sh: state restore failed; check the TV and BluOS manually" >&2
  fi

  if [ "$WAS_RUNNING" = 1 ] || [ "$INSTALLED" = 1 ]; then
    if ssh_run "test -f '$TV_APP_DIR/bridge.pid' && kill -0 \$(cat '$TV_APP_DIR/bridge.pid') 2>/dev/null"; then
      echo "== cleanup: installed bridge already running"
    else
      start_installed || echo "run.sh: could not restart the installed bridge" >&2
    fi
  fi

  ssh_run "rm -rf '$REMOTE_DIR'" || true
  if [ -n "$SNAPSHOT_FILE" ]; then rm -f "$SNAPSHOT_FILE"; fi
  exit "$status"
}

trap cleanup EXIT INT TERM

echo "== preflight: $TV_USER@$TV_HOST"
ssh_run 'command -v /usr/bin/node >/dev/null && /usr/bin/node --version && test -x /usr/bin/luna-send && echo "luna-send ok"'

if [ -z "${BLUOS_HOST:-}" ]; then
  BLUOS_HOST=$(ssh_run "/usr/bin/node -e 'const c=require(\"$TV_APP_DIR/config.json\"); process.stdout.write(String(c.bluos&&c.bluos.host||\"\"))'")
fi
BLUOS_PORT=${BLUOS_PORT:-11000}
if [ -z "${BLUOS_HOST:-}" ]; then
  echo "run.sh: BLUOS_HOST is unset and $TV_APP_DIR/config.json has no bluos.host" >&2
  exit 2
fi
echo "== bluos: $BLUOS_HOST:$BLUOS_PORT"

echo "== preflight: BluOS reachable from the TV"
ssh_run "curl -s --max-time 5 'http://$BLUOS_HOST:$BLUOS_PORT/Status' >/dev/null"

echo "== copying the suite to $REMOTE_DIR"
tar -C "$REPO_DIR" -cf - bridge.js test/device \
  | ssh_run "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR' && tar -C '$REMOTE_DIR' -xf -"

echo "== snapshotting device state"
SNAPSHOT_FILE=$(mktemp)
ssh_run "cd '$REMOTE_DIR' && BLUOS_HOST='$BLUOS_HOST' BLUOS_PORT='$BLUOS_PORT' /usr/bin/node test/device/lib.js snapshot" \
  > "$SNAPSHOT_FILE"
if [ ! -s "$SNAPSHOT_FILE" ]; then
  echo "run.sh: could not snapshot device state; aborting before changing anything" >&2
  exit 1
fi

if ssh_run "test -f '$TV_APP_DIR/bridge.pid' && kill -0 \$(cat '$TV_APP_DIR/bridge.pid') 2>/dev/null"; then
  WAS_RUNNING=1
  echo "== stopping the installed bridge"
  stop_installed
  # Give the process a moment to release the device before the suite starts.
  sleep 1
else
  echo "== installed bridge is not running"
fi

echo "== on-device suite (allow writes: $ALLOW_WRITES)"
if ssh_run "cd '$REMOTE_DIR' && BLUOS_HOST='$BLUOS_HOST' BLUOS_PORT='$BLUOS_PORT' ALLOW_WRITES='$ALLOW_WRITES' /usr/bin/node --test test/device/device.test.js"; then
  STATUS=0
else
  STATUS=$?
fi
if [ "$ALLOW_WRITES" != 1 ]; then
  echo "== read-only run; re-run with --allow-writes for the volume/stop/drift tests"
fi

if [ "$INSTALLED" = 1 ] && [ "$STATUS" != 0 ]; then
  echo "== deploy skipped: the build under test failed its own suite" >&2
elif [ "$INSTALLED" = 1 ]; then
  echo "== deploying the current build"
  if TV_HOST="$TV_HOST" TV_USER="$TV_USER" sh "$REPO_DIR/install.sh"; then
    echo "== installed-service check"
    if ssh_run "cd '$REMOTE_DIR' && CHECK_INSTALLED=1 ALLOW_WRITES=1 BLUOS_HOST='$BLUOS_HOST' BLUOS_PORT='$BLUOS_PORT' TV_APP_DIR='$TV_APP_DIR' /usr/bin/node --test test/device/installed.test.js"; then
      :
    else
      rc=$?
      if [ "$STATUS" = 0 ]; then STATUS=$rc; fi
    fi
  else
    if [ "$STATUS" = 0 ]; then STATUS=1; fi
  fi
fi

echo
if [ "$STATUS" = 0 ]; then
  echo "== on-device e2e passed"
else
  echo "== on-device e2e FAILED (exit $STATUS)" >&2
fi
exit "$STATUS"
