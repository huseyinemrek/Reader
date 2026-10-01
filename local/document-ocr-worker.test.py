"""Source-window behavior tests; run with the OCR Python environment."""
import importlib.util
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw

host_stdout = sys.stdout
spec = importlib.util.spec_from_file_location("document_ocr_worker", Path(__file__).with_name("document-ocr-worker.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceWindowTests(unittest.TestCase):
    def test_import_preserves_host_stdout(self):
        self.assertIs(sys.stdout, host_stdout)

    def test_long_prose_prefers_a_real_paragraph_gap_to_a_physical_line_gap(self):
        image = Image.new("RGB", (300, 1000), "white")
        try:
            draw = ImageDraw.Draw(image)
            rows = [y for y in range(20, 950, 40) if y != 380]
            for y in rows:
                draw.rectangle((20, y, 270, y + 11), fill="black")
            region = {"kind": "text", "layoutLabel": "text",
                      "bbox": {"x0": 0, "y0": 0, "x1": 300, "y1": 1000}}
            windows = module.DocumentOcr.text_windows(image, region)
            self.assertGreater(windows[0]["y1"], 351)
            self.assertLess(windows[0]["y1"], 420)
            for y in rows:
                owners = [box for box in windows if box["y0"] <= y and y + 12 <= box["y1"]]
                self.assertEqual(len(owners), 1, "every complete source line must belong to one window")
        finally:
            image.close()

    def test_algorithm_windows_never_cut_a_glyph_or_nested_formula(self):
        image = Image.new("RGB", (300, 200), "white")
        try:
            draw = ImageDraw.Draw(image)
            for y in (20, 60, 100, 140):
                draw.rectangle((20, y, 270, y + 11), fill="black")
            region = {"kind": "text", "layoutLabel": "algorithm",
                      "bbox": {"x0": 0, "y0": 0, "x1": 300, "y1": 200},
                      "nestedFormulas": [{"bbox": {"x0": 20, "y0": 60, "x1": 270, "y1": 112}}]}
            windows = module.DocumentOcr.text_windows(image, region)
            self.assertTrue(any(box["y0"] <= 60 and box["y1"] >= 112 for box in windows))
            for box in windows[:-1]:
                self.assertNotIn(box["y1"], range(60, 113))
                self.assertEqual(image.getpixel((20, box["y1"])), (255, 255, 255))
        finally:
            image.close()


if __name__ == "__main__":
    unittest.main()
