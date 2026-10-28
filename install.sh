#!/bin/sh
# Install the BluOS bridge on an LG webOS TV.
#
# Run it on the TV (as root) after copying the files, or run it on a
# workstation and it deploys over SSH:
#   TV_HOST=192.168.1.50 ./install.sh
#
# Options: --uninstall  --force-config  --no-start
set -eu

HOOK_NAME=70-bluos-bridge
APP_DIR=/var/lib/bluos-bridge
HOOK_DIR=/var/lib/webosbrew/init.d
LOG_FILE="$APP_DIR/bridge.log"
PID_FILE="$APP_DIR/bridge.pid"

ACTION=install
FORCE_CONFIG=0
START=1

usage() {
  cat <<'EOS'
Usage: install.sh [--uninstall] [--force-config] [--no-start]

Runs on the TV when /var/lib/webosbrew/init.d exists; otherwise deploys over
SSH using TV_HOST (required), TV_USER (default root) and TV_KEY (optional;
when unset, ssh uses your own config, agent and identities).

  --uninstall     stop the bridge and remove the hook and /var/lib/bluos-bridge
  --force-config  overwrite an existing /var/lib/bluos-bridge/config.json
  --no-start      install the files but do not start the service
EOS
}

for arg in "$@"; do
  case "$arg" in
    --uninstall) ACTION=uninstall ;;
    --force-config) FORCE_CONFIG=1 ;;
    --no-start) START=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

is_tv() {
  [ -d "$HOOK_DIR" ] && [ -x /usr/bin/luna-send ]
}

kill_bridge() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
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
}

install_local() {
  [ "$(id -u)" = 0 ] || { echo "install.sh: must run as root on the TV" >&2; exit 1; }

  mkdir -p "$APP_DIR"
  cp "$SCRIPT_DIR/bridge.js" "$APP_DIR/bridge.js"
  chmod 644 "$APP_DIR/bridge.js"

  if [ ! -f "$APP_DIR/config.json" ] || [ "$FORCE_CONFIG" = 1 ]; then
    cp "$SCRIPT_DIR/config.json" "$APP_DIR/config.json"
  else
    echo "keeping existing $APP_DIR/config.json (use --force-config to overwrite)"
  fi

  mkdir -p "$HOOK_DIR"
  cp "$SCRIPT_DIR/init.d/$HOOK_NAME" "$HOOK_DIR/$HOOK_NAME"
  chmod 755 "$HOOK_DIR/$HOOK_NAME"
  echo "installed $APP_DIR/bridge.js and $HOOK_DIR/$HOOK_NAME"

  if [ "$START" = 1 ]; then
    "$HOOK_DIR/$HOOK_NAME"
    sleep 1
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      echo "install.sh: bridge did not start; last log lines:" >&2
      tail -n 20 "$LOG_FILE" 2>/dev/null >&2 || true
      exit 1
    fi
    echo "bridge running (pid $pid), log: $LOG_FILE"
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
  fi

  BLUOS_HOST=$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/config.json" 2>/dev/null | head -n 1)
  [ -n "$BLUOS_HOST" ] || BLUOS_HOST="<bluos-host>"

  cat <<EOS

Next steps:
  watch:  tail -f $LOG_FILE
  test:   luna-send -n 1 luna://com.webos.service.audio/master/setVolume '{"volume":50}' </dev/null
  check:  curl -s http://$BLUOS_HOST:11000/Volume
  remove: $SCRIPT_DIR/install.sh --uninstall
EOS
}

uninstall_local() {
  kill_bridge
  rm -f "$HOOK_DIR/$HOOK_NAME"
  rm -rf "$APP_DIR"
  echo "removed $HOOK_DIR/$HOOK_NAME and $APP_DIR"
  echo "removed the log with it"
}

deploy_remote() {
  host=${TV_HOST:-}
  if [ -z "$host" ]; then
    echo "install.sh: TV_HOST is required, e.g. TV_HOST=192.168.1.50 $0" >&2
    exit 2
  fi
  user=${TV_USER:-root}
  key=${TV_KEY:-}

  # Only pass -i when the caller asked for a specific key. Otherwise ssh
  # resolves identities from the user's own config and agent, which is what
  # anyone running a generic installer expects.
  ssh_run() {
    if [ -n "$key" ]; then
      ssh -i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 "$@"
    else
      ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 "$@"
    fi
  }

  echo "deploying to $user@$host"
  tar -C "$SCRIPT_DIR" -cf - bridge.js config.json install.sh init.d \
    | ssh_run "$user@$host" 'rm -rf /tmp/tv-bluos-bridge && mkdir -p /tmp/tv-bluos-bridge && tar -C /tmp/tv-bluos-bridge -xf -'
  ssh_run "$user@$host" sh /tmp/tv-bluos-bridge/install.sh "$@"
}

if is_tv; then
  case "$ACTION" in
    install) install_local ;;
    uninstall) uninstall_local ;;
  esac
else
  deploy_remote "$@"
fi
