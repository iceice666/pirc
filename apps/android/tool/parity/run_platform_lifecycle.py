"""Host-driven Android lifecycle acceptance; no production transport hooks.

Start real_gateway.ts and the isolated emulator / adb reverse first.
The Flutter test stays live while adb sends actual system focus/Home/resume events.
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
PACKAGE = re.search(r'applicationId\s*=\s*"([^"]+)"', (MOBILE / 'android/app/build.gradle.kts').read_text()).group(1)
LOG = Path(tempfile.gettempdir()) / 'pirc-platform-lifecycle-android.log'
PHASES = ['READY_INACTIVE', 'INACTIVE_OBSERVED', 'READY_BACKGROUND', 'OWNER_BACKGROUND_STARTED', 'OWNER_RETAINED', 'HIDDEN_DID_NOT_ACQUIRE', 'BACKGROUND_STREAM_LIVE', 'SERVER_CHANGED', 'ACCEPTED']
events = {phase: threading.Event() for phase in PHASES}


def adb(*args):
    subprocess.run([ADB, '-s', DEVICE, *args], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)


def foreground():
    result = subprocess.check_output([ADB, '-s', DEVICE, 'shell', 'cmd', 'package',
        'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN',
        '-c', 'android.intent.category.LAUNCHER', PACKAGE], text=True, timeout=15)
    component = result.strip().splitlines()[-1]
    if '/' not in component or not component.startswith(PACKAGE + '/'):
        raise RuntimeError('Could not resolve the installed test APK launcher activity')
    adb('shell', 'am', 'start', '-a', 'android.intent.action.MAIN',
        '-c', 'android.intent.category.LAUNCHER', '-n', component)



def _package_pids():
    result = subprocess.run(
        [ADB, '-s', DEVICE, 'shell', 'pidof', PACKAGE],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=15)
    return {part for part in result.stdout.split() if part.isdigit()}


def _start_process_death_stage(stage, session_id=None, client_id=None):
    log_path = Path(tempfile.gettempdir()) / f'pirc-platform-process-{stage}.log'
    descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    args = [
        FLUTTER, 'test', 'integration_test/platform_lifecycle_test.dart', '-d', DEVICE,
        '--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json',
        '--no-uninstall',
        f'--dart-define=PIRC_PROCESS_DEATH_STAGE={stage}',
    ]
    if session_id is not None:
        args.append(f'--dart-define=PIRC_PROCESS_DEATH_SESSION={session_id}')
    if client_id is not None:
        args.append(f'--dart-define=PIRC_PROCESS_DEATH_CLIENT={client_id}')
    process = subprocess.Popen(
        args, cwd=MOBILE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1)
    markers = {
        'draft_ready': threading.Event(),
        'restored': threading.Event(),
        'cleaned': threading.Event(),
    }
    identity = {}

    def read_output():
        with os.fdopen(descriptor, 'w') as log:
            for line in process.stdout:
                log.write(line)
                log.flush()
                match = re.search(
                    r'LIFE_PHASE_PROCESS_DRAFT_READY\s+(\S+)\s+(\S+)', line)
                if match:
                    identity['session'] = match.group(1)
                    identity['client'] = match.group(2)
                    markers['draft_ready'].set()
                if 'LIFE_PHASE_PROCESS_RESTORED' in line:
                    markers['restored'].set()
                if 'LIFE_PHASE_PROCESS_CLEANED' in line:
                    markers['cleaned'].set()

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    return process, reader, markers, identity, log_path


def _await_marker(process, event, timeout, label, log_path):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if event.is_set():
            return
        if process.poll() is not None:
            raise RuntimeError(
                f'{label} exited before its marker (exit {process.returncode}); inspect {log_path}')
        time.sleep(0.1)
    raise TimeoutError(f'{label} did not reach its marker; inspect {log_path}')


def process_death_acceptance():
    """Two-run cold-start check for durable pairing, client ID, and draft."""
    prepare, prepare_reader, prepare_markers, identity, prepare_log = \
        _start_process_death_stage('prepare')
    restore = None
    try:
        _await_marker(prepare, prepare_markers['draft_ready'], 240,
                      'prepare integration', prepare_log)
        session_id = identity['session']
        client_id = identity['client']
        if not session_id or not client_id or client_id == 'null':
            raise RuntimeError(f'Invalid process-death identity in {prepare_log}')
        before_pids = _package_pids()
        if not before_pids:
            raise RuntimeError('No running app package PID before the force-stop checkpoint')
        adb('shell', 'am', 'force-stop', PACKAGE)
        deadline = time.monotonic() + 15
        while _package_pids() and time.monotonic() < deadline:
            time.sleep(0.1)
        if _package_pids():
            raise RuntimeError('Android package process remained after am force-stop')
        print('Android package process force-stopped; old PID(s): ' + ','.join(sorted(before_pids)), flush=True)

        # Force-stop intentionally destroys the in-process integration runner too.
        # Flutter therefore reports that first test as interrupted; that nonzero
        # result is expected only after the Android package PID is gone.
        try:
            prepare.wait(timeout=20)
        except subprocess.TimeoutExpired:
            prepare.terminate()
            try:
                prepare.wait(timeout=10)
            except subprocess.TimeoutExpired:
                prepare.kill()
                prepare.wait(timeout=5)
        prepare_reader.join(timeout=5)
        if prepare.returncode == 0:
            raise RuntimeError('Prepare test completed normally instead of being process-killed')
        print('Prepare integration interrupted by force-stop as expected', flush=True)

        restore, restore_reader, restore_markers, _, restore_log = \
            _start_process_death_stage('restore', session_id, client_id)
        _await_marker(restore, restore_markers['restored'], 240,
                      'restore integration', restore_log)
        # Leave the fresh app running briefly so the host can distinguish a
        # live restored process from a marker emitted just before test teardown.
        time.sleep(1)
        deadline = time.monotonic() + 15
        after_pids = _package_pids()
        while not after_pids and time.monotonic() < deadline:
            time.sleep(0.1)
            after_pids = _package_pids()
        if not after_pids:
            raise RuntimeError('No app package PID was running after the fresh process restored the draft')
        if before_pids.intersection(after_pids):
            raise RuntimeError(
                'The restored app reused a pre-kill PID; fresh-process evidence is ambiguous')
        print('Fresh app PID confirmed after restore: ' + ','.join(sorted(after_pids)), flush=True)
        _await_marker(restore, restore_markers['cleaned'], 240,
                      'restore cleanup', restore_log)
        restore.wait(timeout=30)
        restore_reader.join(timeout=5)
        if restore.returncode != 0 or not restore_markers['restored'].is_set():
            raise RuntimeError(
                f'Fresh process restoration failed (exit {restore.returncode}); inspect {restore_log}')
        print('Cold Android process restart restored pairing, client ID, and the unsent Unicode draft; no command was sent', flush=True)
        return 0
    finally:
        if prepare.poll() is None:
            prepare.terminate()
            try:
                prepare.wait(timeout=10)
            except subprocess.TimeoutExpired:
                prepare.kill()
                prepare.wait(timeout=5)
        prepare_reader.join(timeout=5)
        if restore is not None and restore.poll() is None:
            restore.terminate()
            try:
                restore.wait(timeout=10)
            except subprocess.TimeoutExpired:
                restore.kill()
                restore.wait(timeout=5)


def main():
    descriptor = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    process = subprocess.Popen([
        FLUTTER, 'test', 'integration_test/platform_lifecycle_test.dart', '-d', DEVICE,
        '--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json',
        '--dart-define=PIRC_PLATFORM_LIFECYCLE=true',
    ], cwd=MOBILE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    def read_output():
        with os.fdopen(descriptor, 'w') as log:
            for line in process.stdout:
                log.write(line)
                log.flush()
                for phase, event in events.items():
                    if 'LIFE_PHASE_' + phase in line:
                        event.set()
    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    acted = set()
    hold_until = None
    started = time.monotonic()
    try:
        while process.poll() is None:
            if time.monotonic() - started > 240:
                raise TimeoutError('Android lifecycle test exceeded the host deadline')
            if events['READY_INACTIVE'].is_set() and 'expand' not in acted:
                adb('shell', 'cmd', 'statusbar', 'expand-notifications')
                acted.add('expand')
                print('Android notification shade opened (real focus interruption)', flush=True)
            if events['INACTIVE_OBSERVED'].is_set() and 'collapse' not in acted:
                adb('shell', 'cmd', 'statusbar', 'collapse')
                acted.add('collapse')
                print('Android notification shade closed', flush=True)
            if events['READY_BACKGROUND'].is_set() and 'home' not in acted:
                adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                acted.add('home')
                print('Android Home sent; App moved to background', flush=True)
            if events['SERVER_CHANGED'].is_set() and hold_until is None:
                hold_until = time.monotonic() + 2
                print('Owner survived 35s and hidden free-lease check passed; returning after live background event', flush=True)
            if hold_until is not None and time.monotonic() >= hold_until and 'resume' not in acted:
                foreground()
                acted.add('resume')
                print('Android launcher restored the existing App activity', flush=True)
            time.sleep(0.1)
        reader.join(timeout=5)
        if process.returncode != 0:
            print('Flutter integration failed; inspect private log:', LOG, flush=True)
            return process.returncode
        if not all(events[phase].is_set() for phase in PHASES) or acted != {'expand','collapse','home','resume'}:
            raise RuntimeError('Flutter success did not include every real Android system phase')
        print('Actual Android lifecycle acceptance passed (focus interruption, 35s lease retention, hidden no-acquire and live stream)', flush=True)
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        reader.join(timeout=5)
        # Keep the shared isolated emulator in a visible state for later checks.
        try:
            adb('shell', 'cmd', 'statusbar', 'collapse')
        except subprocess.SubprocessError:
            pass


if __name__ == '__main__':
    if sys.argv[1:] == ['--process-death']:
        raise SystemExit(process_death_acceptance())
    if sys.argv[1:]:
        raise SystemExit('usage: run_platform_lifecycle.py [--process-death]')
    raise SystemExit(main())
