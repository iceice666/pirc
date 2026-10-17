#!/usr/bin/env python3
"""Delete only the synthetic chat announced by the isolated Android test.
Uses the isolated helper's browser identity; never injects a Flutter event.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device',required=True)
parser.add_argument('--flutter',default='flutter')
parser.add_argument('--log',type=Path,required=True)
args=parser.parse_args()
if not args.device.startswith('emulator-'):
    parser.error('Use an isolated emulator; integration runs replace its app.')
origin='http://127.0.0.1:18894'
mobile=Path(__file__).resolve().parents[2]
with args.log.open('w') as log:
    os.chmod(args.log,0o600)
    process=subprocess.Popen([args.flutter,'test','integration_test/remote_session_deletion_test.dart',
        '-d',args.device,'--dart-define-from-file=../../.pirc/flutter-parity-integration/defines.json'],
        cwd=mobile,stdout=log,stderr=subprocess.STDOUT,env=os.environ.copy())
    deleted=False
    deadline=time.monotonic()+360
    try:
        while process.poll() is None:
            if time.monotonic()>deadline: raise TimeoutError('Remote deletion acceptance exceeded 360s')
            match=re.search(r'REMOTE_DELETE:ready:([A-Za-z0-9_-]+)',args.log.read_text())
            if match and not deleted:
                session=match.group(1)
                path=origin+'/api/sessions/'+session
                with urllib.request.urlopen(path+'/snapshot',timeout=15) as response:
                    snapshot=json.load(response)
                if snapshot.get('session',{}).get('name')!='Remote deletion acceptance':
                    raise RuntimeError('Refusing deletion: synthetic fixture identity mismatch')
                request=urllib.request.Request(path,method='DELETE',headers={'Origin':origin})
                with urllib.request.urlopen(request,timeout=20) as response:
                    if response.status!=204: raise RuntimeError('Unexpected DELETE response')
                deleted=True
            time.sleep(.2)
        if process.wait() or not deleted: raise RuntimeError('Remote deletion acceptance failed; inspect log')
        print('Accepted: independent browser DELETE -> actual WebSocket -> native event -> App workspace; draft cleared; no 404/error.')
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
