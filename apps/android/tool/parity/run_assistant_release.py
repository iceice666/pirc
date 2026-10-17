"""Accept Assistant release through Android UI against the disposable helper.

Start real_gateway.ts, boot pirc-review and add its 18894 adb reverse first.
The driver verifies process parentage and exact entry path before stopping only
that helper's chat node. It never targets a production node or another AVD.
"""
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import threading
import tempfile

from mobile_tool_paths import android_tool_environment, resolve_adb, resolve_flutter

MOBILE = Path(__file__).resolve().parents[2]
ROOT = MOBILE.parents[1]
ADB = resolve_adb()
FLUTTER = resolve_flutter()
DEVICE = 'emulator-5554'
LOG = Path(tempfile.gettempdir()) / 'pirc-assistant-release-android.log'


def adb(*args):
    return subprocess.run([ADB, '-s', DEVICE, *args], check=True,
        capture_output=True, text=True, timeout=20).stdout.strip()


def stop_owned_chat():
    runtime = json.loads((ROOT / '.pirc/flutter-parity-integration/runtime.json').read_text())
    services = [
        service for service in runtime.get('services', [])
        if service.get('name') == 'chat'
    ]
    if len(services) != 1:
        raise RuntimeError('Runtime manifest does not identify exactly one Rust chat service.')
    service = services[0]
    expected_executable = Path(service.get('executable', '')).resolve()
    expected_args = service.get('args')
    if not expected_executable.is_file() or expected_args != ['chat']:
        raise RuntimeError('Runtime manifest has an unexpected Rust chat executable or argv.')
    pid = int(service['pid'])
    result = subprocess.run(
        ['ps', '-p', str(pid), '-o', 'ppid=', '-o', 'command='],
        capture_output=True, text=True, timeout=5)
    row = result.stdout.strip().split(maxsplit=1)
    if len(row) != 2:
        raise RuntimeError('The helper-owned Rust chat process is no longer live.')
    try:
        parent_pid = int(row[0])
        command = shlex.split(row[1])
    except (ValueError, RuntimeError) as error:
        raise RuntimeError('Could not parse the helper-owned Rust process record.') from error
    if not command:
        raise RuntimeError('The helper-owned Rust process has no command line.')
    actual_executable = Path(command[0]).resolve()
    actual_args = command[1:]
    if (
        parent_pid != int(runtime['pid'])
        or actual_executable != expected_executable
        or actual_args != expected_args
    ):
        raise RuntimeError('Refusing to stop a process that does not exactly match the Rust chat service.')
    os.kill(pid, signal.SIGTERM)
    return pid


def main():
    if adb('emu', 'avd', 'name').splitlines()[0] != 'pirc-review':
        raise RuntimeError('Only the isolated pirc-review AVD is supported.')
    env = android_tool_environment(adb_path=ADB)
    process = subprocess.Popen([FLUTTER, 'test', 'integration_test/assistant_release_test.dart',
        '-d', DEVICE, '--reporter', 'expanded',
        '--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json',
        '--dart-define=PIRC_ASSISTANT_RELEASE_NODE=true'], cwd=MOBILE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    errors, stopped = [], []
    def read_output():
        with LOG.open('w') as log:
            for line in process.stdout:
                log.write(line)
                log.flush()
                if 'ASSISTANT_RELEASE_STOP_NODE' in line:
                    try:
                        stopped.append(stop_owned_chat())
                    except Exception as error:
                        errors.append(str(error))
    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    try:
        code = process.wait(timeout=240)
        reader.join(timeout=10)
        if code or errors or len(stopped) != 1:
            raise RuntimeError(f'Assistant release failed: exit={code}, stopped={len(stopped)}, errors={errors}; {LOG}')
        print(f'Android release cancel/confirm/exact-node/no-replay passed; log: {LOG}', flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        reader.join(timeout=5)


if __name__ == '__main__':
    main()
