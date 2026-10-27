#!/usr/bin/env python3
"""Compile the actual Kotlin first-send engine for explicit JVM/live-backend acceptance.
Uses only existing Gradle caches and Android SDK; no download or APK/Flutter build.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', type=Path, required=True, help='A new run-owned output directory')
parser.add_argument('--java', default=shutil.which('java'), help='Java 17+ executable')
parser.add_argument('--sdk', type=Path, default=os.environ.get('ANDROID_HOME'), help='Existing Android SDK directory')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
cache = Path(os.environ.get('GRADLE_USER_HOME', Path.home() / '.gradle')) / 'caches/modules-2/files-2.1'

def jar(group, artifact, version):
    candidates = list((cache / group / artifact / version).glob('*/*.jar'))
    if len(candidates) != 1:
        raise RuntimeError(f'Expected one cached {group}:{artifact}:{version}; run Android dependency resolution first')
    return str(candidates[0])

# Pinned to the repository's Gradle/Kotlin test dependencies; fail rather than
# silently selecting a different compiler/runtime or downloading tools.
kotlin = lambda artifact: jar('org.jetbrains.kotlin', artifact, '2.3.20')
compiler = [kotlin(a) for a in ['kotlin-compiler-embeddable', 'kotlin-stdlib', 'kotlin-script-runtime', 'kotlin-daemon-embeddable']]
compiler += [jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'), jar('org.jetbrains', 'annotations', '23.0.0'), jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0')]
cp = [kotlin('kotlin-stdlib'), jar('org.jetbrains', 'annotations', '23.0.0')]
for artifact, version in [('kotlinx-coroutines-core-jvm', '1.10.2'), ('kotlinx-serialization-core-jvm', '1.9.0'), ('kotlinx-serialization-json-jvm', '1.9.0')]:
    cp.append(jar('org.jetbrains.kotlinx', artifact, version))
for group, artifact, version in [('com.squareup.okhttp3', 'okhttp-jvm', '5.1.0'), ('com.squareup.okio', 'okio-jvm', '3.15.0')]:
    cp.append(jar(group, artifact, version))
sdk = args.sdk or Path.home() / ('Library/Android/sdk' if os.uname().sysname == 'Darwin' else 'Android/Sdk')
android = sdk / 'platforms/android-36/android.jar'
if not android.is_file() or not args.java:
    raise RuntimeError('Existing Android platform 36 and Java 17+ are required')
cp.append(str(android))
main = root / 'apps/android/android/app/src/main/kotlin'
test = root / 'apps/android/android/app/src/test/kotlin'
(out / 'BuildConfig.kt').write_text('package dev.pirc.pirc_mobile\nobject BuildConfig {const val DEBUG=true}\n')
source = (main / 'dev/pirc/pirc_mobile/GatewayRuntime.kt').read_text()
helpers = source[source.index('fun JsonElement?.wire()'):source.index('fun SessionState.wire()')]
helpers += source[source.index('fun requirePairingStamp('):source.index('/** Uses the existing Android authentication')]
(out / 'BridgeHelpers.kt').write_text('package dev.pirc.pirc_mobile\nimport dev.pirc.android.core.*\nimport kotlinx.serialization.json.*\n' + helpers)
sources = list((main / 'dev/pirc/android/core').rglob('*.kt'))
sources += [main / 'dev/pirc/android/BuildConfig.kt']
sources += [main / 'dev/pirc/pirc_mobile' / name for name in ['NativeFirstSend.kt', 'FirstSendReceipt.kt', 'NativeI18n.kt']]
sources += [out / 'BuildConfig.kt', out / 'BridgeHelpers.kt', test / 'dev/pirc/pirc_mobile/NativeFirstSendLive.kt']
classes = out / 'classes'
classes.mkdir()
subprocess.run([args.java, '-Xmx1536m', '-cp', os.pathsep.join(compiler), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-Werror', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-Xplugin=' + kotlin('kotlin-serialization-compiler-plugin-embeddable'), '-classpath', os.pathsep.join(cp), '-d', str(classes), *map(str, sources)], check=True)
manifest = out / 'runtime.json'
manifest.write_text(json.dumps({'java': args.java, 'classpath': os.pathsep.join([str(classes), *cp])}))
print(manifest)
