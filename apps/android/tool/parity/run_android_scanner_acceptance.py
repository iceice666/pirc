#!/usr/bin/env python3
"""Run Android scanner cancellation/restart acceptance with guarded Back.

This driver presses Back only after dumpsys confirms that Google Play services
owns the resumed activity. A missing/unsupported barcode_ui module is reported
by the Flutter test as a safe scanner error; the driver never removes or installs
that module and never fabricates a QR scan result.
"""

from __future__ import annotations

import argparse
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path


MARKER = re.compile(r"SCANNER_ACCEPTANCE:(launch|result):(\d+)(?::([^\s]+))?")
RESUMED_LINE = re.compile(r"(?:mResumedActivity|topResumedActivity)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="adb device serial")
    parser.add_argument("--flutter", default="flutter", help="Flutter executable")
    parser.add_argument("--adb", default="adb", help="adb executable")
    parser.add_argument(
        "--activity-timeout",
        type=float,
        default=40,
        help="seconds to wait for the GMS scanner activity after each launch",
    )
    return parser.parse_args()


def resumed_activity(adb: str, device: str) -> str | None:
    try:
        completed = subprocess.run(
            [adb, "-s", device, "shell", "dumpsys", "activity", "activities"],
            check=True,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Could not inspect Android activity state: {error}") from error
    for line in completed.stdout.splitlines():
        if RESUMED_LINE.search(line) and "com.google.android.gms" in line:
            return line.strip()
    return None


def press_back(adb: str, device: str) -> None:
    subprocess.run(
        [adb, "-s", device, "shell", "input", "keyevent", "KEYCODE_BACK"],
        check=True,
        capture_output=True,
        text=True,
        timeout=8,
    )


def main() -> int:
    args = parse_args()
    mobile_dir = Path(__file__).resolve().parents[2]
    test_path = mobile_dir / "integration_test" / "android_scanner_test.dart"
    command = [
        args.flutter,
        "test",
        "-d",
        args.device,
        "--dart-define=PIRC_SCANNER_ACCEPTANCE=true",
        str(test_path),
    ]
    print("Running:", " ".join(command), flush=True)
    print(
        "The driver will press Android Back only when the resumed activity is "
        "from com.google.android.gms.",
        flush=True,
    )

    try:
        process = subprocess.Popen(
            command,
            cwd=mobile_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
    except OSError as error:
        print(f"Could not start Flutter: {error}", file=sys.stderr)
        return 2
    assert process.stdout is not None
    output_lines: queue.Queue[str | None] = queue.Queue()

    def read_output() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output_lines.put(line)
        output_lines.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    pending_launch: tuple[int, float, bool] | None = None
    output_open = True
    next_activity_poll = 0.0

    try:
        while output_open or process.poll() is None:
            try:
                line = output_lines.get(timeout=0.25)
            except queue.Empty:
                line = ""
            if line is None:
                output_open = False
            elif line:
                print(line, end="", flush=True)
                match = MARKER.search(line)
                if match is not None:
                    phase, attempt_text, result = match.groups()
                    attempt = int(attempt_text)
                    if phase == "launch":
                        pending_launch = (attempt, time.monotonic(), False)
                        next_activity_poll = 0.0
                    elif pending_launch and pending_launch[0] == attempt:
                        pending_launch = None
                        if result and result.startswith("error:"):
                            code = result.partition(":")[2]
                            print(
                                f"Scanner returned safe error code {code}; "
                                "this is not counted as a successful cancellation.",
                                flush=True,
                            )

            now = time.monotonic()
            if pending_launch is not None and process.poll() is None:
                attempt, started_at, back_sent = pending_launch
                if not back_sent and now >= next_activity_poll:
                    active = resumed_activity(args.adb, args.device)
                    next_activity_poll = now + 0.8
                    if active is not None:
                        print(
                            f"GMS scanner activity detected for attempt {attempt}; "
                            "sending Back to cancel.",
                            flush=True,
                        )
                        press_back(args.adb, args.device)
                        pending_launch = (attempt, now, True)
                    elif now - started_at >= args.activity_timeout:
                        raise RuntimeError(
                            f"No Google Play services scanner activity appeared "
                            f"within {args.activity_timeout:g}s. Check Play services "
                            "and the barcode_ui module; no Back event was sent."
                        )
                elif back_sent and now - started_at >= 15:
                    raise RuntimeError(
                        f"The scanner did not return after Back for attempt {attempt}."
                    )

        return process.wait()
    except KeyboardInterrupt:
        process.terminate()
        process.wait(timeout=10)
        return 130
    except Exception as error:  # fail closed; never Back out of the app
        print(str(error), file=sys.stderr)
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        return 2
if __name__ == "__main__":
    raise SystemExit(main())
