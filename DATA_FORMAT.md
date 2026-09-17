# BenchClock data format

BenchClock keeps everything as plain files so other programs (Superfy, a spreadsheet,
a backup tool) can read them. **This document is the contract.** Fields are only ever
added; nothing here is renamed or removed without raising `schema_version`.

Current `schema_version`: **1**

## Where

| System  | Folder                                         |
|---------|------------------------------------------------|
| Linux   | `~/.local/share/BenchClock`                    |
| macOS   | `~/Library/Application Support/BenchClock`     |
| Windows | `%APPDATA%\BenchClock`                         |

Override with the `BENCHCLOCK_DATA_DIR` environment variable or `--data-dir=<folder>`.

```
items/<id>.json          one file per piece, or per batch made together
items/time-overhead.json TimeOverhead: clocked time that was not given to a piece
sessions/<stamp>-<id>.json   one file per completed clock-in / clock-out
photos/<hash>.jpg        photo library; 512 px square JPEGs
current_session.json     exists only while clocked in: { id, clock_in }
```

All timestamps are ISO 8601 local time with UTC offset, to the second:
`2026-09-17T14:05:00-04:00`. All durations are seconds.

## `items/<id>.json`

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | int | `1` |
| `id` | string | `<slug-of-name>-<8 hex>`; also the file name. Never changes, even if the piece is renamed. |
| `sequence` | int | Running number; keeps same-named pieces in the order they were added. |
| `name` | string | Piece or design name. Several items may share a name. |
| `sku` | string | Optional, may be empty. |
| `type` | string | `earrings`, `ring`, `pendant`, `chain`, `bracelet`, `cuff`, `brooch`, `custom`, `other`; `overhead` for TimeOverhead. Missing in files from before types existed: treat as `other`. |
| `photo` | string or null | File name inside `photos/`, shown instead of the type's icon. May be missing: treat as null. |
| `quantity` | int | 1 for a single piece; more for a batch made together. |
| `status` | string | `not_started`, `in_progress`, `finished`; `overhead` for TimeOverhead. |
| `notes` | string | Free text, may be empty. |
| `created_at` | timestamp | |
| `started_at` | timestamp or null | Clock-in time of the first session that gave it time. |
| `finished_at` | timestamp or null | |
| `split_from` | string or null | When part of a batch was finished early, the id of the batch it came from. |
| `time_entries` | array | One entry per work session, below. |
| `total_seconds` | number | Sum of `time_entries[].seconds`. |
| `seconds_per_piece` | number | `total_seconds / quantity`. |

Each `time_entries[]` entry: `session_id`, `clock_in`, `clock_out`, `percent` (share of
that session, 0-100), `seconds` (session length x percent).

When part of a batch is finished early, those pieces become a new `finished` item
(`split_from` set) and the batch's existing time entries are divided between the two
in proportion to their quantities.

## `sessions/*.json`

`id`, `clock_in`, `clock_out`, `seconds`, and `allocations`: an array of
`{ item_id, name, quantity, percent }`. Percentages always total 100; the part not
given to a piece appears as the `time-overhead` entry.

## CSV export

One row per item, `\r\n` line endings, RFC 4180 quoting. Columns:

`item_id, name, sku, type, photo, quantity, status, created_at, started_at, finished_at,
total_hours, total_minutes, minutes_per_piece, work_sessions, notes`

"Export everything" ends with the TimeOverhead row (`status` = `overhead`).
Read columns by header name, not position: new columns may be added.
