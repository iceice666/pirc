#!/usr/bin/env python3
"""Run real QR decode and accept only the emulator's camera permission dialog.

Start an isolated emulator with the generated imagefile camera fixture first.
This driver replaces its installed app. It never supplies a decoded URI.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--flutter', default='flutter')
parser.add_argument('--adb', default='adb')
parser.add_argument('--log', type=Path, required=True)
parser.add_argument('--deny', action='store_true', help='Run the actual permission-denial UI test instead of decoding')
args = parser.parse_args()
if not args.device.startswith('emulator-'):
    parser.error('Use an isolated emulator; this integration run replaces its app.')
mobile = Path(__file__).resolve().parents[2]
args.log.parent.mkdir(parents=True, exist_ok=True)

def adb(*command):
    return subprocess.run([args.adb, '-s', args.device, *command],
                          check=True, text=True, capture_output=True, timeout=10).stdout

with args.log.open('w') as log:
    process = subprocess.Popen([
        args.flutter, 'test',
        'integration_test/bundled_scanner_permissions_test.dart' if args.deny else 'integration_test/android_scanner_decode_test.dart',
        '-d', args.device, '--dart-define=PIRC_SCANNER_DENIAL=true' if args.deny else '--dart-define=PIRC_SCANNER_DECODE=true',
    ], cwd=mobile, stdout=log, stderr=subprocess.STDOUT, env=os.environ.copy())
    deadline = time.monotonic() + 240
    approved = False
    try:
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise TimeoutError('Scanner acceptance exceeded 240 seconds')
            if not approved:
                activities = adb('shell', 'dumpsys', 'activity', 'activities')
                permission = any('topResumedActivity' in line and
                    'com.android.permissioncontroller' in line for line in activities.splitlines())
                if permission:
                    adb('shell', 'uiautomator', 'dump', '/sdcard/pirc-scanner-permission.xml')
                    xml = adb('shell', 'cat', '/sdcard/pirc-scanner-permission.xml')
                    tree = ET.fromstring(xml)
                    text = ' '.join(n.get('text', '') for n in tree.iter('node')).lower()
                    if not any(term in text for term in ('camera', '相機', 'allow pirc to take pictures and record video')):
                        raise RuntimeError('Refusing to approve a non-camera permission')
                    for node in tree.iter('node'):
                        suffix = 'permission_deny_button' if args.deny else 'permission_allow_foreground_only_button'
                        if node.get('resource-id', '').endswith(suffix):
                            bounds = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
                            if len(bounds) != 4:
                                raise RuntimeError('Unexpected permission button bounds')
                            adb('shell', 'input', 'tap', str((bounds[0]+bounds[2])//2),
                                str((bounds[1]+bounds[3])//2))
                            approved = True
                            print('Denied actual Android camera permission.' if args.deny else 'Accepted actual Android camera while-in-use prompt.', flush=True)
                            break
            time.sleep(1)
        code = process.wait()
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise
print(f'Scanner acceptance exit={code}; log={args.log}', flush=True)
raise SystemExit(code)
