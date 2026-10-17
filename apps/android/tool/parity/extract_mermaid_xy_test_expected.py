#!/usr/bin/env python3
"""Extract just the browser geometry consumed by mermaid_xy_geometry_test.dart.

Run from any directory. Pass --source if the full capture lives elsewhere.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CASE_IDS = (
    "xy-category-derived-y",
    "xy-category-labeled-series",
    "xy-numeric-explicit-negative",
    "xy-default-generated-x",
    "xy-horizontal-numeric-bars",
    "xy-horizontal-categorical",
    "xy-fixed-size-responsive",
)
WIDTHS = (390, 650, 768)


def _project_geometry(shared: dict[str, object]) -> dict[str, object]:
    shapes = []
    for shape in shared["shapes"]:
        if shape["tag"] == "rect" and "bar-plot-0" in shape["groupPath"]:
            attrs = shape["attrs"]
            shapes.append({
                "tag": shape["tag"],
                "groupPath": shape["groupPath"],
                "attrs": {key: attrs[key] for key in ("x", "y", "width", "height")},
            })
    texts = []
    for text in shared["texts"]:
        if "bar-plot-0" in text["groupPath"]:
            attrs = text["attrs"]
            texts.append({
                "tag": text["tag"],
                "groupPath": text["groupPath"],
                "text": text["text"],
                "attrs": {
                    key: attrs[key]
                    for key in ("x", "y", "font-size", "text-anchor")
                },
            })
    return {
        "attrs": {"viewBox": shared["attrs"]["viewBox"]},
        "shapes": shapes,
        "texts": texts,
    }


def extract(source_path: Path) -> dict[str, object]:
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    selected_widths = []
    geometry_ids: set[str] = set()
    for width in WIDTHS:
        width_row = next(
            row for row in source["themes"]["light"]["widths"]
            if row["width"] == width
        )
        scale_row = next(
            row for row in width_row["scales"]
            if float(row["textScale"]) == 1.0
        )
        selected_cases = []
        for case in scale_row["cases"]:
            if case["id"] not in CASE_IDS:
                continue
            svg = case["svg"]
            geometry_ids.add(svg["geometryId"])
            selected_cases.append({
                "id": case["id"],
                "svg": {
                    "geometryId": svg["geometryId"],
                    "box": {
                        "width": svg["box"]["width"],
                        "height": svg["box"]["height"],
                    },
                },
            })
        if {case["id"] for case in selected_cases} != set(CASE_IDS):
            raise ValueError(f"Expected all XY cases at width {width}")
        selected_widths.append({
            "width": width,
            "scales": [{
                "textScale": scale_row["textScale"],
                "cases": selected_cases,
            }],
        })

    catalog = {
        geometry_id: {
            "shared": _project_geometry(
                source["geometryCatalog"][geometry_id]["shared"]
            )
        }
        for geometry_id in sorted(geometry_ids)
    }
    metadata = {
        "file": source_path.name,
        "sha256": hashlib.sha256(source_bytes).hexdigest(),
    }
    for key in ("reference", "mermaidVersion", "browserVersion", "deviceScaleFactor"):
        if key in source:
            metadata[key] = source[key]
    return {
        "source": metadata,
        "themes": {"light": {"widths": selected_widths}},
        "geometryCatalog": catalog,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "fixtures/mobile-parity/mermaid-xy-expected.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "fixtures/mobile-parity/mermaid-xy-test-expected.json",
    )
    args = parser.parse_args()
    result = extract(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
