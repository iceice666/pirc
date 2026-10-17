#!/usr/bin/env python3
"""Write synthetic renderer fixtures for Android integration acceptance."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
fixtures = root / "fixtures/mobile-parity"
def cases(name):
    return json.loads((fixtures / name).read_text())["cases"]
content = {
    "kanban": next(c["source"] for c in cases("mermaid-kanban.json")
                   if c["id"] == "multiline-description"),
    "sankey": cases("mermaid-sankey.json")[0]["source"],
    "block": cases("mermaid-block-beta-reference.json")[2]["source"],
    "animations": cases("animated-images.json"),
}
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.open("w") as output:
    os.chmod(args.output, 0o600)
    json.dump({"PIRC_NATIVE_CONTENT_ACCEPTANCE": True,
               "PIRC_NATIVE_CONTENT_FIXTURES": json.dumps(content)}, output)
print(f"Synthetic fixtures written to {args.output}")
