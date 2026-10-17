"""Host-driven real Android IME/rotation acceptance test.

Requires the isolated real_gateway, an installed/booted Android test device,
`adb reverse tcp:18894 tcp:18894`, and the private integration defines file.
The Dart integration test stays active while this driver sends real input and
rotation changes. This driver does not print pairing or account credentials.
"""

import os
import re
from pathlib import Path
import subprocess
import sys
import threading
import time
import tempfile

from mobile_tool_paths import resolve_adb, resolve_flutter

ROOT = Path(__file__).resolve().parents[4]
MOBILE = ROOT / 'apps/android'
ADB = resolve_adb()
FLUTTER = resolve_flutter()
DEVICE = os.environ.get('PIRC_TEST_DEVICE', 'emulator-5554')
PACKAGE = re.search(
    r'applicationId\s*=\s*"([^"]+)"',
    (MOBILE / 'android/app/build.gradle.kts').read_text(),
).group(1)
LOG = Path(tempfile.gettempdir()) / 'pirc-android-input-rotation.log'
PHASE_NAMES = [
    'COMPOSER_TAP',
    'IME_VISIBLE',
    'DRAFT_READY_BACK',
    'IME_HIDDEN',
    'READY_LANDSCAPE',
    'LANDSCAPE',
    'PORTRAIT',
    'ACCEPTED',
]
PHASES = {name: threading.Event() for name in PHASE_NAMES}
TAP = {}
TAP_READY = threading.Event()


def adb(*args, timeout=20):
    return subprocess.run(
        [ADB, '-s', DEVICE, *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    ).stdout.strip()


def get_setting(namespace, key):
    value = adb('shell', 'settings', 'get', namespace, key)
    return None if value in ('', 'null') else value


def set_setting(namespace, key, value):
    if value is None:
        adb('shell', 'settings', 'delete', namespace, key)
    else:
        adb('shell', 'settings', 'put', namespace, key, value)


def set_rotation(rotation):
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
    adb('shell', 'settings', 'put', 'system', 'user_rotation', str(rotation))


def restore_rotation(original):
    set_setting('system', 'user_rotation', original['user_rotation'])
    set_setting('system', 'accelerometer_rotation', original['accelerometer_rotation'])


def _read_output(process):
    descriptor = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as log:
        for line in process.stdout:
            log.write(line)
            log.flush()
            match = re.search(
                r'ANDROID_INPUT_ROTATION_COMPOSER_TAP\s+(\d+)\s+(\d+)', line
            )
            if match:
                TAP['x'] = match.group(1)
                TAP['y'] = match.group(2)
                TAP_READY.set()
            for name, event in PHASES.items():
                if f'ANDROID_INPUT_ROTATION_{name}' in line:
                    event.set()


def _await(process, event, timeout, label):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if event.is_set():
            return
        if process.poll() is not None:
            raise RuntimeError(
                f'{label} exited before its checkpoint (exit {process.returncode}); inspect {LOG}'
            )
        time.sleep(0.1)
    raise TimeoutError(f'{label} did not reach its checkpoint; inspect {LOG}')


def _stop(process, reader):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    reader.join(timeout=5)


def main():
    original_rotation = {
        'accelerometer_rotation': get_setting('system', 'accelerometer_rotation'),
        'user_rotation': get_setting('system', 'user_rotation'),
    }
    original_show_ime = get_setting('secure', 'show_ime_with_hard_keyboard')
    process = None
    reader = None
    acted = set()
    try:
        # The integration test's initial-size assertion starts from a known
        # portrait view. The original user settings are restored in `finally`.
        # Emulator/host keyboards can otherwise suppress the software IME
        # even when the Flutter text field receives the real pointer tap.
        adb(
            'shell', 'settings', 'put', 'secure',
            'show_ime_with_hard_keyboard', '1',
        )
        set_rotation(0)
        process = subprocess.Popen(
            [
                FLUTTER,
                'test',
                'integration_test/android_input_rotation_test.dart',
                '-d',
                DEVICE,
                '--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json',
                '--dart-define=PIRC_ANDROID_INPUT_ROTATION=true',
            ],
            cwd=MOBILE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        reader = threading.Thread(target=_read_output, args=(process,), daemon=True)
        reader.start()
        started = time.monotonic()

        _await(process, TAP_READY, 240, 'visible composer')
        adb('shell', 'input', 'tap', TAP['x'], TAP['y'])
        acted.add('tap')
        print('Tapped the composer using its measured physical screen coordinates.', flush=True)

        _await(process, PHASES['IME_VISIBLE'], 90, 'real Android IME and Flutter viewInsets')
        adb('shell', 'input', 'text', 'android_rotation_draft_2026')
        acted.add('text')
        print('Typed the ASCII draft through Android input.', flush=True)

        _await(process, PHASES['DRAFT_READY_BACK'], 90, 'unsent draft')
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        acted.add('back')
        print('Sent Android Back to close the IME.', flush=True)

        _await(process, PHASES['IME_HIDDEN'], 90, 'IME dismissal with draft preserved')
        _await(process, PHASES['READY_LANDSCAPE'], 30, 'landscape checkpoint')
        set_rotation(1)
        acted.add('landscape')
        print('Locked Android rotation to landscape.', flush=True)

        _await(process, PHASES['LANDSCAPE'], 90, 'landscape Flutter viewport')
        set_rotation(0)
        acted.add('portrait')
        print('Restored portrait rotation.', flush=True)

        _await(process, PHASES['PORTRAIT'], 90, 'portrait Flutter viewport and live session')
        _await(process, PHASES['ACCEPTED'], 30, 'integration assertions')
        if time.monotonic() - started > 300:
            raise TimeoutError('Android input/rotation acceptance exceeded 300 seconds')
        process.wait(timeout=30)
        reader.join(timeout=5)
        if process.returncode != 0:
            raise RuntimeError(f'Flutter integration failed; inspect {LOG}')
        if acted != {'tap', 'text', 'back', 'landscape', 'portrait'}:
            raise RuntimeError('Not all real Android input and rotation actions were performed')
        if not all(PHASES[name].is_set() for name in PHASE_NAMES):
            raise RuntimeError('Flutter success did not include every device checkpoint')
        print(
            'Android IME, unsent draft, Back dismissal, landscape and portrait restoration passed.',
            flush=True,
        )
        return 0
    except Exception:
        print(f'Android input/rotation acceptance failed; private log: {LOG}', flush=True)
        raise
    finally:
        try:
            # Do not leave a system keyboard visible or alter the caller’s
            # rotation preference if the test or host actions fail.
            adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        except Exception:
            pass
        try:
            restore_rotation(original_rotation)
        except Exception:
            pass
        try:
            set_setting(
                'secure', 'show_ime_with_hard_keyboard', original_show_ime
            )
        except Exception:
            pass
        if process is not None and reader is not None:
            _stop(process, reader)


if __name__ == '__main__':
    if sys.argv[1:]:
        raise SystemExit('usage: run_android_input_rotation.py')
    raise SystemExit(main())
