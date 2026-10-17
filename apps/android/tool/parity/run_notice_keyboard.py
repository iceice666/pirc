"""Run long-notice acceptance with a real Android pointer and IME.

Only the isolated pirc-review emulator is supported. No Gateway/credentials are
needed; the production notification surface runs in a small integration host.
"""
from pathlib import Path
import re
import subprocess
import threading
import tempfile

from mobile_tool_paths import android_tool_environment, resolve_adb, resolve_flutter

MOBILE = Path(__file__).resolve().parents[2]
ADB = resolve_adb()
FLUTTER = resolve_flutter()
DEVICE = 'emulator-5554'
LOG = Path(tempfile.gettempdir()) / 'pirc-notice-android.log'


def adb(*args):
    return subprocess.run([ADB, '-s', DEVICE, *args], check=True,
        capture_output=True, text=True, timeout=20).stdout.strip()


def main():
    name = adb('emu', 'avd', 'name').splitlines()[0]
    if name != 'pirc-review':
        raise RuntimeError('This driver requires the isolated pirc-review AVD.')
    old_ime = adb('shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard')
    process = None
    errors, tapped = [], []
    try:
        adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1')
        env = android_tool_environment(adb_path=ADB)
        process = subprocess.Popen([FLUTTER, 'test', 'integration_test/notice_keyboard_test.dart',
            '-d', DEVICE, '--reporter', 'expanded'], cwd=MOBILE, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

        def read_output():
            with LOG.open('w') as log:
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    match = re.search(r'ANDROID_NOTICE_TAP (dark|light) (\d+) (\d+)', line)
                    if match:
                        try:
                            focus = adb('shell', 'dumpsys', 'window')
                            current = next((line for line in focus.splitlines() if 'mCurrentFocus=' in line), '')
                            if 'dev.pirc.mobile.preview/' not in current:
                                raise RuntimeError(f'App is not the focused Android window: {current.strip()}')
                            adb('shell', 'input', 'tap', match[2], match[3])
                            tapped.append(match[1])
                        except Exception as error:
                            errors.append(str(error))

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        code = process.wait(timeout=240)
        reader.join(timeout=10)
        if code or errors or tapped != ['dark', 'light']:
            raise RuntimeError(f'Acceptance failed: exit={code}, taps={tapped}, errors={errors}; see {LOG}')
        print(f'Android dark/light real-IME notice acceptance passed; log: {LOG}', flush=True)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if old_ime in ('', 'null'):
            adb('shell', 'settings', 'delete', 'secure', 'show_ime_with_hard_keyboard')
        else:
            adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', old_ime)


if __name__ == '__main__':
    main()
