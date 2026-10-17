"""Extract pinned DOMPurify's declarative tag/attribute inventory, not its runtime.
The native DOM parser and URL checks are tested separately against Chromium.
"""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[4]
source = (root / 'apps/web/node_modules/dompurify/dist/purify.es.mjs').read_text()
assert 'DOMPurify 3.4.16' in source

def names(name):
    pattern = r'const ' + re.escape(name) + r' = (?:freeze|addToSet)\((?:\{\}, )?(\[[\s\S]*?\])\);'
    match = re.search(pattern, source)
    assert match, name
    return json.loads(match[1])

sets = {
    'nativeHtmlTags': sorted(set(sum((names(n) for n in ['html$1', 'svg$1', 'svgFilters', 'mathMl$1']), []) + ['semantics', 'annotation'])),
    'nativeHtmlAttributes': sorted(set(sum((names(n) for n in ['html', 'svg', 'mathMl', 'xml']), []) + ['target', 'data-copy', 'data-file-link'])),
    'nativeHtmlForbiddenContents': names('DEFAULT_FORBID_CONTENTS'),
    'nativeHtmlDataTags': names('DEFAULT_DATA_URI_TAGS'),
    'nativeHtmlUriSafeAttributes': names('DEFAULT_URI_SAFE_ATTRIBUTES'),
}
text = '// Generated from pinned DOMPurify 3.4.16 tag/attribute inventories.\n// DOMPurify (c) Cure53 contributors, Apache-2.0 OR MPL-2.0.\n// This is a native rendering policy, not a port of DOMPurify.\n'
for name, values in sets.items():
    text += f'const {name} = <String>{{\n' + ''.join(f'  {json.dumps(v.lower())},\n' for v in values) + '};\n'
path = root / 'apps/android/lib/rendering/html_policy.dart'
if '--check' in sys.argv:
    assert path.read_text() == text, 'Run sync_html_policy.py'
else:
    path.write_text(text)
