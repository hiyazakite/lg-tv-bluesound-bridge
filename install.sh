#!/bin/sh
# Install lg-tv-bluesound-bridge on an LG webOS TV.
#
# Run it on the TV (as root) after copying the files, or on a workstation to
# deploy over SSH:
#   TV_HOST=192.168.1.50 BLUOS_HOST=192.168.1.60 ./install.sh
#
# Options: --uninstall  --force-config  --no-start
#
# The installed service keeps the internal name "bluos-bridge"
# (/var/lib/bluos-bridge and 70-bluos-bridge) so an upgrade replaces the
# existing install in place instead of creating a second service.
set -eu

HOOK_NAME=70-bluos-bridge
APP_DIR=/var/lib/bluos-bridge
HOOK_DIR=/var/lib/webosbrew/init.d
LOG_FILE="$APP_DIR/bridge.log"
PID_FILE="$APP_DIR/bridge.pid"

ACTION=install
FORCE_CONFIG=0
START=1
WANT_HOST=${BLUOS_HOST:-}

case "$WANT_HOST" in
  *[!A-Za-z0-9._:-]*)
    echo "install.sh: BLUOS_HOST must be a hostname or IP address: $WANT_HOST" >&2
    exit 2
    ;;
esac

usage() {
  cat <<'EOS'
Usage: install.sh [--uninstall] [--force-config] [--no-start]

Runs on the TV when /var/lib/webosbrew/init.d exists; otherwise deploys over
SSH. No dependencies are installed: Node 18+ and luna-send must already be on
the TV (the webOS Homebrew Channel provides Node).

Environment:
  TV_HOST          TV address, e.g. 192.168.1.50 (required for a remote install)
  TV_USER          SSH user (default root)
  TV_KEY           optional SSH private key, passed to ssh -i
  BLUOS_HOST       player address written to bluos.host (optional)

Options:
  --uninstall      stop the bridge and remove the hook and /var/lib/bluos-bridge
  --force-config   replace an existing config with the repository template
  --no-start       install the files but do not start the service

Examples:
  TV_HOST=192.168.1.50 BLUOS_HOST=192.168.1.60 ./install.sh
  TV_HOST=192.168.1.50 ./install.sh --force-config
  TV_HOST=192.168.1.50 ./install.sh --uninstall
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

  if [ ! -x /usr/bin/node ]; then
    echo "install.sh: /usr/bin/node not found." >&2
    echo "  Install the webOS Homebrew Channel (it provides Node), then retry." >&2
    exit 1
  fi

  mkdir -p "$APP_DIR"
  cp "$SCRIPT_DIR/bridge.js" "$APP_DIR/bridge.js"
  chmod 644 "$APP_DIR/bridge.js"

  if [ ! -f "$APP_DIR/config.json" ] || [ "$FORCE_CONFIG" = 1 ]; then
    cp "$SCRIPT_DIR/config.json" "$APP_DIR/config.json"
  else
    echo "keeping existing $APP_DIR/config.json (use --force-config to replace it)"
  fi

  if [ -n "$WANT_HOST" ]; then
    # Only the host field changes: every other setting in an existing config
    # is left alone.
    sed -i 's/"host"[[:space:]]*:[[:space:]]*"[^"]*"/"host": "'"$WANT_HOST"'"/' "$APP_DIR/config.json"
    echo "set bluos.host to $WANT_HOST in $APP_DIR/config.json"
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

  CONFIG_HOST=$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/config.json" 2>/dev/null | head -n 1)
  [ -n "$CONFIG_HOST" ] || CONFIG_HOST="<player-ip>"

  TEMPLATE_HOST=$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/config.json" 2>/dev/null | head -n 1)
  if [ -z "$WANT_HOST" ] && [ "$CONFIG_HOST" = "$TEMPLATE_HOST" ]; then
    cat >&2 <<EOS

warning: the config still points at the example address $TEMPLATE_HOST.
         Re-run with BLUOS_HOST=<player-ip>, or edit $APP_DIR/config.json
         and restart $HOOK_DIR/$HOOK_NAME.
EOS
  fi

  if [ "$START" = 1 ]; then
    ACTION_WORD=Restart
    cat <<EOS

Installed and running. Next steps:
  1. Watch the log:
       tail -f $LOG_FILE
     from your workstation: ssh root@<tv-ip> tail -f $LOG_FILE
  2. Change the TV volume with the remote: the Bluesound app should follow.
  3. Change the volume in the Bluesound app: the TV should follow within a second.
EOS
  else
    ACTION_WORD=Start
    cat <<EOS

Installed, but not started (--no-start). Start it with:
       $HOOK_DIR/$HOOK_NAME
EOS
  fi

  printf '\nConfig:  %s  (player: %s)\n' "$APP_DIR/config.json" "$CONFIG_HOST"
  printf '%-8s %s\n' "$ACTION_WORD:" "$HOOK_DIR/$HOOK_NAME"
  printf 'Check:   %s\n' "curl -s http://$CONFIG_HOST:11000/Volume"
  printf 'Remove:  %s\n' "./install.sh --uninstall"
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
    | ssh_run "$user@$host" 'rm -rf /tmp/lg-tv-bluesound-bridge && mkdir -p /tmp/lg-tv-bluesound-bridge && tar -C /tmp/lg-tv-bluesound-bridge -xf -'
  ssh_run "$user@$host" "BLUOS_HOST='$WANT_HOST' sh /tmp/lg-tv-bluesound-bridge/install.sh $*"
}

if is_tv; then
  case "$ACTION" in
    install) install_local ;;
    uninstall) uninstall_local ;;
  esac
else
  deploy_remote "$@"
fi
