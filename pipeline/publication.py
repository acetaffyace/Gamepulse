"""Immutable snapshot batches; index.json is the single atomic publication pointer."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from collectors.common import file_lock, load_yaml, now_iso, today_local, write_json


def compile_config(snapshots: dict, strict: bool = False) -> dict:
    from pipeline.build_dashboard_config import verify_lane, ADAPTER_SHAPES
    config = load_yaml("dashboard.yml")
    lanes = config.get("lanes") or []
    ids = [lane["id"] for lane in lanes]
    if not ids or len(ids) != len(set(ids)) or not snapshots:
        raise ValueError("Empty/duplicate lane IDs or no snapshots")
    for preset in config.get("presets", {}).values():
        if set(preset.get("lanes", [])) - set(ids):
            raise ValueError("Preset references an unknown lane")
    for lane in lanes:
        errors = {gid: verify_lane(lane, snap) for gid, snap in snapshots.items()}
        bad = {gid: value for gid, value in errors.items() if value}
        if bad and (strict or len(bad) == len(snapshots)):
            raise ValueError(f"Invalid lane {lane['id']}: {bad}")
    return {key: config.get(key) for key in (
        "palette", "share_ramp", "share_other", "important_video_types", "lanes", "presets"
    )} | {"adapters": sorted(ADAPTER_SHAPES)}


def load_published(data_dir: Path) -> tuple[dict, dict]:
    path = data_dir / "index.json"
    index = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"games": []}
    snapshots = {}
    for entry in index.get("games", []):
        filename = data_dir / entry.get("file", f"snapshot_{entry['game_id']}.json")
        if filename.exists():
            snapshots[entry["game_id"]] = json.loads(filename.read_text(encoding="utf-8"))
    return index, snapshots


def publish(data_dir: Path, entries: list[dict], snapshots: dict, config: dict) -> dict:
    """Caller holds publication lock through loading and merging previous snapshots."""
    batch_id = uuid.uuid4().hex
    folder = data_dir / "releases" / batch_id
    new_entries = []
    for entry in entries:
        gid = entry["game_id"]
        if gid not in snapshots:
            raise ValueError(f"Missing snapshot for {gid}")
        snapshot = {**snapshots[gid], "build_id": batch_id}
        # Serialization validates finite JSON before anything becomes visible.
        json.dumps(snapshot, allow_nan=False)
        name = f"snapshot_{gid}.json"
        write_json(folder / name, snapshot)
        new_entries.append({**entry, "file": f"releases/{batch_id}/{name}"})
    write_json(folder / "dashboard_config.json", {**config, "build_id": batch_id})
    manifest = {"schema_version": 2, "games": new_entries, "build_id": batch_id,
                "generated_at": today_local(), "published_at": now_iso(),
                "config_file": f"releases/{batch_id}/dashboard_config.json"}
    write_json(folder / "manifest.json", manifest)
    pointer = data_dir / "index.json"
    if pointer.exists():
        previous = json.loads(pointer.read_text(encoding="utf-8"))
        if not previous.get("config_file"):
            # Freeze a legacy publication before overwriting compatibility files.
            old_id = "legacy-" + uuid.uuid4().hex
            old_folder = data_dir / "releases" / old_id
            for entry in previous.get("games", []):
                old_file = data_dir / entry.get("file", f"snapshot_{entry['game_id']}.json")
                if not old_file.exists():
                    continue
                name = f"snapshot_{entry['game_id']}.json"
                old_snapshot = json.loads(old_file.read_text(encoding="utf-8"))
                write_json(old_folder / name, {**old_snapshot, "build_id": old_id})
                entry["file"] = f"releases/{old_id}/{name}"
            old_config = data_dir / "dashboard_config.json"
            if old_config.exists():
                write_json(old_folder / "dashboard_config.json", {**json.loads(old_config.read_text(encoding="utf-8")), "build_id": old_id})
                previous.update(build_id=old_id, config_file=f"releases/{old_id}/dashboard_config.json")
        write_json(data_dir / "index.previous.json", previous)
    write_json(pointer, manifest)
    # Compatibility files support existing analysis scripts; browsers use the batch.
    for gid, snapshot in snapshots.items():
        write_json(data_dir / f"snapshot_{gid}.json", {**snapshot, "build_id": batch_id})
    write_json(data_dir / "dashboard_config.json", {**config, "build_id": batch_id})
    return manifest
