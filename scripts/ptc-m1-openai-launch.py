#!/usr/bin/env python3
"""Human-operated stdin handoff. Never saves a key or approves the first-triplet gate."""
import argparse
import getpass
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ssh", required=True, help="Explicit authorized user@host")
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--resume-openai-001", action="store_true", help="Only the approved hash-pinned continuation; retains original spend and rows")
mode.add_argument("--team-diagnostic", action="store_true", help="One bounded team diagnostic, not a matrix continuation")
args = parser.parse_args()
if args.ssh.startswith("-") or any(c.isspace() for c in args.ssh):
    parser.error("Invalid SSH target")
if not sys.stdin.isatty():
    parser.error("Run in a real terminal for hidden credential input")
ssh = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", args.ssh]
# Verify access before asking for the key. Do not accept new host keys automatically.
check = subprocess.run(ssh + ["true"], timeout=30, check=False)
if check.returncode:
    raise SystemExit("SSH verification failed. Resolve it before entering a key.")
key = getpass.getpass("OpenAI project API key (hidden): ").strip()
if not key or len(key) > 4096 or any(c.isspace() for c in key):
    raise SystemExit("Invalid or empty credential; cancelled.")
command = '''set -eu
ulimit -c 0
umask 077
cd "$HOME/pirc-ptc-m1-eval/baseline"
exec "$HOME/pirc-ptc-m1-eval/bun-linux-x64/bun" scripts/ptc-m1-openai.ts \
  --execute-openai \
  --node "$PWD/apps/gateway/dist/pirc-node" \
  --chat "$PWD/apps/gateway/dist/pirc-chat" \
  --output "$HOME/pirc-ptc-m1-eval/openai-001"
'''
if args.team_diagnostic:
    command = '''set -eu
ulimit -c 0
umask 077
cd "$HOME/pirc-ptc-m1-eval/baseline"
exec "$HOME/pirc-ptc-m1-eval/bun-linux-x64/bun" scripts/ptc-m1-team-diagnostic.ts
'''
    print("One team diagnostic only: up to 32 requests, 180 seconds, USD 10 extra conservative liability; no automatic continuation.", flush=True)
elif args.resume_openai_001:
    command = command.replace("--execute-openai", "--execute-openai --resume-openai-001").replace('/openai-001"', '/openai-002"')
    print("Continuing from team-wait prime 0; old rows and USD 5.3688009 are retained. Keep terminal open.", flush=True)
else:
    print("Starting the first triplet. Keep this terminal open; do not rerun or remove markers.", flush=True)
try:
    completed = subprocess.run(ssh + [command], input=key.encode(), check=False)
    raise SystemExit(completed.returncode)
finally:
    # Best effort only: Python immutable strings cannot guarantee zeroization.
    key = ""
