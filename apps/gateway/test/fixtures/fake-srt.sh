#!/bin/sh
# Stands in for srt in tests: exits 0 for the node's probe, records the
# --settings file and every control-fd line to fake-srt.log next to the
# settings (the node's environment filter drops test variables), then runs
# the command after `--` unconfined.
settings=
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) settings=$2; shift 2 ;;
    --control-fd) shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
if [ -n "$settings" ]; then
  log="$(dirname "$settings")/fake-srt.log"
  { printf 'settings '; cat "$settings"; printf '\n'; } >> "$log"
  if [ -e /dev/fd/3 ]; then
    ( while IFS= read -r line; do printf 'control %s\n' "$line" >> "$log"; done <&3 ) &
  fi
fi
exec "$@"
