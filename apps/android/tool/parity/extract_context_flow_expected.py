#!/usr/bin/env python3
"""Extract the small geometry projection used by context_flow_test.dart.

Run from any directory. The full browser oracle can be supplied with --source;
by default it reads fixtures/mobile-parity/side-panel-matrix-expected.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CASE_IDS = (
    "650-context-light-scale1",
    "650-context-light-scale2",
)
LABELS = ("Context", "Saved snapshot", "System sections")


def extract(source_path: Path) -> dict[str, object]:
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    source_cases = {case["id"]: case for case in source["cases"]}
    cases: dict[str, object] = {}

    for case_id in CASE_IDS:
        case = source_cases[case_id]
        text_nodes = []
        for label in LABELS:
            node = next(
                node for node in case["textNodes"] if node["text"].startswith(label)
            )
            text_nodes.append({"label": label, "rectY": node["rect"]["y"]})
        cases[case_id] = {
            "activePanelRectY": case["activePanel"]["rect"]["y"],
            "textNodes": text_nodes,
        }

    return {
        "schemaVersion": 1,
        "source": {
            "file": source_path.name,
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
            "webRevision": source["webRevision"],
            "browserVersion": source["browser"]["version"],
        },
        "cases": cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "fixtures/mobile-parity/side-panel-matrix-expected.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "fixtures/mobile-parity/context-flow-expected.json",
    )
    args = parser.parse_args()
    output = extract(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
