"""Local web UI for the time card.

Runs a small HTTP server bound to 127.0.0.1 only and opens it in the default
browser. Uses nothing outside the Python standard library so it behaves the
same on Linux, Windows and macOS.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import urllib.request
import webbrowser
from collections import defaultdict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .core import FINISHED, TimeCard, TimeCardError, now, to_iso

DEFAULT_PORT = 8765
UI_FILE = Path(__file__).with_name("ui.html")


def parse_when(text: str | None) -> datetime | None:
    """Parse a browser datetime-local value (local time, no zone)."""
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).astimezone()
    except ValueError:
        raise TimeCardError(f"Couldn't understand the time '{text}'.")


def build_state(card: TimeCard) -> dict:
    items = card.list_items()
    # Separate pieces that share a name get "(1 of 3)" style labels so they
    # can be told apart in the queue and at clock-out.
    by_name = defaultdict(list)
    for item in items:
        by_name[item["name"].lower()].append(item)
    for group in by_name.values():
        group.sort(key=lambda i: i.get("sequence", 0))
        for index, item in enumerate(group, start=1):
            item["label"] = item["name"] if len(group) == 1 else f"{item['name']} ({index} of {len(group)})"
    session = card.current_session()
    return {
        "now": to_iso(now()),
        "session": session,
        "items": items,
        "clock_out_ids": [i["id"] for i in card.clock_out_candidates()],
        "data_dir": str(card.data_dir),
    }


class Handler(BaseHTTPRequestHandler):
    card: TimeCard  # set on the class by serve()
    lock = threading.Lock()

    def log_message(self, *args):  # keep the console quiet
        pass

    # ----- helpers -----------------------------------------------------

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status: int = 200):
        self._send(status, json.dumps(data).encode("utf-8"), "application/json")

    def _host_ok(self) -> bool:
        # Refuse requests aimed at us through another hostname (DNS rebinding).
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    # ----- routes ------------------------------------------------------

    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "forbidden"}, 403)
        url = urlparse(self.path)
        if url.path == "/":
            return self._send(200, UI_FILE.read_bytes(), "text/html; charset=utf-8")
        if url.path == "/api/ping":
            return self._json({"app": "jewelry-timecard"})
        if url.path == "/api/state":
            return self._json(build_state(self.card))
        if url.path == "/api/export.csv":
            scope = parse_qs(url.query).get("scope", ["all"])[0]
            items = self.card.list_items()
            if scope == "finished":
                items = [i for i in items if i["status"] == FINISHED]
            exports = self.card.data_dir / "exports"
            exports.mkdir(exist_ok=True)
            name = f"timecard-{scope}-{now().strftime('%Y%m%d-%H%M%S')}.csv"
            self.card.export_csv(exports / name, items)
            return self._send(200, (exports / name).read_bytes(), "text/csv; charset=utf-8",
                              {"Content-Disposition": f'attachment; filename="{name}"'})
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        # Requiring a JSON content type means another website can't quietly
        # post to this server from the artist's browser.
        if not self._host_ok() or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json({"error": "forbidden"}, 403)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad request"}, 400)
        try:
            with self.lock:
                if not self._dispatch(urlparse(self.path).path, body):
                    return self._json({"error": "not found"}, 404)
                return self._json(build_state(self.card))
        except TimeCardError as e:
            return self._json({"error": str(e)}, 400)
        except (KeyError, TypeError, ValueError):
            return self._json({"error": "That request was missing something."}, 400)

    def _dispatch(self, path: str, body: dict) -> bool:
        card = self.card
        if path == "/api/clock-in":
            card.clock_in(parse_when(body.get("when")))
        elif path == "/api/clock-out":
            card.clock_out(body.get("allocations", {}), parse_when(body.get("when")))
        elif path == "/api/cancel-session":
            card.cancel_clock_in()
        elif path == "/api/items":
            card.add_item(body["name"], int(body.get("quantity", 1)), body.get("sku", ""),
                          body.get("notes", ""), bool(body.get("separate")))
        elif path == "/api/items/finish":
            card.finish_items(list(body["ids"]))
        elif match := re.fullmatch(r"/api/items/([\w-]+)/(update|finish-part|reopen|delete)", path):
            item_id, action = match.groups()
            if action == "update":
                card.update_item(item_id, name=body.get("name"), sku=body.get("sku"), notes=body.get("notes"))
            elif action == "finish-part":
                card.finish_part_of_batch(item_id, int(body["count"]))
            elif action == "reopen":
                card.reopen_item(item_id)
            else:
                card.delete_item(item_id)
        else:
            return False
        return True


def _already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            return json.load(r).get("app") == "jewelry-timecard"
    except Exception:
        return False


def serve(card: TimeCard, port: int = DEFAULT_PORT, open_browser: bool = True) -> None:
    Handler.card = card
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        if _already_running(port):
            print(f"Jewelry Time Card is already running at http://127.0.0.1:{port}")
            if open_browser:
                webbrowser.open(f"http://127.0.0.1:{port}")
            return
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # any free port
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    print(f"Jewelry Time Card is running at {url}")
    print(f"Data folder: {card.data_dir}")
    print("Leave this window open while you work. Press Ctrl+C to quit.")
    if open_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jewelry-timecard", description="Time card for jewelry artists.")
    parser.add_argument("--data-dir", help="where to keep the JSON files (default: per-user app data folder)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    parser.add_argument("--export", metavar="FILE.csv", help="write a CSV of every piece and exit")
    args = parser.parse_args(argv)

    card = TimeCard(args.data_dir)
    if args.export:
        count = card.export_csv(args.export)
        print(f"Wrote {count} pieces to {args.export}")
        return 0
    serve(card, args.port, not args.no_browser)
    return 0


if __name__ == "__main__":
    sys.exit(main())
