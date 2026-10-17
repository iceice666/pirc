#!/usr/bin/env python3
"""Generate Flutter's color contract from the frozen, accepted web revision.

Usage: python3 tool/parity/sync_web_tokens.py [--check]
No manually adjusted web colors: compatibility aliases preserve existing clients.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

BASE = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c'
APP = Path(__file__).resolve().parents[2]
REPO = APP.parents[1]

def source(path):
    return subprocess.check_output(['git', 'show', f'{BASE}:{path}'], cwd=REPO, text=True)

def colors(css):
    result = []
    for block in re.findall(r':root\s*\{([^}]+)\}', css):
        values = {}
        for key, value in re.findall(r'--([\w-]+):\s*([^;]+);', block):
            value = value.strip()
            if value.startswith('#'):
                values[key] = value
            elif value.startswith('rgb('):
                channels = re.fullmatch(r'rgb\((\d+) (\d+) (\d+)(?: / (\d+)%)?\)', value)
                if channels:
                    r, g, b, a = channels.groups()
                    values[key] = f'rgba({r},{g},{b},{int(a)/100:g})' if a else f'#{int(r):02x}{int(g):02x}{int(b):02x}'
        result.append(values)
    return result

aliases = {
    'surface.page': 'bg', 'surface.sidebar': 'bg-sidebar', 'surface.layer': 'bg-layer',
    'surface.subtle': 'bg-subtle', 'surface.grouped': 'bg-sidebar',
    'surface.bubble': 'bubble', 'surface.input': 'input',
    'fill.hover': 'bg-hover', 'fill.hoverStrong': 'bg-hover-strong', 'fill.active': 'bg-active',
    'text.primary': 'ink', 'text.secondary': 'text-2', 'text.muted': 'muted', 'text.faint': 'faint',
    'line.hairline': 'line', 'line.default': 'line-dark', 'line.strong': 'line-strong',
    'accent.default': 'accent', 'accent.pressed': 'accent-hover', 'accent.soft': 'accent-soft',
    'accent.onSoft': 'accent-ink', 'accent.on': 'on-accent',
    'status.success': 'success', 'text.success': 'success',
    'status.warning': 'warning', 'text.warning': 'warning', 'status.warningSoft': 'warning-soft',
    'status.danger': 'danger', 'status.dangerSoft': 'danger-soft',
    'code.bg': 'code-bg', 'code.text': 'code-ink', 'code.head': 'code-head',
    'action.primary': 'accent', 'action.onPrimary': 'on-accent',
}
css = source('apps/web/src/app.css')
markdown = source('apps/web/src/markdown.css')
light, dark_overrides = colors(css)
hl_light, hl_dark = colors(markdown)
light.update(hl_light)
dark = {**light, **dark_overrides, **hl_dark}
path = APP / 'assets/design-tokens.json'
tokens = json.loads(path.read_text())
tokens['$meta'] = {
    'name': 'pirc web parity', 'version': '1.0.0', 'webRevision': BASE,
    'source': ['apps/web/src/app.css', 'apps/web/src/markdown.css'],
    'sourceSha256': hashlib.sha256((css + markdown).encode()).hexdigest(),
    'generator': 'tool/parity/sync_web_tokens.py',
    'usage': 'Generated web colors. Native-only scrim/terminal tokens are explicitly separate. Do not hand-edit web colors.',
}
for name, values in [('light', light), ('dark', dark)]:
    tokens['color'][name] = {
        **{key: values[value] for key, value in aliases.items()},
        **{f'web.{key}': value for key, value in values.items()},
        'scrim': 'rgba(0,0,0,0.32)' if name == 'light' else 'rgba(0,0,0,0.5)',
    }
tokens['layout'] = {
    'source': 'apps/web/src/App.svelte',
    'mobileMax': 650, 'panelOverlayMax': 860,
    'sidebarWidth': 264, 'narrowSidebarWidth': 232, 'panelMin': 280, 'panelDefault': 360, 'conversationMin': 380,
}
tokens['typography']['family.ui'] = ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang TC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft JhengHei', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif']
tokens['typography']['family.mono'] = ['SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace']
# Removed design-C sizing guidance; component dimensions come from their web source.
for key in ['spacing', 'elevation', 'size']:
    tokens.pop(key, None)
output = json.dumps(tokens, ensure_ascii=False, indent=2) + '\n'
if '--check' in sys.argv:
    if path.read_text() != output:
        sys.exit('Web token drift: run python3 tool/parity/sync_web_tokens.py')
    print(f'Web colors match {BASE}')
else:
    path.write_text(output)
    print(f'Wrote {path}')
