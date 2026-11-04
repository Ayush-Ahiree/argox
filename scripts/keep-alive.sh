#!/usr/bin/env bash
# Argox health check + keep-alive.
#
# Pings the Render backend (and the Vercel frontend) so Render's free tier
# doesn't spin the backend down after 15 min idle, and logs status/latency.
#
# Usage:
#   scripts/keep-alive.sh check      # one health check now (exit 1 if anything is down)
#   scripts/keep-alive.sh loop       # check forever, every $INTERVAL seconds (foreground)
#   scripts/keep-alive.sh install    # run every 10 min in the background via a systemd user timer
#   scripts/keep-alive.sh uninstall  # remove the timer
#   scripts/keep-alive.sh status     # timer state + last 20 log lines
#
# Env overrides: ARGOX_URL, FRONTEND_URL, INTERVAL (seconds), LOG, SLOW_SECS
set -uo pipefail

BACKEND="${ARGOX_URL:-https://argox-cflf.onrender.com}"
FRONTEND="${FRONTEND_URL:-https://argox-six.vercel.app}"
INTERVAL="${INTERVAL:-600}"
LOG="${LOG:-$HOME/.argox-healthcheck.log}"
SLOW_SECS="${SLOW_SECS:-10}"   # slower than this = probably a cold start
UNIT="argox-healthcheck"
SELF="$(readlink -f "$0")"

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

notify() {  # desktop popup if available; never fails the check
  command -v notify-send >/dev/null 2>&1 && notify-send -u critical "Argox health check" "$1" 2>/dev/null || true
}

# probe URL -> prints "CODE SECONDS"
probe() {
  curl -s -o /dev/null -w '%{http_code} %{time_total}' --retry 2 --retry-delay 5 --max-time 90 "$1" || echo "000 0"
}

check() {
  local ok=0 code t url

  # Backend: prefer /health; fall back to /docs until /health is deployed.
  url="$BACKEND/health"
  read -r code t <<<"$(probe "$url")"
  if [ "$code" = "404" ]; then url="$BACKEND/docs"; read -r code t <<<"$(probe "$url")"; fi
  if [ "$code" = "200" ]; then
    awk -v t="$t" -v s="$SLOW_SECS" 'BEGIN{exit !(t>s)}' \
      && log "backend  OK   $code ${t}s (slow - was likely asleep) $url" \
      || log "backend  OK   $code ${t}s $url"
  else
    log "backend  FAIL $code ${t}s $url"; notify "Backend down: $url returned $code"; ok=1
  fi

  read -r code t <<<"$(probe "$FRONTEND")"
  if [ "$code" = "200" ]; then
    log "frontend OK   $code ${t}s $FRONTEND"
  else
    log "frontend FAIL $code ${t}s $FRONTEND"; notify "Frontend down: $FRONTEND returned $code"; ok=1
  fi

  # Keep the log small.
  tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  return $ok
}

install_timer() {
  local dir="$HOME/.config/systemd/user"
  mkdir -p "$dir"
  cat > "$dir/$UNIT.service" <<EOF
[Unit]
Description=Argox health check / keep-alive ping
After=network-online.target

[Service]
Type=oneshot
ExecStart=$SELF check
EOF
  cat > "$dir/$UNIT.timer" <<EOF
[Unit]
Description=Run Argox health check every 10 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT.timer"
  echo "Installed. Runs every 10 min while you're logged in. Log: $LOG"
  echo "To keep it running even when logged out:  sudo loginctl enable-linger $USER"
}

uninstall_timer() {
  systemctl --user disable --now "$UNIT.timer" 2>/dev/null
  rm -f "$HOME/.config/systemd/user/$UNIT".{service,timer}
  systemctl --user daemon-reload
  echo "Removed."
}

case "${1:-check}" in
  check)     check ;;
  loop)      while true; do check; sleep "$INTERVAL"; done ;;
  install)   install_timer ;;
  uninstall) uninstall_timer ;;
  status)    systemctl --user list-timers "$UNIT.timer" --no-pager 2>/dev/null; echo; tail -n 20 "$LOG" 2>/dev/null || echo "(no log yet)" ;;
  *)         sed -n '2,15p' "$SELF"; exit 2 ;;
esac
