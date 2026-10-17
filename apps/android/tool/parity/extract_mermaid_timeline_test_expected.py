#!/usr/bin/env python3
"""Extract the browser node/text geometry consumed by mermaid_timeline_node_test.dart.

Run from any directory. Pass --source if the full capture lives elsewhere.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
GEOMETRY_ID = "timeline-br-label-wrap-light"
TARGET_TSPAN = "A   long   event   label   that"


def extract(source_path: Path) -> dict[str, object]:
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    shared = source["geometryCatalog"][GEOMETRY_ID]["shared"]
    texts = shared["texts"]
    node = next(
        candidate
        for candidate in shared["timelineNodes"]
        if any(
            texts[index]["tag"] == "tspan"
            and texts[index]["text"] == TARGET_TSPAN
            for index in candidate["textIndices"]
        )
    )

    old_to_new: dict[int, int] = {}
    projected_texts = []
    for old_index in node["textIndices"]:
        if old_index in old_to_new:
            continue
        old_to_new[old_index] = len(projected_texts)
        text = texts[old_index]
        projected = {"tag": text["tag"], "text": text["text"]}
        if text["tag"] == "tspan":
            projected["computedTextLength"] = text["computedTextLength"]
            projected["bbox"] = {"y": text["bbox"]["y"]}
        projected_texts.append(projected)
    projected_node = {
        "textIndices": [old_to_new[index] for index in node["textIndices"]]
    }

    return {
        "fixture": source["fixture"],
        "reference": source["reference"],
        "mermaidVersion": source["mermaidVersion"],
        "source": {
            "file": source_path.name,
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
        },
        "geometryCatalog": {
            GEOMETRY_ID: {
                "shared": {
                    "texts": projected_texts,
                    "timelineNodes": [projected_node],
                }
            }
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "fixtures/mobile-parity/mermaid-timeline-expected.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "fixtures/mobile-parity/mermaid-timeline-test-expected.json",
    )
    args = parser.parse_args()
    result = extract(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
