"""Compare the captured settings-button states. Requires Pillow.

Run after capture_settings_buttons_web.mjs and capture_settings_buttons_test.dart.
Reports differences; a successful run does not imply full visual parity.
"""
import json
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[2] / 'build/parity/settings-buttons'
web = json.loads((root / 'web.json').read_text())
native = json.loads((root / 'native.json').read_text())
assert set(web) == set(native) and len(web) == 24
samples = {'page': (0, 0), 'fill': (32, 42), 'focus': (21, 42)}
results = {}
for name, reference in web.items():
    actual = native[name]
    with Image.open(root / f'web-{name}.png') as source:
        reference_image = source.convert('RGB')
    with Image.open(root / f'native-{name}.png') as source:
        actual_image = source.convert('RGB')
    assert reference_image.size == actual_image.size == (390, 140)
    results[name] = {
        'geometryDelta': {key: actual[key] - reference[key]
                          for key in ('x', 'y', 'width', 'height')},
        'focusMatches': reference['focusVisible'] == actual['focusVisible'],
        'samples': {key: {'web': reference_image.getpixel(point),
                          'native': actual_image.getpixel(point)}
                    for key, point in samples.items()},
    }
(root / 'comparison.json').write_text(json.dumps(results, indent=2) + '\n')
mismatches = sum(value['web'] != value['native']
                 for state in results.values() for value in state['samples'].values())
print(f'{len(results)} state pairs; {mismatches}/72 sampled color pairs differ. See comparison.json.')
