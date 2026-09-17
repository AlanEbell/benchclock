"""Native desktop window for the time card, built on Tk.

Tk ships with Python on Windows and macOS; on Linux it is the python3-tk
package. All of the time keeping lives in core.py - this file is only the
window.
"""

from __future__ import annotations

import math
import re
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, font as tkfont, messagebox, simpledialog, ttk

from .core import (FINISHED, IN_PROGRESS, NOT_STARTED, OVERHEAD_ID, OVERHEAD_NAME, STATUS_LABELS, TimeCard,
                   TimeCardError, format_duration, from_iso, label_items, now)

ACCENT = "#1f6b62"
WARN = "#a3402f"
MUTED = "#6f675d"
PAD = 12     # both are reset for the screen's resolution once the window exists
SCALE = 1.0

WHEN_EXAMPLE = "2026-09-17 2:05 PM"
_WHEN_RE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})\s*([ap])?\.?m?\.?", re.I)


def format_clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 3600}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"


def _hour12(dt: datetime) -> str:
    return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def format_when(iso: str | None) -> str:
    """'Sep 17, 2:05 PM' - written by hand so it doesn't depend on the locale."""
    if not iso:
        return ""
    dt = from_iso(iso).astimezone()
    return f"{dt:%b} {dt.day}, {_hour12(dt)}"


def when_to_text(dt: datetime) -> str:
    return f"{dt:%Y-%m-%d} {_hour12(dt)}"


def text_to_when(text: str) -> datetime | None:
    """Read '2026-09-17 2:05 PM' or '2026-09-17 14:05' as local time."""
    match = _WHEN_RE.fullmatch(text.strip())
    if not match:
        return None
    year, month, day, hour, minute, ampm = match.groups()
    hour = int(hour)
    if ampm:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if ampm.lower() == "p" else 0)
    try:
        return datetime(int(year), int(month), int(day), hour, int(minute)).astimezone()
    except ValueError:
        return None


def parse_percent(text: str) -> float | None:
    """Blank counts as 0; anything that isn't a sensible number is None."""
    text = text.strip().rstrip("%").strip()
    if not text:
        return 0.0
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) and value >= 0 else None


def spread_evenly(total: float, weights: list[float]) -> list[float]:
    """Split `total` by weight to two decimals; the last share absorbs the rounding."""
    whole = sum(weights)
    shares = [math.floor(total * w / whole * 100) / 100 for w in weights[:-1]]
    return shares + [round(total - sum(shares), 2)]


def pieces(count: int) -> str:
    return f"{count} piece{'' if count == 1 else 's'}"


def px(pixels: float) -> int:
    """Tk scales fonts for high-resolution screens but not pixel sizes, so widths go through here."""
    return int(pixels * SCALE)


def center_over(window: tk.Toplevel, parent: tk.Misc) -> None:
    window.update_idletasks()
    x = parent.winfo_rootx() + (parent.winfo_width() - window.winfo_width()) // 2
    y = parent.winfo_rooty() + (parent.winfo_height() - window.winfo_height()) // 3
    window.geometry(f"+{max(x, 0)}+{max(y, 0)}")


class Dialog(tk.Toplevel):
    """A modal window over the main one."""

    def __init__(self, parent: tk.Misc, title: str):
        super().__init__(parent)
        self.withdraw()
        self.title(title)
        self.transient(parent)
        self.resizable(False, False)
        self.body = ttk.Frame(self, padding=PAD + 4)
        self.body.pack(fill="both", expand=True)
        self.bind("<Escape>", lambda e: self.destroy())

    def show(self, parent: tk.Misc, wait: bool = True) -> None:
        center_over(self, parent)
        self.deiconify()
        if wait:
            self.wait_visibility()
            self.grab_set()
            self.wait_window()


class ClockOutDialog(Dialog):
    """Asks what share of the session went to each piece. The rest goes to TimeOverhead."""

    def __init__(self, parent: tk.Misc, card: TimeCard):
        super().__init__(parent, "Clock out")
        self.card = card
        self.session = card.current_session()
        self.record = None  # set once the clock-out has been saved
        ids = {i["id"] for i in card.clock_out_candidates()}
        self.candidates = [i for i in label_items(card.list_items()) if i["id"] in ids]
        self._spreading = False

        self.summary = ttk.Label(self.body)
        self.summary.pack(anchor="w")
        ttk.Label(self.body, text="Clock-out time (change this if you forgot to clock out)",
                  style="Muted.TLabel").pack(anchor="w", pady=(10, 2))
        self._when_default = when_to_text(now())
        self.when_var = tk.StringVar(value=self._when_default)
        ttk.Entry(self.body, textvariable=self.when_var, width=24).pack(anchor="w")
        self.when_var.trace_add("write", lambda *a: self.update_totals())

        self.item_vars: dict[str, tk.StringVar] = {}
        self.group_vars: dict[str, tk.StringVar] = {}
        self.minute_labels: dict[str, ttk.Label] = {}
        if self.candidates:
            ttk.Label(self.body, style="Muted.TLabel", wraplength=px(520), justify="left",
                      text="What share of this session went to each piece? Leave blank for pieces you "
                           f"didn't touch. Whatever you don't assign goes to {OVERHEAD_NAME}."
                      ).pack(anchor="w", pady=(14, 4))
            self._build_rows()
        else:
            ttk.Label(self.body, style="Muted.TLabel", wraplength=px(420), justify="left",
                      text=f"No pieces on the bench, so this whole session goes to {OVERHEAD_NAME}."
                      ).pack(anchor="w", pady=(14, 4))

        ttk.Separator(self.body).pack(fill="x", pady=4)
        overhead = ttk.Frame(self.body)
        overhead.pack(fill="x")
        names = ttk.Frame(overhead)
        names.pack(side="left")
        ttk.Label(names, text=OVERHEAD_NAME, style="Bold.TLabel").pack(anchor="w")
        ttk.Label(names, text="everything besides making - gets whatever is left", style="Muted.TLabel").pack(anchor="w")
        self.overhead_minutes = ttk.Label(overhead, style="Muted.TLabel", width=8, anchor="e")
        self.overhead_minutes.pack(side="right")
        self.overhead_percent = ttk.Label(overhead, style="Bold.TLabel", anchor="e")
        self.overhead_percent.pack(side="right", padx=(0, px(8)))
        self.total = ttk.Label(self.body, style="Bold.TLabel")
        self.total.pack(anchor="e", pady=(8, 0))

        buttons = ttk.Frame(self.body)
        buttons.pack(fill="x", pady=(16, 0))
        if self.candidates:
            ttk.Button(buttons, text="Split evenly", command=self.split_evenly).pack(side="left")
            ttk.Button(buttons, text="Spread the rest", command=self.spread_rest).pack(side="left", padx=6)
        self.confirm_button = ttk.Button(buttons, text="Clock out", style="Accent.TButton", command=self.confirm)
        self.confirm_button.pack(side="right")
        ttk.Button(buttons, text="Keep working", command=self.destroy).pack(side="right", padx=6)
        self.bind("<Return>", lambda e: self.confirm())

        self.update_totals()
        self._tick()

    # ----- layout ------------------------------------------------------

    def _build_rows(self) -> None:
        # The rows sit in a canvas so a long bench scrolls instead of running off the screen.
        holder = ttk.Frame(self.body)
        holder.pack(fill="both", expand=True)
        canvas = tk.Canvas(holder, highlightthickness=0, borderwidth=0,
                           background=ttk.Style(self).lookup("TFrame", "background"))
        rows = ttk.Frame(canvas)
        window = canvas.create_window((0, 0), window=rows, anchor="nw")
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window, width=e.width))
        rows.columnconfigure(0, weight=1, minsize=px(300))

        groups: dict[str, list[dict]] = {}
        for item in self.candidates:
            groups.setdefault(item["name"].lower(), []).append(item)
        row = 0
        for key, group in groups.items():
            ttk.Separator(rows).grid(row=row, column=0, columnspan=3, sticky="ew", pady=4)
            row += 1
            if len(group) > 1:
                head = ttk.Frame(rows)
                head.grid(row=row, column=0, sticky="w")
                ttk.Label(head, text=f"All {len(group)} × {group[0]['name']}", style="Bold.TLabel").pack(anchor="w")
                ttk.Label(head, text="worked on together - splits evenly", style="Muted.TLabel").pack(anchor="w")
                var = self.group_vars[key] = tk.StringVar()
                self._percent_entry(rows, var).grid(row=row, column=1, padx=(12, 8), pady=2)
                var.trace_add("write", lambda *a, k=key: self._group_changed(k))
                row += 1
            for item in group:
                text = item["label"] + (f"  ×{item['quantity']}" if item["quantity"] > 1 else "")
                if item["status"] == FINISHED:
                    text += "  (finished)"
                ttk.Label(rows, text=text).grid(row=row, column=0, sticky="w", padx=(px(18) if len(group) > 1 else 0, 0))
                var = self.item_vars[item["id"]] = tk.StringVar()
                self._percent_entry(rows, var).grid(row=row, column=1, padx=(12, 8), pady=2)
                var.trace_add("write", lambda *a, k=key: self._item_changed(k))
                label = self.minute_labels[item["id"]] = ttk.Label(rows, style="Muted.TLabel", width=8, anchor="e")
                label.grid(row=row, column=2, sticky="e")
                row += 1

        rows.update_idletasks()
        height = min(rows.winfo_reqheight(), int(self.winfo_screenheight() * 0.5))
        canvas.configure(width=rows.winfo_reqwidth(), height=height,
                         scrollregion=(0, 0, rows.winfo_reqwidth(), rows.winfo_reqheight()))
        canvas.pack(side="left", fill="both", expand=True)
        if height < rows.winfo_reqheight():
            bar = ttk.Scrollbar(holder, orient="vertical", command=canvas.yview)
            canvas.configure(yscrollcommand=bar.set)
            bar.pack(side="right", fill="y")
            self.bind("<MouseWheel>", lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))
            self.bind("<Button-4>", lambda e: canvas.yview_scroll(-1, "units"))
            self.bind("<Button-5>", lambda e: canvas.yview_scroll(1, "units"))

    @staticmethod
    def _percent_entry(parent: tk.Misc, var: tk.StringVar) -> ttk.Frame:
        frame = ttk.Frame(parent)
        ttk.Entry(frame, textvariable=var, width=7, justify="right").pack(side="left")
        ttk.Label(frame, text="%", style="Muted.TLabel").pack(side="left", padx=(3, 0))
        return frame

    # ----- behaviour ---------------------------------------------------

    def _vars_named(self, key: str) -> list[tk.StringVar]:
        return [self.item_vars[i["id"]] for i in self.candidates if i["name"].lower() == key]

    def _set(self, variables: list[tk.StringVar], values: list[float | str]) -> None:
        self._spreading = True
        for var, value in zip(variables, values):
            var.set(value if isinstance(value, str) else f"{value:g}")
        self._spreading = False

    def _group_changed(self, key: str) -> None:
        if self._spreading:
            return
        members = self._vars_named(key)
        value = parse_percent(self.group_vars[key].get())
        self._set(members, spread_evenly(value, [1] * len(members)) if value else [""] * len(members))
        self.update_totals()

    def _item_changed(self, key: str) -> None:
        if self._spreading:
            return
        if key in self.group_vars:  # typing in one piece makes the group figure stale
            self._set([self.group_vars[key]], [""])
        self.update_totals()

    def split_evenly(self) -> None:
        """100% across every piece listed, weighted so a batch of 6 gets six shares."""
        self._set(list(self.group_vars.values()), [""] * len(self.group_vars))
        self._set([self.item_vars[i["id"]] for i in self.candidates],
                  spread_evenly(100, [i["quantity"] for i in self.candidates]))
        self.update_totals()

    def spread_rest(self) -> None:
        """Whatever hasn't been assigned goes evenly to the rows still blank."""
        values = [parse_percent(v.get()) for v in self.item_vars.values()]
        if None in values:
            return
        blank = [v for v in self.item_vars.values() if not v.get().strip()]
        left = round(100 - sum(values), 2)
        if blank and left > 0:
            self._set(blank, spread_evenly(left, [1] * len(blank)))
            self.update_totals()

    def clock_out_time(self) -> datetime | None:
        """None when the time typed in can't be read."""
        text = self.when_var.get()
        return now() if text == self._when_default else text_to_when(text)

    def update_totals(self) -> None:
        end = self.clock_out_time()
        seconds = (end - from_iso(self.session["clock_in"])).total_seconds() if end else 0
        if end is None:
            self.summary.configure(text=f"Couldn't read that time. Write it like {WHEN_EXAMPLE}.", foreground=WARN)
        elif seconds <= 0:
            self.summary.configure(text="Clock-out time has to be after you clocked in "
                                        f"({format_when(self.session['clock_in'])}).", foreground=WARN)
        else:
            self.summary.configure(text=f"Clocked in {format_when(self.session['clock_in'])} - "
                                        f"{format_duration(seconds)} this session.", foreground="")
        ok = seconds > 0
        values = {item_id: parse_percent(var.get()) for item_id, var in self.item_vars.items()}
        for item_id, value in values.items():
            self.minute_labels[item_id].configure(text=format_duration(seconds * value / 100) if value and ok else "")
        assigned = None if None in values.values() else round(sum(values.values()), 2)
        if assigned is None:
            self.total.configure(text="Percentages need to be numbers.", foreground=WARN)
        elif assigned > 100.01:
            self.total.configure(text=f"Pieces add up to {assigned:g}% - {assigned - 100:g}% too much", foreground=WARN)
        else:
            self.total.configure(text=f"Pieces {assigned:g}%  +  {OVERHEAD_NAME} {max(100 - assigned, 0):g}%  =  100%",
                                 foreground=ACCENT)
        fits = assigned is not None and assigned <= 100.01
        left = max(100 - assigned, 0) if fits else 0
        self.overhead_percent.configure(text=f"{left:g} %" if fits else "")
        self.overhead_minutes.configure(text=format_duration(seconds * left / 100) if fits and ok and left else "")
        ok = ok and fits
        self.confirm_button.state(["!disabled"] if ok else ["disabled"])

    def _tick(self) -> None:
        # Keeps the session length current while the dialog sits open.
        self.update_totals()
        self._timer = self.after(5000, self._tick)

    def destroy(self) -> None:
        self.after_cancel(self._timer)
        super().destroy()

    def confirm(self) -> None:
        if self.confirm_button.instate(["disabled"]):
            return
        allocations = {i: parse_percent(v.get()) for i, v in self.item_vars.items()}  # the rest is overhead
        edited = self.when_var.get() != self._when_default
        try:
            self.record = self.card.clock_out(allocations, self.clock_out_time() if edited else None)
        except TimeCardError as error:
            messagebox.showerror("Clock out", str(error), parent=self)
            return
        self.destroy()


class EditDialog(Dialog):
    def __init__(self, parent: tk.Misc, card: TimeCard, item: dict):
        super().__init__(parent, "Edit piece")
        self.card, self.item = card, item
        self.body.columnconfigure(0, weight=1)
        self.name_var = tk.StringVar(value=item["name"])
        self.sku_var = tk.StringVar(value=item["sku"])
        for label, var in (("Name", self.name_var), ("SKU", self.sku_var)):
            ttk.Label(self.body, text=label, style="Muted.TLabel").pack(anchor="w")
            ttk.Entry(self.body, textvariable=var, width=46).pack(fill="x", pady=(0, 10))
        ttk.Label(self.body, text="Notes", style="Muted.TLabel").pack(anchor="w")
        self.notes = tk.Text(self.body, width=46, height=4, wrap="word", font="TkDefaultFont")
        self.notes.insert("1.0", item["notes"])
        self.notes.pack(fill="x")
        buttons = ttk.Frame(self.body)
        buttons.pack(fill="x", pady=(16, 0))
        ttk.Button(buttons, text="Delete piece", command=self.delete).pack(side="left")
        ttk.Button(buttons, text="Save", style="Accent.TButton", command=self.save).pack(side="right")
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="right", padx=6)

    def save(self) -> None:
        try:
            self.card.update_item(self.item["id"], name=self.name_var.get(), sku=self.sku_var.get(),
                                  notes=self.notes.get("1.0", "end"))
        except TimeCardError as error:
            messagebox.showerror("Edit piece", str(error), parent=self)
            return
        self.destroy()

    def delete(self) -> None:
        question = (f"Delete \"{self.item['label']}\" and its {format_duration(self.item['total_seconds'])} "
                    "of logged time?\n\nThis can't be undone.")
        if messagebox.askyesno("Delete piece", question, icon="warning", default="no", parent=self):
            self.card.delete_item(self.item["id"])
            self.destroy()


class LogDialog(Dialog):
    """The work sessions recorded against one piece."""

    def __init__(self, parent: tk.Misc, card: TimeCard, item: dict):
        super().__init__(parent, f"Time log - {item['label']}")
        per_piece = f"  ({format_duration(item['seconds_per_piece'])} each)" if item["quantity"] > 1 else ""
        ttk.Label(self.body, text=f"{item['label']}: {format_duration(item['total_seconds'])}{per_piece}",
                  style="Bold.TLabel").pack(anchor="w")
        if item["time_entries"]:
            columns = (("start", "Clocked in", 150), ("end", "Clocked out", 150),
                       ("percent", "Share of session", 130), ("time", "Time", 90))
            tree = ttk.Treeview(self.body, columns=[c[0] for c in columns], show="headings",
                                height=min(len(item["time_entries"]), 12), selectmode="none")
            for key, heading, width in columns:
                tree.heading(key, text=heading, anchor="w")
                tree.column(key, width=px(width), anchor="w")
            for entry in item["time_entries"]:
                tree.insert("", "end", values=(format_when(entry["clock_in"]), format_when(entry["clock_out"]),
                                               f"{entry['percent']:g}%", format_duration(entry["seconds"])))
            tree.pack(pady=(10, 0))
        else:
            ttk.Label(self.body, text="No time logged yet.", style="Muted.TLabel").pack(anchor="w", pady=(10, 0))
        ttk.Label(self.body, text=f"File: {card.items_dir / (item['id'] + '.json')}", style="Muted.TLabel",
                  wraplength=px(520), justify="left").pack(anchor="w", pady=(12, 0))
        ttk.Button(self.body, text="Close", command=self.destroy).pack(anchor="e", pady=(12, 0))


class TimeCardApp:
    def __init__(self, root: tk.Tk, card: TimeCard):
        self.root, self.card = root, card
        self.items: dict[str, dict] = {}
        self.session = None
        root.title("Jewelry Time Card")
        self._style()

        outer = ttk.Frame(root, padding=PAD + 4)
        outer.pack(fill="both", expand=True)
        self._build_clock(outer)
        self.tabs = ttk.Notebook(outer)
        self.tabs.pack(fill="both", expand=True, pady=(PAD, 0))
        self._build_bench()
        self._build_finished()
        self.status = tk.StringVar()
        ttk.Label(outer, textvariable=self.status, style="Muted.TLabel").pack(anchor="w", pady=(8, 0))

        # Pick up anything changed on disk (a synced folder, the browser version) when the window is returned to.
        root.bind("<FocusIn>", lambda e: e.widget is root and self.refresh())
        self.refresh()
        self.say(f"Each piece is saved as its own JSON file in {card.data_dir}")
        self._tick()
        root.protocol("WM_DELETE_WINDOW", self.close)

    # ----- look --------------------------------------------------------

    def _style(self) -> None:
        global PAD, SCALE
        style = ttk.Style(self.root)
        if self.root.tk.call("tk", "windowingsystem") == "x11":
            style.theme_use("clam")  # the X11 default theme looks thirty years old
            for name in ("TkDefaultFont", "TkTextFont", "TkHeadingFont", "TkMenuFont"):
                tkfont.nametofont(name).configure(size=11)
        base = tkfont.nametofont("TkDefaultFont")
        # Tk sizes text for the screen's resolution but leaves pixel measurements alone, and on Linux it
        # can't be asked for the real resolution. So measure the text: a line is 20 pixels on a plain screen.
        SCALE = max(1.0, base.metrics("linespace") / 20)
        PAD = px(12)
        width = min(px(880), self.root.winfo_screenwidth() - px(60))
        height = min(px(780), self.root.winfo_screenheight() - px(100))
        self.root.geometry(f"{width}x{height}")
        self.root.minsize(min(px(720), width), min(px(560), height))
        # cget, not actual(): the configured size is in the same units Tk will scale for the screen.
        family, size = base.actual("family"), base.cget("size")
        self.timer_font = tkfont.Font(family=family, size=size * 3, weight="bold")
        bold = tkfont.Font(family=family, size=size, weight="bold")
        small = tkfont.Font(family=family, size=size - 1 if size > 0 else size + 1)
        style.configure("Treeview", rowheight=base.metrics("linespace") + px(12))
        style.configure("Muted.TLabel", foreground=MUTED, font=small)
        style.configure("Bold.TLabel", font=bold)
        style.configure("State.TLabel", foreground=MUTED, font=bold)
        style.configure("Accent.TButton", font=bold)
        style.configure("Choice.Toolbutton", padding=(px(10), px(4)))
        style.map("Choice.Toolbutton", font=[("selected", bold)])
        # The theme draws these at a fixed pixel size, which is tiny on a high-resolution screen.
        style.configure("Vertical.TScrollbar", arrowsize=px(14))
        style.configure("Treeview", indent=px(20))
        style.configure("Treeview.Item", indicatorsize=px(12))
        style.configure("Clock.TButton", font=tkfont.Font(family=family, size=size + (3 if size > 0 else -3), weight="bold"),
                        padding=(px(26), px(12)))
        self.bold = bold

    # ----- clock -------------------------------------------------------

    def _build_clock(self, parent: ttk.Frame) -> None:
        box = ttk.LabelFrame(parent, padding=(PAD + 4, 6, PAD + 4, PAD))
        box.pack(fill="x")
        left = ttk.Frame(box)
        left.pack(side="left")
        self.state_label = ttk.Label(left, style="State.TLabel")
        self.state_label.pack(anchor="w")
        self.timer = ttk.Label(left, text="0:00:00", font=self.timer_font)
        self.timer.pack(anchor="w")
        self.since = ttk.Label(left, style="Muted.TLabel")
        self.since.pack(anchor="w")
        self.clock_button = ttk.Button(box, style="Clock.TButton", command=self.toggle_clock)
        self.clock_button.pack(side="right")
        self.discard_button = ttk.Button(box, text="Discard session", command=self.discard_session)

    def toggle_clock(self) -> None:
        if self.card.current_session():
            dialog = ClockOutDialog(self.root, self.card)
            dialog.show(self.root)
            if dialog.record:
                self.say(self.clock_out_message(dialog.record))
        else:
            self.attempt(self.card.clock_in)
            self.say("Clocked in.")
        self.refresh()

    @staticmethod
    def clock_out_message(record: dict) -> str:
        message = f"Clocked out. {format_duration(record['seconds'])} logged"
        overhead = sum(a["percent"] for a in record["allocations"] if a["item_id"] == OVERHEAD_ID)
        if overhead:
            message += f", {format_duration(record['seconds'] * overhead / 100)} of it to {OVERHEAD_NAME}"
        return message + "."

    def discard_session(self) -> None:
        if messagebox.askyesno("Discard session", "Discard this session?\n\nNo time will be logged for it.",
                               icon="warning", default="no", parent=self.root):
            self.card.cancel_clock_in()
            self.say("Session discarded.")
            self.refresh()

    def _tick(self) -> None:
        if self.session:
            elapsed = (now() - from_iso(self.session["clock_in"])).total_seconds()
            self.timer.configure(text=format_clock(elapsed))
        self._timer = self.root.after(1000, self._tick)

    def close(self) -> None:
        self.root.after_cancel(self._timer)
        self.root.destroy()

    # ----- the bench ---------------------------------------------------

    def _make_tree(self, parent: ttk.Frame, columns: tuple, selectmode: str) -> ttk.Treeview:
        frame = ttk.Frame(parent)  # packed by the caller, after the rows that sit under it
        tree = ttk.Treeview(frame, columns=[c[0] for c in columns], selectmode=selectmode, height=5)
        tree.heading("#0", text="Piece", anchor="w")
        tree.column("#0", width=px(340), minwidth=px(200))
        for key, heading, width in columns:
            tree.heading(key, text=heading, anchor="e" if key in ("qty", "time", "each") else "w")
            tree.column(key, width=px(width), minwidth=px(60), stretch=False, anchor="e" if key in ("qty", "time", "each") else "w")
        bar = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=bar.set)
        tree.pack(side="left", fill="both", expand=True)
        bar.pack(side="right", fill="y")
        tree.tag_configure("group", font=self.bold, foreground=MUTED)
        return tree

    def _build_bench(self) -> None:
        tab = ttk.Frame(self.tabs, padding=PAD)
        self.tabs.add(tab, text="On the bench")
        self.bench_tab = tab
        ttk.Label(tab, style="Muted.TLabel", text="Select pieces to mark them finished. "
                  "Ctrl-click or Shift-click selects several.").pack(anchor="w", pady=(0, 6))
        self.bench = self._make_tree(tab, (("qty", "How many", 90), ("time", "Time so far", 110),
                                           ("each", "Per piece", 100), ("sku", "  SKU", 120)), "extended")
        self.bench.bind("<<TreeviewSelect>>", lambda e: self._update_buttons())
        self.bench.bind("<Double-1>", lambda e: self.edit_selected(self.bench))

        form = ttk.LabelFrame(tab, text="Add a piece", padding=PAD)
        form.pack(side="bottom", fill="x", pady=(PAD, 0))
        buttons = ttk.Frame(tab)
        buttons.pack(side="bottom", fill="x", pady=(8, 0))
        self.bench.master.pack(fill="both", expand=True)
        self.finish_button = ttk.Button(buttons, text="Mark finished", style="Accent.TButton", command=self.finish_selected)
        self.finish_button.pack(side="left")
        self.part_button = ttk.Button(buttons, text="Finish some of a batch…", command=self.finish_part)
        self.part_button.pack(side="left", padx=6)
        self.bench_edit = ttk.Button(buttons, text="Edit…", command=lambda: self.edit_selected(self.bench))
        self.bench_edit.pack(side="right")
        self.bench_log = ttk.Button(buttons, text="Time log…", command=lambda: self.show_log(self.bench))
        self.bench_log.pack(side="right", padx=6)

        form.columnconfigure(0, weight=3)
        form.columnconfigure(2, weight=1)
        for column, text in enumerate(("New piece or design name", "How many", "SKU (optional)")):
            ttk.Label(form, text=text, style="Muted.TLabel").grid(row=0, column=column, sticky="w", padx=(0, 8))
        self.add_name, self.add_qty, self.add_sku = tk.StringVar(), tk.StringVar(value="1"), tk.StringVar()
        self.add_mode = tk.StringVar(value="batch")
        self.name_entry = ttk.Entry(form, textvariable=self.add_name)
        self.name_entry.grid(row=1, column=0, sticky="ew", padx=(0, 8))
        # Not a ttk.Spinbox: its arrows are a fixed few pixels and all but vanish on a high-resolution screen.
        stepper = ttk.Frame(form)
        stepper.grid(row=1, column=1, sticky="w", padx=(0, 8))
        ttk.Button(stepper, text="\u2212", width=2, style="Accent.TButton", command=lambda: self._step_quantity(-1)).pack(side="left")
        qty_entry = ttk.Entry(stepper, textvariable=self.add_qty, width=4, justify="center")
        qty_entry.pack(side="left", padx=2)
        ttk.Button(stepper, text="+", width=2, style="Accent.TButton", command=lambda: self._step_quantity(1)).pack(side="left")
        qty_entry.bind("<Up>", lambda e: self._step_quantity(1))
        qty_entry.bind("<Down>", lambda e: self._step_quantity(-1))
        sku_entry = ttk.Entry(form, textvariable=self.add_sku)
        sku_entry.grid(row=1, column=2, sticky="ew", padx=(0, 8))
        ttk.Button(form, text="Add", style="Accent.TButton", command=self.add_piece).grid(row=1, column=3)
        self.mode_row = ttk.Frame(form)
        self.mode_row.grid(row=2, column=0, columnspan=4, sticky="w", pady=(8, 0))
        # Drawn as two push buttons: the round dot of a normal radio button is a fixed few pixels, too
        # small to see on a high-resolution screen.
        for value, text in (("batch", "One batch made together (time shared evenly)"),
                            ("separate", "Separate pieces, each timed on its own")):
            ttk.Radiobutton(self.mode_row, variable=self.add_mode, value=value, text=text,
                            style="Choice.Toolbutton").pack(side="left", padx=(0, 6))
        self.add_qty.trace_add("write", lambda *a: self._show_mode_row())
        self._show_mode_row()
        for entry in (self.name_entry, qty_entry, sku_entry):
            entry.bind("<Return>", lambda e: self.add_piece())

    def _add_quantity(self) -> int:
        try:
            return int(self.add_qty.get())
        except ValueError:
            return 0

    def _step_quantity(self, change: int) -> None:
        self.add_qty.set(str(min(max(self._add_quantity() + change, 1), 999)))

    def _show_mode_row(self) -> None:
        if self._add_quantity() > 1:
            self.mode_row.grid()
        else:
            self.mode_row.grid_remove()

    def add_piece(self) -> None:
        quantity = self._add_quantity()
        added = self.attempt(self.card.add_item, self.add_name.get(), quantity, self.add_sku.get(),
                             separate=self.add_mode.get() == "separate")
        if added:
            self.say(f"Added {added[0]['name']}" + (f" ×{quantity}." if quantity > 1 else "."))
            self.add_name.set("")
            self.add_sku.set("")
            self.add_qty.set("1")
            self.add_mode.set("batch")
            self.name_entry.focus_set()
        self.refresh()

    def finish_selected(self) -> None:
        ids = self._selected_pieces()
        if ids:
            self.attempt(self.card.finish_items, ids)
            self.say(f"{pieces(sum(self.items[i]['quantity'] for i in ids))} marked finished.")
            self.refresh()

    def finish_part(self) -> None:
        ids = self._selected_pieces()
        if len(ids) != 1 or self.items[ids[0]]["quantity"] < 2:
            return
        item = self.items[ids[0]]
        count = simpledialog.askinteger(
            "Finish some of a batch",
            f"{item['label']} is a batch of {item['quantity']}.\n\nThe finished ones take their even share of the "
            "time logged so far; the rest stay on the bench.\n\nHow many are finished?",
            parent=self.root, initialvalue=1, minvalue=1, maxvalue=item["quantity"])
        if count:
            self.attempt(self.card.finish_part_of_batch, item["id"], count)
            self.say(f"{pieces(count)} of {item['name']} marked finished.")
            self.refresh()

    # ----- finished ----------------------------------------------------

    def _build_finished(self) -> None:
        tab = ttk.Frame(self.tabs, padding=PAD)
        self.tabs.add(tab, text="Finished")
        self.finished_tab = tab
        self.finished = self._make_tree(tab, (("qty", "How many", 90), ("time", "Total time", 110),
                                              ("each", "Per piece", 100), ("when", "Finished", 150)), "browse")
        self.finished.bind("<<TreeviewSelect>>", lambda e: self._update_buttons())
        self.finished.bind("<Double-1>", lambda e: self.show_log(self.finished))
        buttons = ttk.Frame(tab)
        buttons.pack(side="bottom", fill="x", pady=(8, 0))
        self.finished.master.pack(fill="both", expand=True)
        self.reopen_button = ttk.Button(buttons, text="Reopen", command=self.reopen_selected)
        self.reopen_button.pack(side="left")
        self.finished_log = ttk.Button(buttons, text="Time log…", command=lambda: self.show_log(self.finished))
        self.finished_log.pack(side="left", padx=6)
        self.finished_edit = ttk.Button(buttons, text="Edit…", command=lambda: self.edit_selected(self.finished))
        self.finished_edit.pack(side="left")
        self.export_all = ttk.Button(buttons, text="Export everything (CSV)…", command=lambda: self.export("all"))
        self.export_all.pack(side="right")
        self.export_finished = ttk.Button(buttons, text="Export finished (CSV)…", command=lambda: self.export("finished"))
        self.export_finished.pack(side="right", padx=6)

    def reopen_selected(self) -> None:
        for item_id in self._selected(self.finished):
            self.attempt(self.card.reopen_item, item_id)
            self.say(f"{self.items[item_id]['label']} is back on the bench.")
        self.refresh()

    def export(self, scope: str, path: str | None = None) -> None:
        items = [i for i in self.items.values() if scope == "all" or i["status"] == FINISHED]
        if path is None:
            documents = Path.home() / "Documents"
            path = filedialog.asksaveasfilename(
                parent=self.root, title="Export CSV", defaultextension=".csv", filetypes=[("CSV file", "*.csv")],
                initialdir=documents if documents.is_dir() else Path.home(),
                initialfile=f"timecard-{scope}-{now():%Y%m%d}.csv")
        if not path:
            return
        try:
            count = self.card.export_csv(path, items)
        except OSError as error:
            messagebox.showerror("Export CSV", f"Couldn't write that file.\n\n{error}", parent=self.root)
            return
        self.say(f"Wrote {count} row{'' if count == 1 else 's'} to {path}")

    # ----- shared ------------------------------------------------------

    def _selected(self, tree: ttk.Treeview) -> list[str]:
        return [i for i in tree.selection() if i in self.items]

    def _selected_pieces(self) -> list[str]:
        return [i for i in self._selected(self.bench) if i != OVERHEAD_ID]

    def edit_selected(self, tree: ttk.Treeview) -> None:
        ids = self._selected(tree)
        if ids == [OVERHEAD_ID]:  # nothing about it can be edited, so show what it has collected
            self.show_log(tree)
        elif len(ids) == 1:
            EditDialog(self.root, self.card, self.items[ids[0]]).show(self.root)
            self.refresh()

    def show_log(self, tree: ttk.Treeview) -> None:
        ids = self._selected(tree)
        if len(ids) == 1:
            LogDialog(self.root, self.card, self.items[ids[0]]).show(self.root)

    def attempt(self, action, *args, **kwargs):
        """Run something from core, turning its complaints into a message box."""
        try:
            return action(*args, **kwargs)
        except TimeCardError as error:
            messagebox.showerror("Jewelry Time Card", str(error), parent=self.root)
            return None

    def say(self, message: str) -> None:
        self.status.set(message)

    def _update_buttons(self) -> None:
        def enable(button: ttk.Button, on: bool) -> None:
            button.state(["!disabled"] if on else ["disabled"])

        bench, chosen = self._selected_pieces(), self._selected(self.bench)
        enable(self.finish_button, bool(bench))
        enable(self.part_button, len(bench) == 1 and self.items[bench[0]]["quantity"] > 1)
        enable(self.bench_edit, len(chosen) == 1 and len(bench) == 1)
        enable(self.bench_log, len(chosen) == 1)
        done = self._selected(self.finished)
        for button in (self.reopen_button, self.finished_log, self.finished_edit):
            enable(button, len(done) == 1)
        enable(self.export_finished, any(i["status"] == FINISHED for i in self.items.values()))
        enable(self.export_all, True)

    @staticmethod
    def _row_values(item: dict, last: str) -> tuple:
        each = format_duration(item["seconds_per_piece"]) if item["quantity"] > 1 else ""
        return (f"×{item['quantity']}" if item["quantity"] > 1 else "", format_duration(item["total_seconds"]), each, last)

    def refresh(self) -> None:
        """Redraw everything from what is on disk."""
        items = label_items(self.card.list_items())
        overhead = label_items([self.card.overhead_item()])[0]
        self.items = {i["id"]: i for i in items + [overhead]}
        self.session = self.card.current_session()

        on = bool(self.session)
        self.state_label.configure(text="CLOCKED IN" if on else "CLOCKED OUT", foreground=ACCENT if on else MUTED)
        self.clock_button.configure(text="Clock out" if on else "Clock in")
        self.since.configure(text=f"Since {format_when(self.session['clock_in'])}" if on
                             else "Clock in when you sit down at the bench.")
        if on:
            self.discard_button.pack(side="right", padx=PAD)
        else:
            self.discard_button.pack_forget()
            self.timer.configure(text="0:00:00")

        selected = {tree: tree.selection() for tree in (self.bench, self.finished)}
        for tree in selected:
            tree.delete(*tree.get_children())
        for status in (IN_PROGRESS, NOT_STARTED):
            rows = [i for i in items if i["status"] == status]
            if rows:
                group = self.bench.insert("", "end", iid=f"group:{status}", text=STATUS_LABELS[status].upper(),
                                          open=True, tags=("group",))
                for item in rows:
                    text = item["label"] + (f"   - {item['notes']}" if item["notes"] else "")
                    self.bench.insert(group, "end", iid=item["id"], text=text, values=self._row_values(item, "  " + item["sku"]))
        group = self.bench.insert("", "end", iid="group:overhead", text="NOT MAKING", open=True, tags=("group",))
        self.bench.insert(group, "end", iid=OVERHEAD_ID, values=("", format_duration(overhead["total_seconds"]), "", ""),
                          text=f"{OVERHEAD_NAME}   - whatever a session didn't give to a piece")
        done = [i for i in items if i["status"] == FINISHED]
        for item in done:
            self.finished.insert("", "end", iid=item["id"], text=item["label"],
                                 values=self._row_values(item, format_when(item["finished_at"])))
        for tree, ids in selected.items():
            tree.selection_set([i for i in ids if tree.exists(i)])

        open_count = sum(i["quantity"] for i in items if i["status"] != FINISHED)
        done_count = sum(i["quantity"] for i in done)
        self.tabs.tab(self.bench_tab, text=f"On the bench ({open_count})" if open_count else "On the bench")
        self.tabs.tab(self.finished_tab, text=f"Finished ({done_count})" if done_count else "Finished")
        self._update_buttons()


def run(card: TimeCard) -> None:
    root = tk.Tk(className="JewelryTimeCard")
    TimeCardApp(root, card)
    root.mainloop()
