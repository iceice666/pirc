#!/bin/sh
# Stands in for srt in tests: exits 0 for the node's probe, records the
# --settings file and every control-fd line to $FAKE_SRT_LOG, then runs the
# command after `--` unconfined.
settings=
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) settings=$2; shift 2 ;;
    --control-fd) shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
if [ -n "$FAKE_SRT_LOG" ] && [ -n "$settings" ]; then
  { printf 'settings '; cat "$settings"; printf '\n'; } >> "$FAKE_SRT_LOG"
  if [ -e /dev/fd/3 ]; then
    ( while IFS= read -r line; do printf 'control %s\n' "$line" >> "$FAKE_SRT_LOG"; done <&3 ) &
  fi
fi
exec "$@"
