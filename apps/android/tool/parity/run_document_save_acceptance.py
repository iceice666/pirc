#!/usr/bin/env python3
"""Drive real DocumentsUI save/cancel on an isolated Android emulator.
Requires real_gateway.ts --documents and its private defines. No file callbacks
are injected; the saved file is read through adb and checked byte for byte.
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
args = parser.parse_args()
if not args.device.startswith('emulator-'):
    parser.error('Use an isolated emulator; integration tests replace its app.')
mobile = Path(__file__).resolve().parents[2]
filename = 'pirc-save-acceptance.bin'
destination = '/sdcard/Download/' + filename

def adb(*command, binary=False):
    result = subprocess.run([args.adb, '-s', args.device, *command],
        capture_output=True, check=True, timeout=15)
    return result.stdout if binary else result.stdout.decode().strip()

def tree():
    adb('shell', 'uiautomator', 'dump', '/sdcard/pirc-document-save-ui.xml')
    return ET.fromstring(adb('shell', 'cat', '/sdcard/pirc-document-save-ui.xml'))

def tap(node):
    box = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
    if len(box) != 4: raise RuntimeError('Missing node bounds')
    adb('shell', 'input', 'tap', str((box[0]+box[2])//2), str((box[1]+box[3])//2))

# Never overwrite a pre-existing file, even in the isolated test emulator.
exists = subprocess.run([args.adb, '-s', args.device, 'shell', 'test', '-e', destination]).returncode == 0
if exists: raise RuntimeError('Acceptance file already exists; refusing overwrite')
saved = False
cancelled = False
verified = False
with args.log.open('w') as log:
    os.chmod(args.log, 0o600)
    process = subprocess.Popen([args.flutter, 'test',
        'integration_test/document_save_test.dart', '-d', args.device,
        '--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json'],
        cwd=mobile, stdout=log, stderr=subprocess.STDOUT, env=os.environ.copy())
    deadline = time.monotonic() + 420
    try:
        while process.poll() is None:
            if time.monotonic() > deadline: raise TimeoutError('Document save test exceeded 420s')
            text = args.log.read_text()
            if 'DOCUMENT_SAVE:save-next' not in text:
                time.sleep(.5); continue
            activity = adb('shell', 'dumpsys', 'activity', 'activities')
            in_picker = any('topResumedActivity' in line and 'documentsui' in line for line in activity.splitlines())
            if not in_picker:
                time.sleep(.4); continue
            if not saved:
                ui = tree()
                title = next((n for n in ui.iter('node') if n.get('resource-id', '').endswith('/title') and n.get('class') == 'android.widget.EditText'), None)
                if title is None or title.get('text') != filename:
                    raise RuntimeError('Save picker has unexpected filename')
                # Route explicitly to Downloads using the navigation drawer.
                drawer = next((n for n in ui.iter('node') if n.get('content-desc') == 'Show roots'), None)
                if drawer is not None:
                    tap(drawer)
                    ui = tree()
                    downloads = next((n for n in ui.iter('node') if n.get('text') == 'Downloads'), None)
                    if downloads is None: raise RuntimeError('Downloads destination missing')
                    tap(downloads)
                    ui = tree()
                button = next((n for n in ui.iter('node') if n.get('resource-id', '').endswith('/button1') and n.get('text', '').upper() == 'SAVE'), None)
                if button is None: raise RuntimeError('System Save action missing')
                tap(button); saved = True
            elif 'DOCUMENT_SAVE:cancel-next' in text and not cancelled:
                adb('shell', 'input', 'keyevent', '4'); cancelled = True
            time.sleep(.3)
        code = process.wait()
        if code or not saved or not cancelled: raise RuntimeError('Document save acceptance failed; inspect log')
        actual = adb('exec-out', 'cat', destination, binary=True)
        if actual != bytes([0,127,128,255,13,10,65]): raise RuntimeError('Saved document bytes differ')
        verified = True
        print('Accepted: real DocumentsUI save/cancel; exact 7-byte file; source edit/history preserved; one POST.')
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        if verified: adb('shell', 'rm', destination)
