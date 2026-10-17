#!/usr/bin/env python3
"""Build the pinned Skia text shaper asset without network access or npm."""
from pathlib import Path
import hashlib
import json

HERE = Path(__file__).resolve().parent
VENDOR = HERE / 'vendor/canvaskit-flutter-3.44.4'
ASSETS = HERE.parents[1] / 'assets'


def generate(output_dir=ASSETS):
    metadata = json.loads((VENDOR / 'provenance.json').read_text())
    def verified(path, key):
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != metadata[key]:
            raise ValueError('Canvas text dependency checksum mismatch: ' + str(path))
        return data
    source = verified(VENDOR / 'canvaskit.js', 'canvaskitJsSha256').decode()
    license_text = verified(VENDOR / 'LICENSE', 'licenseSha256')
    emscripten = (VENDOR / 'LICENSE.emscripten').read_bytes()
    if hashlib.sha256(emscripten).hexdigest() != metadata['emscriptenLicense']['sha256']:
        raise ValueError('Emscripten license checksum mismatch')
    license_text += b'\n\nEmscripten runtime support\n\n' + emscripten
    verified(ASSETS / 'document-canvas-text.wasm', 'wasmSha256')
    if source.count('import.meta.url') != 2 or source.count('export default CanvasKitInit;') != 1:
        raise ValueError('Unexpected CanvasKit module wrapper')
    source = source.replace('import.meta.url', '"https://native.invalid/canvaskit.js"').replace('export default CanvasKitInit;', '')
    helper = (HERE / 'document_canvas_text_source.js').read_text()
    bundle = '/* Generated from Flutter 3.44.4 CanvasKit; see document-canvas-text.LICENSE.txt. */\n(function(globalThis){\nconst console = globalThis.console || {log(){},error(){},warn(){}};\n' + source.rstrip() + '\n' + helper.rstrip() + '\n})(globalThis);\n'
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'document-canvas-text.js').write_text(bundle)
    (output_dir / 'document-canvas-text.LICENSE.txt').write_bytes(license_text)
    record = dict(metadata, helperSha256=hashlib.sha256(helper.encode()).hexdigest(), bundleSha256=hashlib.sha256(bundle.encode()).hexdigest())
    (output_dir / 'document-canvas-text.provenance.json').write_text(json.dumps(record, indent=2)+'\n')
    return record


if __name__ == '__main__':
    print(json.dumps(generate(), indent=2))
