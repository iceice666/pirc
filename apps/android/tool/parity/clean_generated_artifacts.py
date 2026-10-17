"""Review/remove regenerable mobile build outputs after completed acceptance.

Keeps source, fixtures, every acceptance record, and the newest released APK.
Run only after Flutter/Gradle/emulator test commands have stopped.
"""
from pathlib import Path
import argparse
import json
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Delete the listed generated artifacts.')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[4]
    mobile = root / 'apps/android'
    assert (mobile / 'pubspec.yaml').is_file()
    candidates = [mobile / '.dart_tool/flutter_build', mobile / 'build/app', mobile / 'build/test_cache']
    apks = sorted((mobile / 'build/releases').glob('*/*.apk'), key=lambda p: p.stat().st_mtime, reverse=True)
    kept = apks[0] if apks else None
    candidates.extend(apks[1:])
    planned = []
    for target in candidates:
        if not target.exists():
            continue
        if target.is_symlink() or not target.resolve().is_relative_to(mobile.resolve()):
            raise RuntimeError(f'Refusing an unexpected generated path: {target}')
        relative = target.relative_to(root)
        tracked = subprocess.check_output(['git', 'ls-files', '--', str(relative)], cwd=root, text=True)
        if tracked.strip():
            raise RuntimeError(f'Refusing tracked files: {relative}')
        size = int(subprocess.check_output(['du', '-sk', str(target)], text=True).split()[0]) * 1024
        planned.append({'path': str(relative), 'bytes': size})
    for item in planned:
        if args.apply:
            target = root / item['path']
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
    print(json.dumps({
        'applied': args.apply,
        'estimated_gib': round(sum(item['bytes'] for item in planned) / 1024**3, 2),
        'kept_apk': str(kept.relative_to(root)) if kept else None,
        'generated_artifacts': planned,
    }, indent=2))


if __name__ == '__main__':
    main()
