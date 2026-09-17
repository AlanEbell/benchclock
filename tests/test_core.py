import csv
import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from jewelry_timecard.core import FINISHED, IN_PROGRESS, NOT_STARTED, TimeCard, TimeCardError, now


class TimeCardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.card = TimeCard(self.tmp.name)
        self.start = now().replace(microsecond=0) - timedelta(hours=2)

    def tearDown(self):
        self.tmp.cleanup()

    def test_batch_vs_separate_pieces(self):
        (batch,) = self.card.add_item("Hoop earrings", quantity=6)
        singles = self.card.add_item("Moonstone ring", quantity=3, separate=True)
        self.assertEqual(batch["quantity"], 6)
        self.assertEqual([s["quantity"] for s in singles], [1, 1, 1])
        self.assertEqual(len({s["id"] for s in singles}), 3)
        self.assertEqual(len(list(Path(self.tmp.name, "items").glob("*.json"))), 4)

    def test_clock_out_splits_time_by_percent(self):
        (ring,) = self.card.add_item("Ring")
        (hoops,) = self.card.add_item("Hoops", quantity=4)
        (idle,) = self.card.add_item("Untouched")
        self.card.clock_in(self.start)
        self.card.clock_out({ring["id"]: 25, hoops["id"]: 75}, self.start + timedelta(hours=2))

        ring, hoops, idle = (self.card.get_item(i["id"]) for i in (ring, hoops, idle))
        self.assertEqual(ring["total_seconds"], 1800)
        self.assertEqual(hoops["total_seconds"], 5400)
        self.assertEqual(hoops["seconds_per_piece"], 1350)
        self.assertEqual(ring["status"], IN_PROGRESS)
        self.assertEqual(idle["status"], NOT_STARTED)
        self.assertIsNone(self.card.current_session())
        self.assertEqual(len(list(Path(self.tmp.name, "sessions").glob("*.json"))), 1)

    def test_percentages_must_total_100(self):
        (ring,) = self.card.add_item("Ring")
        self.card.clock_in(self.start)
        with self.assertRaises(TimeCardError):
            self.card.clock_out({ring["id"]: 80})
        with self.assertRaises(TimeCardError):
            self.card.clock_out({})
        self.assertIsNotNone(self.card.current_session())  # still clocked in

    def test_thirds_are_accepted(self):
        ids = [i["id"] for i in self.card.add_item("Ring", 3, separate=True)]
        self.card.clock_in(self.start)
        self.card.clock_out({ids[0]: 33.33, ids[1]: 33.33, ids[2]: 33.34}, self.start + timedelta(hours=1))
        total = sum(self.card.get_item(i)["total_seconds"] for i in ids)
        self.assertAlmostEqual(total, 3600, delta=0.5)

    def test_clock_out_with_empty_bench(self):
        self.card.clock_in(self.start)
        record = self.card.clock_out({})
        self.assertEqual(record["allocations"], [])

    def test_double_clock_in_rejected(self):
        self.card.clock_in()
        with self.assertRaises(TimeCardError):
            self.card.clock_in()

    def test_piece_finished_mid_session_can_still_get_time(self):
        (ring,) = self.card.add_item("Ring")
        (old,) = self.card.add_item("Old pendant")
        self.card.finish_items([old["id"]], self.start - timedelta(days=1))
        self.card.clock_in(self.start)
        self.card.finish_items([ring["id"]])
        candidates = [c["id"] for c in self.card.clock_out_candidates()]
        self.assertEqual(candidates, [ring["id"]])
        self.card.clock_out({ring["id"]: 100})
        ring = self.card.get_item(ring["id"])
        self.assertEqual(ring["status"], FINISHED)  # logging time doesn't reopen it
        self.assertGreater(ring["total_seconds"], 0)

    def test_finish_part_of_batch_carries_its_share_of_time(self):
        (hoops,) = self.card.add_item("Hoops", quantity=4)
        self.card.clock_in(self.start)
        self.card.clock_out({hoops["id"]: 100}, self.start + timedelta(hours=2))
        done = self.card.finish_part_of_batch(hoops["id"], 1)
        rest = self.card.get_item(hoops["id"])
        self.assertEqual((done["quantity"], done["status"], done["total_seconds"]), (1, FINISHED, 1800))
        self.assertEqual((rest["quantity"], rest["status"], rest["total_seconds"]), (3, IN_PROGRESS, 5400))
        self.assertEqual(done["split_from"], hoops["id"])
        with self.assertRaises(TimeCardError):
            self.card.finish_part_of_batch(hoops["id"], 9)

    def test_reopen(self):
        (ring,) = self.card.add_item("Ring")
        self.card.finish_items([ring["id"]])
        self.card.reopen_item(ring["id"])
        self.assertEqual(self.card.get_item(ring["id"])["status"], NOT_STARTED)

    def test_csv_export(self):
        (hoops,) = self.card.add_item("Hoops, large", quantity=2, sku="H-1")
        self.card.clock_in(self.start)
        self.card.clock_out({hoops["id"]: 100}, self.start + timedelta(minutes=90))
        out = Path(self.tmp.name, "out.csv")
        self.assertEqual(self.card.export_csv(out), 1)
        with open(out, newline="", encoding="utf-8") as f:
            (row,) = list(csv.DictReader(f))
        self.assertEqual(row["name"], "Hoops, large")
        self.assertEqual(row["total_hours"], "1.5")
        self.assertEqual(row["minutes_per_piece"], "45.0")

    def test_item_file_is_plain_json(self):
        (ring,) = self.card.add_item("Ring")
        data = json.loads(Path(self.tmp.name, "items", ring["id"] + ".json").read_text())
        self.assertEqual(data["name"], "Ring")
        self.assertIn("total_seconds", data)


if __name__ == "__main__":
    unittest.main()
