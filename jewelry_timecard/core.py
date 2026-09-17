"""Storage and time-allocation logic for the jewelry time card.

Everything is kept as plain JSON on disk so the data is easy to inspect,
back up, and hand to other tools:

    <data dir>/
        items/<item-id>.json      one file per piece (or batch of pieces)
        sessions/<session>.json   one file per completed clock-in/clock-out
        current_session.json      present only while clocked in
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

APP_NAME = "JewelryTimeCard"
SCHEMA_VERSION = 1

NOT_STARTED = "not_started"
IN_PROGRESS = "in_progress"
FINISHED = "finished"
STATUS_LABELS = {NOT_STARTED: "Getting started", IN_PROGRESS: "In progress", FINISHED: "Finished"}

PERCENT_TOLERANCE = 0.01


class TimeCardError(Exception):
    """A user-facing problem (bad input, wrong state)."""


def default_data_dir() -> Path:
    override = os.environ.get("JTC_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / APP_NAME


def now() -> datetime:
    return datetime.now().astimezone()


def to_iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def from_iso(text: str) -> datetime:
    return datetime.fromisoformat(text)


def format_duration(seconds: float) -> str:
    minutes = int(round(seconds / 60))
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes:02d}m"


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:40] or "piece"


def _new_id(name: str) -> str:
    return f"{_slug(name)}-{uuid.uuid4().hex[:8]}"


def _write_json(path: Path, data: dict) -> None:
    # Write to a temp file then rename so a crash never leaves half a file.
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def _read_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _refresh_totals(item: dict) -> None:
    total = sum(entry["seconds"] for entry in item["time_entries"])
    item["total_seconds"] = round(total, 1)
    item["seconds_per_piece"] = round(total / item["quantity"], 1) if item["quantity"] else 0.0


class TimeCard:
    def __init__(self, data_dir: Path | str | None = None):
        self.data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.items_dir = self.data_dir / "items"
        self.sessions_dir = self.data_dir / "sessions"
        self.session_file = self.data_dir / "current_session.json"
        self.items_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    # ----- items -------------------------------------------------------

    def _item_path(self, item_id: str) -> Path:
        return self.items_dir / f"{item_id}.json"

    def save_item(self, item: dict) -> None:
        _refresh_totals(item)
        _write_json(self._item_path(item["id"]), item)

    def get_item(self, item_id: str) -> dict:
        path = self._item_path(item_id)
        if not path.exists():
            raise TimeCardError(f"No piece with id {item_id}")
        return _read_json(path)

    def list_items(self, include_finished: bool = True) -> list[dict]:
        items = [_read_json(p) for p in self.items_dir.glob("*.json")]
        if not include_finished:
            items = [i for i in items if i["status"] != FINISHED]
        items.sort(key=lambda i: (i["status"] == FINISHED, i["name"].lower(), i.get("sequence", 0)))
        return items

    def add_item(self, name: str, quantity: int = 1, sku: str = "", notes: str = "",
                 separate: bool = False) -> list[dict]:
        """Add a piece. With quantity > 1 either one shared batch is created,
        or (separate=True) that many individual pieces with the same name."""
        name = name.strip()
        if not name:
            raise TimeCardError("A piece needs a name.")
        if quantity < 1:
            raise TimeCardError("Quantity must be at least 1.")
        counts = [1] * quantity if separate else [quantity]
        # A running number keeps same-named pieces in the order they were added.
        sequence = max((i.get("sequence", 0) for i in self.list_items()), default=0)
        created = []
        for count in counts:
            sequence += 1
            item = {
                "schema_version": SCHEMA_VERSION,
                "id": _new_id(name),
                "sequence": sequence,
                "name": name,
                "sku": sku.strip(),
                "quantity": count,
                "status": NOT_STARTED,
                "notes": notes.strip(),
                "created_at": to_iso(now()),
                "started_at": None,
                "finished_at": None,
                "split_from": None,
                "time_entries": [],
            }
            self.save_item(item)
            created.append(item)
        return created

    def update_item(self, item_id: str, *, name: str | None = None, sku: str | None = None,
                    notes: str | None = None) -> dict:
        item = self.get_item(item_id)
        if name is not None:
            if not name.strip():
                raise TimeCardError("A piece needs a name.")
            item["name"] = name.strip()
        if sku is not None:
            item["sku"] = sku.strip()
        if notes is not None:
            item["notes"] = notes.strip()
        self.save_item(item)
        return item

    def delete_item(self, item_id: str) -> None:
        self._item_path(item_id).unlink(missing_ok=True)

    def finish_items(self, item_ids: list[str], when: datetime | None = None) -> None:
        stamp = to_iso(when or now())
        for item_id in item_ids:
            item = self.get_item(item_id)
            if item["status"] != FINISHED:
                item["status"] = FINISHED
                item["finished_at"] = stamp
                self.save_item(item)

    def finish_part_of_batch(self, item_id: str, count: int, when: datetime | None = None) -> dict:
        """Mark `count` pieces of a batch finished. They are split into their own
        finished item carrying their share of the time logged so far."""
        item = self.get_item(item_id)
        if item["status"] == FINISHED:
            raise TimeCardError("That batch is already finished.")
        if count < 1 or count > item["quantity"]:
            raise TimeCardError(f"Choose between 1 and {item['quantity']} pieces.")
        if count == item["quantity"]:
            self.finish_items([item_id], when)
            return self.get_item(item_id)

        share = count / item["quantity"]
        finished = dict(item)
        finished["id"] = _new_id(item["name"])
        finished["quantity"] = count
        finished["status"] = FINISHED
        finished["finished_at"] = to_iso(when or now())
        finished["split_from"] = item["id"]
        finished["time_entries"] = [
            {**e, "seconds": round(e["seconds"] * share, 1)} for e in item["time_entries"]
        ]
        item["quantity"] -= count
        item["time_entries"] = [
            {**e, "seconds": round(e["seconds"] * (1 - share), 1)} for e in item["time_entries"]
        ]
        self.save_item(finished)
        self.save_item(item)
        return finished

    def reopen_item(self, item_id: str) -> None:
        item = self.get_item(item_id)
        item["status"] = IN_PROGRESS if item["time_entries"] else NOT_STARTED
        item["finished_at"] = None
        self.save_item(item)

    # ----- clocking in and out ----------------------------------------

    def current_session(self) -> dict | None:
        if self.session_file.exists():
            return _read_json(self.session_file)
        return None

    def clock_in(self, when: datetime | None = None) -> dict:
        if self.current_session():
            raise TimeCardError("You are already clocked in.")
        session = {"id": uuid.uuid4().hex[:12], "clock_in": to_iso(when or now())}
        _write_json(self.session_file, session)
        return session

    def clock_out_candidates(self) -> list[dict]:
        """Pieces time can be assigned to: everything still open, plus anything
        finished during this session."""
        session = self.current_session()
        if not session:
            return []
        start = from_iso(session["clock_in"])
        return [
            i for i in self.list_items()
            if i["status"] != FINISHED or from_iso(i["finished_at"]) >= start
        ]

    def cancel_clock_in(self) -> None:
        self.session_file.unlink(missing_ok=True)

    def clock_out(self, allocations: dict[str, float], when: datetime | None = None) -> dict:
        """Close the session, splitting its length across pieces.

        `allocations` maps item id -> percent of the session. Percentages must
        add up to 100 unless there is nothing to assign time to.
        """
        session = self.current_session()
        if not session:
            raise TimeCardError("You are not clocked in.")
        start = from_iso(session["clock_in"])
        end = when or now()
        if end <= start:
            raise TimeCardError("Clock-out time must be after clock-in time.")

        allocations = {k: float(v) for k, v in allocations.items() if float(v) != 0}
        if any(v < 0 for v in allocations.values()):
            raise TimeCardError("Percentages can't be negative.")
        total_pct = sum(allocations.values())
        if allocations or self.clock_out_candidates():
            if abs(total_pct - 100) > PERCENT_TOLERANCE:
                raise TimeCardError(f"Percentages add up to {total_pct:g}%, they need to total 100%.")

        items = {item_id: self.get_item(item_id) for item_id in allocations}
        duration = (end - start).total_seconds()
        for item_id, pct in allocations.items():
            item = items[item_id]
            item["time_entries"].append({
                "session_id": session["id"],
                "clock_in": session["clock_in"],
                "clock_out": to_iso(end),
                "percent": round(pct, 2),
                "seconds": round(duration * pct / 100, 1),
            })
            if item["status"] == NOT_STARTED:
                item["status"] = IN_PROGRESS
            if not item["started_at"]:
                item["started_at"] = session["clock_in"]
            self.save_item(item)

        record = {
            **session,
            "clock_out": to_iso(end),
            "seconds": round(duration, 1),
            "allocations": [
                {"item_id": i, "name": items[i]["name"], "quantity": items[i]["quantity"],
                 "percent": round(p, 2)}
                for i, p in allocations.items()
            ],
        }
        _write_json(self.sessions_dir / f"{start.strftime('%Y%m%d-%H%M%S')}-{session['id']}.json", record)
        self.session_file.unlink()
        return record

    # ----- export ------------------------------------------------------

    CSV_FIELDS = [
        "item_id", "name", "sku", "quantity", "status", "created_at", "started_at",
        "finished_at", "total_hours", "total_minutes", "minutes_per_piece",
        "work_sessions", "notes",
    ]

    def export_csv(self, path: Path | str, items: list[dict] | None = None) -> int:
        items = self.list_items() if items is None else items
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=self.CSV_FIELDS)
            writer.writeheader()
            for item in items:
                writer.writerow({
                    "item_id": item["id"],
                    "name": item["name"],
                    "sku": item["sku"],
                    "quantity": item["quantity"],
                    "status": item["status"],
                    "created_at": item["created_at"],
                    "started_at": item["started_at"] or "",
                    "finished_at": item["finished_at"] or "",
                    "total_hours": round(item["total_seconds"] / 3600, 2),
                    "total_minutes": round(item["total_seconds"] / 60, 1),
                    "minutes_per_piece": round(item["seconds_per_piece"] / 60, 1),
                    "work_sessions": len({e["session_id"] for e in item["time_entries"]}),
                    "notes": item["notes"],
                })
        return len(items)
