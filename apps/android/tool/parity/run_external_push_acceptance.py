#!/usr/bin/env python3
"""Drive real ntfy registration, Android background and an external notification tap.

Requires an isolated emulator, configured official ntfy app, local ntfy server
on 18920, real_gateway.ts and private defines. Never injects a push callback.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device',required=True)
parser.add_argument('--flutter',default='flutter')
parser.add_argument('--adb',default='adb')
parser.add_argument('--log',type=Path,required=True)
parser.add_argument('--races',action='store_true',help='Run delayed-response/invalid-key registration cases')
parser.add_argument('--relay-host',choices=['127.0.0.1:18920','ntfy.sh'],default='127.0.0.1:18920')
args=parser.parse_args()
if not args.device.startswith('emulator-'):
    parser.error('Use an isolated emulator; integration runs replace its installed app.')
mobile=Path(__file__).resolve().parents[2]
package='dev.pirc.mobile.preview'

def adb(*command):
    return subprocess.run([args.adb,'-s',args.device,*command],capture_output=True,
                          text=True,check=True,timeout=12).stdout

def ui():
    adb('shell','uiautomator','dump','/sdcard/pirc-external-push.xml')
    return ET.fromstring(adb('shell','cat','/sdcard/pirc-external-push.xml'))

def click(node):
    box=list(map(int,re.findall(r'\d+',node.get('bounds',''))))
    if len(box)!=4: raise RuntimeError('Unexpected Android node bounds')
    adb('shell','input','tap',str((box[0]+box[2])//2),str((box[1]+box[3])//2))

adb('shell','cmd','statusbar','collapse')
args.log.parent.mkdir(parents=True,exist_ok=True)
with args.log.open('w') as log:
    os.chmod(args.log,0o600)
    process=subprocess.Popen([args.flutter,'test',
        'integration_test/push_registration_races_test.dart' if args.races else 'integration_test/external_push_test.dart',
        '-d',args.device,'--dart-define=PIRC_EXTERNAL_PUSH=true',
        '--dart-define=PIRC_PUSH_RELAY_HOST='+args.relay_host,
        '--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json'],
        cwd=mobile,stdout=log,stderr=subprocess.STDOUT,env=os.environ.copy())
    deadline=time.monotonic()+420
    permission=False
    background=False
    shade=False
    clicked=False
    try:
        while process.poll() is None:
            if time.monotonic()>deadline: raise TimeoutError('External push acceptance exceeded 420s')
            text=args.log.read_text()
            if 'Some tests failed.' in text or 'All tests passed!' in text:
                time.sleep(0.5)
                continue
            if not permission and 'PUSH_EXTERNAL:notification-permission-next' in text:
                activity=adb('shell','dumpsys','activity','activities')
                if any('topResumedActivity' in line and 'com.android.permissioncontroller' in line for line in activity.splitlines()):
                    tree=ui()
                    messages=[n.get('text','').lower() for n in tree.iter('node')
                              if n.get('resource-id','').endswith('permission_message')]
                    if not messages:
                        time.sleep(0.5)
                        continue
                    if not any('allow pirc to send you notifications' in s for s in messages):
                        raise RuntimeError('Unexpected permission prompt; refusing approval')
                    button=next((n for n in tree.iter('node') if n.get('resource-id','').endswith('permission_allow_button')),None)
                    if button is not None:
                        click(button);permission=True
                        print('Accepted actual pirc notification permission.',flush=True)
            if 'PUSH_EXTERNAL:register-next' in text and 'PUSH_EXTERNAL:registered-real-endpoint' not in text:
                activity=adb('shell','dumpsys','activity','activities')
                if any('topResumedActivity' in line and 'io.heckel.ntfy/' in line for line in activity.splitlines()):
                    adb('shell','am','start','-a','android.intent.action.MAIN',
                        '-c','android.intent.category.LAUNCHER','-n',package+'/dev.pirc.pirc_mobile.MainActivity')
                    print('Returned from distributor UI to the real app task.',flush=True)
            if not background and 'PUSH_EXTERNAL:home-next' in text:
                adb('shell','input','keyevent','KEYCODE_HOME');background=True
                print('Sent actual Android Home.',flush=True)
            if not clicked and 'PUSH_EXTERNAL:notification-tap-next' in text:
                if not shade:
                    adb('shell','cmd','statusbar','expand-notifications');shade=True
                tree=ui()
                title='pirc notifications work'
                item=next((n for n in tree.iter('node') if n.get('text')==title),None)
                if item is not None:
                    click(item);clicked=True
                    print('Tapped actual external-push OS notification.',flush=True)
            time.sleep(0.5)
        code=process.wait()
    except BaseException:
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill();process.wait()
        raise
print(f'External push exit={code}; log={args.log}',flush=True)
raise SystemExit(code)
