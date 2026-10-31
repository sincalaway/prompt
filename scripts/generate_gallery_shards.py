#!/usr/bin/env python3
"""Split the gallery source into lazily loaded static JSON shards.

Run from any directory with:
  python3 scripts/generate_gallery_shards.py
  python3 scripts/generate_gallery_shards.py --verify

The source file remains outside the Cloudflare Pages root so it is not shipped
as a duplicate 21 MB monolithic asset.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "gallery-source.json"
DATA_DIR = ROOT / "paired-image-prompt-gallery" / "data"
SHARDS_DIR = DATA_DIR / "shards"
SHARD_SIZE = 250


def record_categories(record: dict) -> list[str]:
    # Match JavaScript's `item.categories || [item.category]`: an empty array
    # is truthy in JS and therefore stays empty.
    categories = record.get("categories")
    if categories is None:
        category = record.get("category")
        return [category] if category else ["未分类"]
    return categories


def read_source() -> list[dict]:
    if not SOURCE.is_file():
        raise SystemExit(f"Source data not found: {SOURCE}")
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("gallery-source.json must contain a JSON array")
    return data


def expected_manifest(records: list[dict]) -> dict:
    shards = []
    category_shards: dict[str, list[str]] = defaultdict(list)
    category_counts: dict[str, int] = defaultdict(int)
    for start in range(0, len(records), SHARD_SIZE):
        chunk = records[start : start + SHARD_SIZE]
        shard_id = f"{start // SHARD_SIZE:03d}"
        shards.append(
            {
                "id": shard_id,
                "file": f"shards/shard-{shard_id}.json",
                "start": start,
                "count": len(chunk),
            }
        )
        for record in chunk:
            for category in set(record_categories(record)):
                if not category:
                    continue
                if not category_shards[category] or category_shards[category][-1] != shard_id:
                    category_shards[category].append(shard_id)
                category_counts[category] += 1

    categories = sorted(category_counts, key=lambda value: value)
    return {
        "version": 1,
        "recordCount": len(records),
        "shardSize": SHARD_SIZE,
        "shards": shards,
        "categories": categories,
        "categoryCounts": dict(sorted(category_counts.items())),
        "categoryShards": dict(
            sorted(category_shards.items(), key=lambda item: item[0])
        ),
    }


def verify(records: list[dict], manifest: dict) -> None:
    if manifest.get("recordCount") != len(records):
        raise SystemExit("Verification failed: record count differs")
    rebuilt_manifest = expected_manifest(records)
    for key in ("shards", "categories", "categoryCounts", "categoryShards"):
        if manifest.get(key) != rebuilt_manifest[key]:
            raise SystemExit(f"Verification failed: {key} differs from source")

    reconstructed = []
    for shard in manifest["shards"]:
        path = DATA_DIR / shard["file"]
        if not path.is_file():
            raise SystemExit(f"Verification failed: missing {path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        if len(data) != shard["count"]:
            raise SystemExit(f"Verification failed: wrong size in {path}")
        reconstructed.extend(data)
    if reconstructed != records:
        raise SystemExit("Verification failed: sharded records/order differ from source")
    print(
        f"Verified {len(records):,} records in {len(manifest['shards'])} shards; "
        f"{len(manifest['categories'])} categories; field values and order unchanged."
    )


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def build(records: list[dict]) -> dict:
    manifest = expected_manifest(records)
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    active_files = set()
    for shard in manifest["shards"]:
        path = DATA_DIR / shard["file"]
        active_files.add(path.resolve())
        start = shard["start"]
        write_json(path, records[start : start + shard["count"]])

    for stale in SHARDS_DIR.glob("shard-*.json"):
        if stale.resolve() not in active_files:
            stale.unlink()
    write_json(DATA_DIR / "manifest.json", manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="verify built shards without writing")
    args = parser.parse_args()

    records = read_source()
    if args.verify:
        manifest_path = DATA_DIR / "manifest.json"
        if not manifest_path.is_file():
            raise SystemExit(f"Manifest not found: {manifest_path}")
        verify(records, json.loads(manifest_path.read_text(encoding="utf-8")))
    else:
        manifest = build(records)
        verify(records, manifest)
        print(
            f"Built {len(manifest['shards'])} shards ({SHARD_SIZE} records max each) "
            f"at {DATA_DIR.relative_to(ROOT)}."
        )


if __name__ == "__main__":
    main()
