"""Drives the real Tk widgets with the window kept hidden."""

import csv
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from jewelry_timecard.core import FINISHED, OVERHEAD_ID, TimeCard, now

try:
    import tkinter as tk
    from jewelry_timecard import tk_app
    _root = tk.Tk()
    _root.destroy()
except Exception as error:  # no Tk, or no display to open it on
    raise unittest.SkipTest(f"Tk is not usable here: {error}")


class HelperTests(unittest.TestCase):
    def test_time_text_round_trip(self):
        moment = now().replace(hour=14, minute=5, second=0, microsecond=0)
        self.assertEqual(tk_app.text_to_when(tk_app.when_to_text(moment)), moment)
        self.assertEqual(tk_app.text_to_when("2026-09-17 14:05"), tk_app.text_to_when("2026-09-17 2:05 pm"))
        self.assertEqual(tk_app.text_to_when("2026-09-17 12:30 AM").hour, 0)
        for bad in ("", "tomorrow", "2026-09-17", "2026-13-40 2:05 PM", "2026-09-17 14:05 PM"):
            self.assertIsNone(tk_app.text_to_when(bad), bad)

    def test_parse_percent(self):
        self.assertEqual(tk_app.parse_percent(""), 0)
        self.assertEqual(tk_app.parse_percent(" 12.5% "), 12.5)
        for bad in ("abc", "-5", "nan", "inf"):
            self.assertIsNone(tk_app.parse_percent(bad), bad)

    def test_spread_evenly_is_exact(self):
        self.assertEqual(tk_app.spread_evenly(100, [1, 1, 1]), [33.33, 33.33, 33.34])
        self.assertEqual(tk_app.spread_evenly(100, [6, 1, 1]), [75, 12.5, 12.5])
        self.assertAlmostEqual(sum(tk_app.spread_evenly(45, [1] * 7)), 45)


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.card = TimeCard(self.tmp.name)
        self.root = tk.Tk()
        self.root.withdraw()
        self.app = tk_app.TimeCardApp(self.root, self.card)

    def tearDown(self):
        self.app.close()
        self.tmp.cleanup()

    def add(self, name, quantity=1, separate=False):
        self.app.add_name.set(name)
        self.app.add_qty.set(str(quantity))
        self.app.add_mode.set("separate" if separate else "batch")
        self.app.add_piece()

    def bench_rows(self):
        tree = self.app.bench
        return {tree.item(g, "text"): [tree.item(i, "text") for i in tree.get_children(g)] for g in tree.get_children()}

    def test_adding_pieces_fills_the_bench(self):
        self.add("Hoop earrings", 6)
        self.add("Moonstone ring", 3, separate=True)
        self.assertEqual(self.bench_rows()["GETTING STARTED"], [
            "Hoop earrings", "Moonstone ring (1 of 3)", "Moonstone ring (2 of 3)", "Moonstone ring (3 of 3)"])
        self.assertEqual(self.app.tabs.tab(self.app.bench_tab, "text"), "On the bench (9)")
        self.assertEqual(self.app.add_name.get(), "")  # form cleared for the next piece

    def test_batch_options_only_show_for_more_than_one(self):
        self.root.update_idletasks()
        self.assertEqual(self.app.mode_row.winfo_manager(), "")
        self.app.add_qty.set("4")
        self.assertEqual(self.app.mode_row.winfo_manager(), "grid")

    def test_clock_in_then_clock_out_dialog(self):
        self.add("Hoop earrings", 6)
        self.add("Moonstone ring", 3, separate=True)
        self.add("Cuff")
        self.card.clock_in(now() - timedelta(hours=2))
        self.app.refresh()
        self.assertEqual(self.app.clock_button.cget("text"), "Clock out")
        self.assertEqual(self.app.discard_button.winfo_manager(), "pack")

        dialog = tk_app.ClockOutDialog(self.root, self.card)
        self.assertEqual(dialog.overhead_percent.cget("text"), "100 %")  # nothing assigned yet
        dialog.group_vars["moonstone ring"].set("45")
        rings = [v.get() for v in dialog._vars_named("moonstone ring")]
        self.assertEqual(rings, ["15", "15", "15"])
        self.assertIn("TimeOverhead 55%", dialog.total.cget("text"))
        self.assertEqual(dialog.overhead_minutes.cget("text"), "1h 06m")

        hoops = next(i for i in dialog.candidates if i["name"] == "Hoop earrings")
        dialog.item_vars[hoops["id"]].set("40")
        dialog.spread_rest()  # the cuff is the only blank row
        cuff = next(i for i in dialog.candidates if i["name"] == "Cuff")
        self.assertEqual(dialog.item_vars[cuff["id"]].get(), "15")
        self.assertIn("Pieces 100%", dialog.total.cget("text"))
        self.assertEqual(dialog.overhead_percent.cget("text"), "0 %")
        self.assertEqual(dialog.minute_labels[hoops["id"]].cget("text"), "0h 48m")

        # typing in one ring makes the "all three" figure stale
        dialog._vars_named("moonstone ring")[0].set("15")
        self.assertEqual(dialog.group_vars["moonstone ring"].get(), "")

        dialog.item_vars[cuff["id"]].set("oops")
        self.assertTrue(dialog.confirm_button.instate(["disabled"]))
        dialog.item_vars[cuff["id"]].set("15")
        dialog.confirm()
        self.assertIsNone(self.card.current_session())
        self.assertAlmostEqual(self.card.get_item(hoops["id"])["total_seconds"], 2880, delta=2)
        self.assertAlmostEqual(self.card.get_item(cuff["id"])["total_seconds"], 1080, delta=2)

        self.app.refresh()
        self.assertEqual(sorted(self.bench_rows()), ["IN PROGRESS", "NOT MAKING"])
        self.assertEqual(self.app.clock_button.cget("text"), "Clock in")

    def test_unassigned_share_goes_to_time_overhead(self):
        self.add("Cuff")
        start = now().replace(second=0, microsecond=0) - timedelta(hours=4)
        self.card.clock_in(start)
        dialog = tk_app.ClockOutDialog(self.root, self.card)
        cuff = dialog.candidates[0]["id"]
        dialog.when_var.set(tk_app.when_to_text(start + timedelta(hours=2)))
        dialog.item_vars[cuff].set("120")
        self.assertTrue(dialog.confirm_button.instate(["disabled"]))
        self.assertIn("20% too much", dialog.total.cget("text"))
        dialog.item_vars[cuff].set("70")
        self.assertEqual(dialog.overhead_percent.cget("text"), "30 %")
        self.assertEqual(dialog.overhead_minutes.cget("text"), "0h 36m")
        dialog.confirm()
        self.assertEqual(self.card.get_item(cuff)["total_seconds"], 5040)
        self.assertEqual(self.card.overhead_item()["total_seconds"], 2160)
        self.assertIn("0h 36m of it to TimeOverhead", self.app.clock_out_message(dialog.record))
        self.app.refresh()
        self.assertEqual(self.app.bench.set(OVERHEAD_ID, "time"), "0h 36m")

    def test_time_overhead_row_cannot_be_finished_or_edited(self):
        self.add("Cuff")
        self.assertEqual(len(self.bench_rows()["NOT MAKING"]), 1)
        self.assertEqual(self.app.tabs.tab(self.app.bench_tab, "text"), "On the bench (1)")
        self.app.bench.selection_set(OVERHEAD_ID)
        self.root.update()
        for button in (self.app.finish_button, self.app.part_button, self.app.bench_edit):
            self.assertTrue(button.instate(["disabled"]))
        self.assertFalse(self.app.bench_log.instate(["disabled"]))
        self.app.finish_selected()
        self.assertEqual(self.app.finished.get_children(), ())

    def test_clock_out_time_can_be_corrected(self):
        self.add("Cuff")
        start = now().replace(second=0, microsecond=0) - timedelta(hours=5)
        self.card.clock_in(start)
        dialog = tk_app.ClockOutDialog(self.root, self.card)
        dialog.split_evenly()
        dialog.when_var.set("last tuesday")
        self.assertTrue(dialog.confirm_button.instate(["disabled"]))
        dialog.when_var.set(tk_app.when_to_text(start - timedelta(hours=1)))  # before clock-in
        self.assertTrue(dialog.confirm_button.instate(["disabled"]))
        dialog.when_var.set(tk_app.when_to_text(start + timedelta(hours=3)))
        dialog.confirm()
        self.assertEqual(dialog.record["seconds"], 3 * 3600)

    def test_split_evenly_weights_batches(self):
        self.add("Hoops", 6)
        self.add("Cuff")
        self.add("Pendant")
        self.card.clock_in(now() - timedelta(hours=1))
        dialog = tk_app.ClockOutDialog(self.root, self.card)
        dialog.split_evenly()
        values = {i["name"]: dialog.item_vars[i["id"]].get() for i in dialog.candidates}
        self.assertEqual(values, {"Hoops": "75", "Cuff": "12.5", "Pendant": "12.5"})
        self.assertFalse(dialog.confirm_button.instate(["disabled"]))

    def test_clock_out_with_an_empty_bench(self):
        self.card.clock_in(now() - timedelta(minutes=30))
        dialog = tk_app.ClockOutDialog(self.root, self.card)
        self.assertFalse(dialog.confirm_button.instate(["disabled"]))
        dialog.confirm()
        self.assertIsNone(self.card.current_session())
        self.assertAlmostEqual(self.card.overhead_item()["total_seconds"], 1800, delta=2)

    def test_mark_finished_reopen_and_export(self):
        self.add("Moonstone ring", 3, separate=True)
        ids = list(self.app.items)
        self.assertTrue(self.app.finish_button.instate(["disabled"]))
        self.app.bench.selection_set(ids[:2])
        self.root.update()
        self.assertFalse(self.app.finish_button.instate(["disabled"]))
        self.app.finish_selected()
        self.assertEqual(len(self.app.finished.get_children()), 2)
        self.assertEqual(self.app.tabs.tab(self.app.finished_tab, "text"), "Finished (2)")
        self.assertEqual(self.card.get_item(ids[0])["status"], FINISHED)

        out = Path(self.tmp.name, "out.csv")
        self.app.export("finished", str(out))
        with open(out, newline="", encoding="utf-8") as f:
            self.assertEqual(len(list(csv.DictReader(f))), 2)

        self.app.finished.selection_set(ids[0])
        self.app.reopen_selected()
        self.assertEqual(len(self.app.finished.get_children()), 1)

    def test_quantity_buttons(self):
        for change, expected in ((1, "2"), (1, "3"), (-1, "2"), (-1, "1"), (-1, "1")):  # never below 1
            self.app._step_quantity(change)
            self.assertEqual(self.app.add_qty.get(), expected)
        self.app.add_qty.set("lots")
        self.app._step_quantity(1)
        self.assertEqual(self.app.add_qty.get(), "1")

    def test_finish_some_button_only_for_a_single_batch(self):
        self.add("Hoops", 6)
        self.add("Cuff")
        hoops, cuff = (next(i for i in self.app.items.values() if i["name"] == n)["id"] for n in ("Hoops", "Cuff"))
        for selection, enabled in (([hoops], True), ([cuff], False), ([hoops, cuff], False)):
            self.app.bench.selection_set(selection)
            self.root.update()
            self.assertEqual(not self.app.part_button.instate(["disabled"]), enabled, selection)

    def test_edit_dialog_saves(self):
        self.add("Cuff")
        item = next(iter(self.app.items.values()))
        dialog = tk_app.EditDialog(self.root, self.card, item)
        dialog.name_var.set("Hammered cuff")
        dialog.notes.insert("1.0", "Commission")
        dialog.save()
        saved = self.card.get_item(item["id"])
        self.assertEqual((saved["name"], saved["notes"]), ("Hammered cuff", "Commission"))


if __name__ == "__main__":
    unittest.main()
