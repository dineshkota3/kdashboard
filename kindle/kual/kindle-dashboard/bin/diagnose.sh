#!/bin/sh

CONFIG="${DASHBOARD_CONFIG:-/mnt/us/extensions/kindle-dashboard/config.sh}"
[ -f "$CONFIG" ] && . "$CONFIG"

LOG="${LOG:-/mnt/us/documents/kindle-dashboard-diagnose.log}"
DASHBOARD_DATA_URL="${DASHBOARD_DATA_URL:-}"
DASHBOARD_EVENTS_URL="${DASHBOARD_EVENTS_URL:-}"
CACHE="${CACHE:-/mnt/us/documents/kindle-dashboard-diagnose-data.json}"
SAVE_PGM="${SAVE_PGM:-/mnt/us/documents/kindle-dashboard-last-render.pgm}"
SCRIPT_DIR="$(dirname "$0")"
NATIVE_APP="${NATIVE_APP:-$SCRIPT_DIR/kindle-dashboard}"
RUN_APP="${RUN_APP:-/tmp/kindle-dashboard-native-diagnose}"

say() {
  eips 2 2 "$1" >/dev/null 2>&1 || true
}

write_log() {
  echo "$*" >> "$LOG"
}

check_command() {
  name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    write_log "ok command $name: $(command -v "$name")"
    return 0
  fi
  write_log "missing command $name"
  return 1
}

echo "kindle-dashboard diagnose $(date '+%Y-%m-%d %H:%M:%S')" > "$LOG"
write_log "native_app=$NATIVE_APP"
write_log "data_url=$DASHBOARD_DATA_URL"
write_log "events_url=$DASHBOARD_EVENTS_URL"
write_log "cache=$CACHE"
write_log "save_pgm=$SAVE_PGM"
write_log "uname=$(uname -a 2>/dev/null)"

if [ -x "$NATIVE_APP" ]; then
  write_log "ok native executable"
  if command -v file >/dev/null 2>&1; then
    write_log "file=$(file "$NATIVE_APP" 2>/dev/null)"
  fi
else
  write_log "missing native executable"
  say "Dashboard native missing"
  exit 0
fi

if [ -z "$DASHBOARD_DATA_URL" ]; then
  write_log "missing DASHBOARD_DATA_URL; create /mnt/us/extensions/kindle-dashboard/config.sh"
  say "Dashboard config missing"
  exit 1
fi

check_command eips
check_command fbink
check_command lipc-set-prop
check_command curl || check_command wget

if [ -e /dev/fb0 ]; then
  write_log "ok framebuffer /dev/fb0"
  ls -l /dev/fb0 >> "$LOG" 2>&1 || true
  for fb_meta in /sys/class/graphics/fb0/name /sys/class/graphics/fb0/modes /sys/class/graphics/fb0/virtual_size /sys/class/graphics/fb0/bits_per_pixel; do
    [ -r "$fb_meta" ] && write_log "$fb_meta=$(cat "$fb_meta" 2>/dev/null)"
  done
else
  write_log "missing framebuffer /dev/fb0"
fi

lipc-set-prop com.lab126.cmd wirelessEnable 1 >/dev/null 2>&1 || true

write_log "running native one-shot"
cp "$NATIVE_APP" "$RUN_APP" >> "$LOG" 2>&1
chmod 755 "$RUN_APP" >> "$LOG" 2>&1
"$RUN_APP" --url "$DASHBOARD_DATA_URL" --events-url "$DASHBOARD_EVENTS_URL" --read-token "$DASHBOARD_READ_TOKEN" --cache "$CACHE" --once --save-pgm "$SAVE_PGM" >> "$LOG" 2>&1
status="$?"
write_log "native exit=$status"
if [ -s "$SAVE_PGM" ]; then
  write_log "ok saved render bytes=$(wc -c < "$SAVE_PGM" 2>/dev/null)"
else
  write_log "missing saved render $SAVE_PGM"
fi
rm -f "$RUN_APP"

if [ "$status" -eq 0 ] && [ -s "$CACHE" ]; then
  write_log "ok cache bytes=$(wc -c < "$CACHE" 2>/dev/null)"
  say "Dashboard diag OK"
  exit 0
fi

say "Dashboard diag failed"
exit 0
