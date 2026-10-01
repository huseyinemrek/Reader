"""Private JSON-lines CUDA worker. Documents stay on this machine."""
import base64
from collections import OrderedDict
from functools import cmp_to_key
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import traceback

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch
import numpy as np
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForObjectDetection, AutoProcessor, GlmOcrForConditionalGeneration

MODEL_ID = "zai-org/GLM-OCR"
MODEL_REVISION = "2e85a62840ccac27daa451df36c736c4636b8628"
LAYOUT_ID = "PaddlePaddle/PP-DocLayoutV3_safetensors"
LAYOUT_REVISION = "e4f489dc536556fc1be02b973ba06756e0d4a2ac"
BATCH_SIZE = 4
MAX_NEW_TOKENS = 2048
PROMPTS = {"text": "Text Recognition:", "formula": "Formula Recognition:", "table": "Table Recognition:"}
PROMPTS["formula_prose"] = "Text Recognition: Preserve natural word spaces in equation prose using LaTeX \\text{}."
LETTER_SPELLED_PROSE = re.compile(r"(?<!\w)(?:[^\W\d_][ \t]+){12,}[^\W\d_](?!\w)")
CACHE_ENTRIES = 128
CACHE_TEXT_BYTES = 4 * 1024 * 1024
MATH_SLOTS = re.compile(r"(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|(?<![\\$])\$(?!\$)[\s\S]+?(?<![\\$])\$(?!\$)")


class DocumentOcr:
    def __init__(self):
        self.processor = self.model = self.layout_processor = self.layout_model = None
        self.plan = None
        self.plan_id = 0
        self.cache = OrderedDict()
        self.cache_bytes = 0
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        requested = os.environ.get("OCR_DEVICE", "auto")
        if requested not in ("auto", "cuda", "cpu"):
            raise ValueError("OCR_DEVICE must be auto, cuda, or cpu.")
        cuda = torch.cuda.is_available()
        if requested == "cuda" and not cuda:
            raise RuntimeError("OCR_DEVICE=cuda requires an available NVIDIA CUDA GPU.")
        self.device = "cuda:0" if requested != "cpu" and cuda else "cpu"
        if self.device.startswith("cuda") and not torch.cuda.is_bf16_supported():
            raise RuntimeError("CUDA document OCR requires BF16 support.")
        self.dtype = torch.bfloat16 if self.device.startswith("cuda") else torch.float32

    def load_recognizer(self):
        if self.model is None:
            self.processor = AutoProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
            self.processor.tokenizer.padding_side = "left"
            self.model = GlmOcrForConditionalGeneration.from_pretrained(
                MODEL_ID, revision=MODEL_REVISION, dtype=self.dtype,
                attn_implementation="sdpa",
            ).to(self.device).eval()

    def prepare(self):
        self.load_recognizer()
        if self.layout_model is None:
            self.layout_processor = AutoImageProcessor.from_pretrained(LAYOUT_ID, revision=LAYOUT_REVISION)
            self.layout_model = AutoModelForObjectDetection.from_pretrained(
                LAYOUT_ID, revision=LAYOUT_REVISION,
            ).to(self.device).eval()
        device = torch.cuda.get_device_name(0) + " / CUDA BF16 SDPA" if self.device.startswith("cuda") else "CPU FP32 SDPA"
        return {"engine": "GLM-OCR + PP-DocLayoutV3", "device": device, "modelRevision": MODEL_REVISION + ":" + LAYOUT_REVISION}

    @torch.inference_mode()
    def recognize(self, images, kinds):
        self.load_recognizer()
        messages = [[{"role": "user", "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": PROMPTS[kind]},
        ]}] for image, kind in zip(images, kinds)]
        inputs = self.processor.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True, return_dict=True,
            return_tensors="pt", processor_kwargs={"padding": True, "padding_side": "left"},
        ).to(self.device)
        outputs = self.model.generate(
            **inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=False, use_cache=True,
        )
        generated = outputs[:, inputs.input_ids.shape[-1]:]
        eos = self.model.generation_config.eos_token_id
        eos = eos if isinstance(eos, list) else [eos]
        for row in generated:
            # EOS can precede padding in a batch; reaching the limit alone is not proof of truncation.
            if not any(bool((row == token).any()) for token in eos):
                raise RuntimeError(f"OCR output truncated at {MAX_NEW_TOKENS} tokens; refusing incomplete content.")
        return self.processor.batch_decode(generated, skip_special_tokens=True)

    @staticmethod
    def decode_image(request):
        image = Image.open(io.BytesIO(base64.b64decode(request["image"], validate=True))).convert("RGB")
        if request.get("width", image.width) != image.width or request.get("height", image.height) != image.height:
            raise ValueError("PNG dimensions do not match the requested source coordinates.")
        return image

    @staticmethod
    def box_order(left, right):
        a, b = left["bbox"], right["bbox"]
        overlap = min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
        same_line = overlap >= min(a["y1"]-a["y0"], b["y1"]-b["y0"]) / 2
        ka = a["x0"] if same_line else (a["y0"]+a["y1"]) / 2
        kb = b["x0"] if same_line else (b["y0"]+b["y1"]) / 2
        return (ka > kb) - (ka < kb)

    @staticmethod
    def text_windows(image, region):
        """Split only at white source rows, never through a glyph or nested formula."""
        box = region["bbox"]
        line_windows = region["layoutLabel"] == "algorithm" or len(region.get("nestedFormulas", [])) > 1
        if region["kind"] != "text" or (box["y1"]-box["y0"] <= 700 and not line_windows):
            return [dict(box)]
        crop = image.crop((box["x0"], box["y0"], box["x1"], box["y1"])).convert("L")
        pixels = np.asarray(crop)
        # Algorithm boxes often have a narrow vertical frame. Exclude only that
        # edge from whitespace analysis, not from the source window itself.
        inset = 6 if region["layoutLabel"] == "algorithm" and crop.width > 24 else 0
        interior = pixels[:, inset:crop.width-inset] if inset else pixels
        white_rows = np.flatnonzero(np.count_nonzero(interior < 200, axis=1) == 0)
        content_rows = np.flatnonzero(np.count_nonzero(interior < 200, axis=1) > 0)
        if inset:
            content_rows = content_rows[(content_rows >= inset) & (content_rows < crop.height-inset)]
        first_ink = box["y0"]+int(content_rows[0]) if len(content_rows) else box["y0"]
        last_ink = box["y0"]+int(content_rows[-1]) if len(content_rows) else box["y1"]
        crop.close()
        gaps = []
        gap_sizes = {}
        for rows in np.split(white_rows, np.flatnonzero(np.diff(white_rows) > 1)+1):
            if len(rows) >= (2 if line_windows else 5):
                y = box["y0"] + int(rows[len(rows)//2])
                if first_ink < y < last_ink and box["y0"]+5 < y < box["y1"]-5 and not any(
                        item["bbox"]["y0"] <= y <= item["bbox"]["y1"] for item in region.get("nestedFormulas", [])):
                    gaps.append(y)
                    gap_sizes[y] = len(rows)
        # A substantially larger source gap is a paragraph boundary; ordinary
        # line gaps and inference-window boundaries are only soft wrapping.
        typical_gap = float(np.median(list(gap_sizes.values()))) if gap_sizes else 0
        paragraph_cuts = {y for y, size in gap_sizes.items() if size >= max(typical_gap * 1.7, typical_gap + 4)}
        region["paragraphCuts"] = paragraph_cuts
        cuts = [box["y0"]]
        if line_windows:
            cuts.extend(gaps)
        else:
            while box["y1"]-cuts[-1] > 700:
                candidates = [y for y in gaps if cuts[-1]+250 < y < cuts[-1]+650]
                if not candidates:
                    break
                paragraph_candidates = [y for y in candidates if y in paragraph_cuts]
                cuts.append(min(paragraph_candidates or candidates, key=lambda y: abs(y-(cuts[-1]+450))))
        cuts.append(box["y1"])
        return [{"x0": box["x0"], "y0": a, "x1": box["x1"], "y1": b}
                for a, b in zip(cuts, cuts[1:])]

    def algorithm_windows(self, image, region, boxes):
        """Let the layout model identify math inside an algorithm, then retain source-row coverage."""
        bounds = region["bbox"]
        if bounds["x1"]-bounds["x0"] <= 24 or bounds["y1"]-bounds["y0"] <= 24:
            return [{"kind": "text", "bbox": box} for box in boxes]
        x0, y0, x1, y1 = bounds["x0"]+6, bounds["y0"]+6, bounds["x1"]-6, bounds["y1"]-6
        crop = image.crop((x0, y0, x1, y1))
        try:
            inputs = self.layout_processor(images=crop, return_tensors="pt").to(self.device)
            detections = self.layout_processor.post_process_object_detection(
                self.layout_model(**inputs), target_sizes=[crop.size[::-1]], threshold=0.5,
            )[0]
            formulas = []
            for label_id, detected in zip(detections["labels"], detections["boxes"]):
                if self.layout_model.config.id2label[label_id.item()] != "formula":
                    continue
                a, b, c, d = detected.tolist()
                formulas.append({"x0": max(x0, x0+math.floor(a)), "y0": max(y0, y0+math.floor(b)),
                                 "x1": min(x1, x0+math.ceil(c)), "y1": min(y1, y0+math.ceil(d))})
        finally:
            crop.close()
        result = []
        for box in boxes:
            matches = []
            for formula in formulas:
                height = formula["y1"]-formula["y0"]
                overlap = min(box["y1"], formula["y1"])-max(box["y0"], formula["y0"])
                if height > 0 and overlap >= height * 0.9:
                    matches.append(formula)
            if len(matches) != 1:
                result.append({"kind": "text", "bbox": box})
                continue
            formula = matches[0]
            left, right = max(x0, formula["x0"]-3), min(x1, formula["x1"]+3)
            row = image.crop((x0, box["y0"], x1, box["y1"])).convert("L")
            pixels = np.asarray(row)
            # A narrow formula crop is safe only when no other source glyph is
            # present in this row. Otherwise preserve the full Text Recognition window.
            outside_ink = np.any(pixels[:, :left-x0] < 200) or np.any(pixels[:, right-x0:] < 200)
            row.close()
            if outside_ink:
                result.append({"kind": "text", "bbox": box})
            else:
                formula_box = {"x0": left, "y0": box["y0"], "x1": right, "y1": box["y1"]}
                if right-left > (bounds["x1"]-bounds["x0"]) * 0.6 and box["y1"]-box["y0"] > 55:
                    # Wide multi-line algorithm math can include prose (cases,
                    # conditions). Keep a context-bearing text read as well.
                    result.append({"kind": "text", "bbox": box, "contextFormula": formula_box})
                else:
                    result.append({"kind": "formula", "algorithmMath": True, "bbox": formula_box})
        return result

    @torch.inference_mode()
    def layout(self, request):
        metadata = self.prepare()
        started = time.perf_counter()
        if self.plan is not None:
            self.plan["image"].close()
            self.plan = None
        image = self.decode_image(request)
        try:
            inputs = self.layout_processor(images=image, return_tensors="pt").to(self.device)
            outputs = self.layout_model(**inputs)
            detections = self.layout_processor.post_process_object_detection(
                outputs, target_sizes=[image.size[::-1]], threshold=0.5,
            )[0]
            regions = []
            # The detector returns reading order. Keep that order for top-level content.
            for label_id, box in zip(detections["labels"], detections["boxes"]):
                label = self.layout_model.config.id2label[label_id.item()]
                x0, y0, x1, y1 = box.tolist()
                x0, y0 = max(0, math.floor(x0)), max(0, math.floor(y0))
                x1, y1 = min(image.width, math.ceil(x1)), min(image.height, math.ceil(y1))
                if x1 <= x0 or y1 <= y0:
                    continue
                kind = "formula" if label == "formula" else "table" if label == "table" else "figure" if label in ("image", "chart", "seal") else "text"
                regions.append({"kind": kind, "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                                "content": "", "layoutLabel": label})
            if not regions:
                raise RuntimeError("Layout model found no document regions; refusing a silent full-page fallback.")
            nested = set()
            for index, region in enumerate(regions):
                if region["kind"] != "formula":
                    continue
                box = region["bbox"]
                area = (box["x1"]-box["x0"]) * (box["y1"]-box["y0"])
                parents = []
                for parent in regions:
                    if parent["kind"] != "text":
                        continue
                    bounds = parent["bbox"]
                    overlap = max(0, min(box["x1"], bounds["x1"])-max(box["x0"], bounds["x0"])) * max(0, min(box["y1"], bounds["y1"])-max(box["y0"], bounds["y0"]))
                    if overlap >= area * 0.9:
                        parents.append(parent)
                if parents:
                    parent = min(parents, key=lambda p: (p["bbox"]["x1"]-p["bbox"]["x0"])*(p["bbox"]["y1"]-p["bbox"]["y0"]))
                    bounds = parent["bbox"]
                    clipped = {key: max(box[key], bounds[key]) if key.endswith("0") else min(box[key], bounds[key])
                               for key in box}
                    parent.setdefault("nestedFormulas", []).append({"bbox": clipped, "kind": "formula", "layoutLabel": "formula"})
                    nested.add(index)
            regions = [region for index, region in enumerate(regions) if index not in nested]
            windows = []
            for region_index, region in enumerate(regions):
                if region["kind"] == "figure":
                    continue
                region.get("nestedFormulas", []).sort(key=cmp_to_key(self.box_order))
                boxes = self.text_windows(image, region)
                pieces = self.algorithm_windows(image, region, boxes) if region["layoutLabel"] == "algorithm" else [
                    {"kind": region["kind"], "bbox": box} for box in boxes]
                paragraph_cuts = region.pop("paragraphCuts", set())
                structured = region["layoutLabel"] in ("algorithm", "code", "poetry", "verse")
                if structured:
                    region["preserveWhitespace"] = True
                for piece in pieces:
                    context_formula = piece.pop("contextFormula", None)
                    if context_formula:
                        region.setdefault("nestedFormulas", []).append({"kind": "formula", "bbox": context_formula, "layoutLabel": "formula"})
                    separator = "\n" if structured else "\n\n" if piece["bbox"]["y0"] in paragraph_cuts else " "
                    windows.append({"id": len(windows), "regionIndex": region_index, **piece,
                                    "separatorBefore": separator,
                                    "layoutLabel": region["layoutLabel"], "parentBBox": region["bbox"]})
                for formula in region.get("nestedFormulas", []):
                    formula["windowId"] = len(windows)
                    windows.append({"id": len(windows), "regionIndex": region_index, **formula,
                                    "parentBBox": region["bbox"], "inline": True})
            if self.device.startswith("cuda"):
                torch.cuda.synchronize()
            self.plan_id += 1
            self.plan = {"image": image, "regions": regions, "windows": windows,
                         "width": image.width, "height": image.height, **metadata,
                         "layoutMs": round((time.perf_counter()-started)*1000)}
            return {"planId": self.plan_id, "windows": windows, "width": image.width, "height": image.height}
        except Exception:
            image.close()
            raise

    @staticmethod
    def unwrap_formula(text):
        for opening, closing in (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$")):
            if text.startswith(opening) and text.endswith(closing):
                return text[len(opening):-len(closing)].strip()
        return text

    def remember(self, key, text):
        size = len(text.encode("utf-8"))
        if size > CACHE_TEXT_BYTES:
            return
        self.cache[key] = text
        self.cache_bytes += size
        while len(self.cache) > CACHE_ENTRIES or self.cache_bytes > CACHE_TEXT_BYTES:
            _, evicted = self.cache.popitem(last=False)
            self.cache_bytes -= len(evicted.encode("utf-8"))

    def infer_windows(self, items):
        """Cache only complete successful inference, keyed by exact crop pixels and prompt."""
        results, missing, cache_hits = {}, {}, 0
        for window, image in items:
            digest = hashlib.sha256()
            digest.update(window["kind"].encode())
            digest.update(str(image.size).encode())
            digest.update(image.tobytes())
            key = digest.digest()
            if key in self.cache:
                self.cache.move_to_end(key)
                results[window["id"]] = self.cache[key]
                cache_hits += 1
            elif key in missing:
                missing[key][2].append(window["id"])
                cache_hits += 1
            else:
                missing[key] = (window, image, [window["id"]])
        pending = sorted(missing.items(), key=lambda item: (item[1][0]["kind"], item[1][1].width*item[1][1].height))
        for offset in range(0, len(pending), BATCH_SIZE):
            batch = pending[offset:offset+BATCH_SIZE]
            contents = self.recognize([item[1][1] for item in batch], [item[1][0]["kind"] for item in batch])
            if len(contents) != len(batch):
                raise RuntimeError("OCR returned an incomplete batch.")
            # Formula-task TeX can spell long prose labels as individual letters,
            # losing every word boundary. Re-read the same genuine source crop
            # with an explicit prose-aware task; never guess spaces or words.
            prose_indices = [index for index, (_, (window, _, _)) in enumerate(batch)
                             if window["kind"] == "formula" and LETTER_SPELLED_PROSE.search(contents[index])]
            if prose_indices:
                contextual = self.recognize([batch[index][1][1] for index in prose_indices],
                                            ["formula_prose"] * len(prose_indices))
                if len(contextual) != len(prose_indices):
                    raise RuntimeError("OCR returned incomplete equation prose.")
                for index, content in zip(prose_indices, contextual):
                    if MATH_SLOTS.fullmatch(content.strip()) is None:
                        raise RuntimeError("Prose-aware formula recognition returned no complete math envelope.")
                    contents[index] = content
            for (key, (window, _, ids)), content in zip(batch, contents):
                content = content.strip()
                if window["kind"] == "formula" and not self.unwrap_formula(content):
                    raise RuntimeError(f"OCR returned an empty formula for source window {window.get('bbox')}.")
                if not content:
                    raise RuntimeError(f"OCR returned empty content for source window {window['bbox']}.")
                self.remember(key, content)
                for window_id in ids:
                    results[window_id] = content
        return results, cache_hits

    def regions(self, request):
        if self.plan is None or request.get("planId") != self.plan_id:
            raise ValueError("OCR source plan is missing or stale.")
        plan, self.plan = self.plan, None
        started = time.perf_counter()
        items = []
        try:
            supplied = request.get("images", [])
            rendered = {item["id"]: item for item in supplied}
            if len(rendered) != len(supplied) or (rendered and set(rendered) != {item["id"] for item in plan["windows"]}):
                raise ValueError("Rendered source windows do not match the OCR plan.")
            for window in plan["windows"]:
                if rendered:
                    image = self.decode_image(rendered[window["id"]])
                else:
                    # Diagnostic fallback uses genuine PNG pixels, never a fabricated OCR result.
                    box, bounds = window["bbox"], window["parentBBox"]
                    image = plan["image"].crop((max(bounds["x0"], box["x0"]-3), max(bounds["y0"], box["y0"]-3),
                                                min(bounds["x1"], box["x1"]+3), min(bounds["y1"], box["y1"]+3)))
                items.append((window, image))
            contents, cache_hits = self.infer_windows(items)
            quality_limits = []
            for index, region in enumerate(plan["regions"]):
                if region["kind"] == "figure":
                    continue
                windows = [w for w in plan["windows"] if w["regionIndex"] == index and not w.get("inline")]
                parts, cursor, annotations, offsets = [], 0, [], {}
                for window in windows:
                    if parts:
                        separator = window.get("separatorBefore", "\n")
                        parts.append(separator)
                        cursor += len(separator)
                    text = contents[window["id"]]
                    parts.append(text)
                    length = len(text.encode("utf-16-le")) // 2
                    offsets[window["id"]] = cursor
                    if window.get("algorithmMath"):
                        slot = MATH_SLOTS.fullmatch(text)
                        if slot is None:
                            raise RuntimeError(f"Algorithm formula window {window['bbox']} returned no complete model math envelope; refusing untyped or incomplete algorithm math.")
                        annotations.append({"start": cursor, "end": cursor+length,
                                            "latex": self.unwrap_formula(text), "bbox": window["bbox"]})
                    cursor += length
                region["content"] = "".join(parts)
                formulas = region.pop("nestedFormulas", [])
                if not formulas:
                    if annotations:
                        region["inlineMath"] = annotations
                    continue
                for window in windows:
                    if window.get("algorithmMath"):
                        continue
                    source_formulas = [f for f in formulas if window["bbox"]["y0"] <= f["bbox"]["y0"] and f["bbox"]["y1"] <= window["bbox"]["y1"]]
                    text = contents[window["id"]]
                    slots = list(MATH_SLOTS.finditer(text))
                    invalid_order = False
                    for previous, current in zip(source_formulas, source_formulas[1:]):
                        a, b = previous["bbox"], current["bbox"]
                        overlap = min(a["y1"], b["y1"])-max(a["y0"], b["y0"])
                        if overlap >= min(a["y1"]-a["y0"], b["y1"]-b["y0"]) / 2:
                            invalid_order |= b["x0"] < a["x1"]
                        else:
                            invalid_order |= b["y0"] < a["y0"] or b["y0"]+b["y1"] <= a["y0"]+a["y1"]
                    if len(slots) != len(source_formulas) or invalid_order:
                        reason = "ambiguous or overlapping detected formula reading order" if invalid_order else f"{len(source_formulas)} detected formula ROIs but {len(slots)} model math slots"
                        limit = f"Source region {region['bbox']}: {reason} in text window {window['bbox']}; preserved model paragraph without guessed substitutions."
                        region.setdefault("qualityLimits", []).append(limit)
                        quality_limits.append(limit)
                        continue
                    disagreement = any(
                        re.sub(r"\s+", "", self.unwrap_formula(slot.group())) !=
                        re.sub(r"\s+", "", self.unwrap_formula(contents[formula["windowId"]]))
                        for slot, formula in zip(slots, source_formulas))
                    if disagreement:
                        limit = f"Source region {region['bbox']}: Text Recognition and Formula Recognition disagree in window {window['bbox']}; preserved context-bearing model text without unverified formula substitutions."
                        region.setdefault("qualityLimits", []).append(limit)
                        quality_limits.append(limit)
                        continue
                    base = offsets[window["id"]]
                    for slot, formula in zip(slots, source_formulas):
                        annotations.append({"start": base + len(text[:slot.start()].encode("utf-16-le")) // 2,
                                            "end": base + len(text[:slot.end()].encode("utf-16-le")) // 2,
                                            "latex": self.unwrap_formula(contents[formula["windowId"]]),
                                            "bbox": formula["bbox"]})
                if annotations:
                    region["inlineMath"] = sorted(annotations, key=lambda item: item["start"])
            if self.device.startswith("cuda"):
                torch.cuda.synchronize()
            recognition_ms = round((time.perf_counter()-started)*1000)
            metadata = {key: plan[key] for key in ("engine", "device", "modelRevision", "width", "height")}
            return {**metadata, "elapsedMs": plan["layoutMs"]+recognition_ms, "regions": plan["regions"],
                    "qualityLimits": quality_limits, "metrics": {"layoutMs": plan["layoutMs"], "recognitionMs": recognition_ms,
                    "windowCount": len(items), "textWindows": sum(w["kind"] == "text" for w, _ in items),
                    "formulaWindows": sum(w["kind"] == "formula" for w, _ in items), "cacheHits": cache_hits}}
        finally:
            for _, image in items:
                image.close()
            plan["image"].close()

    def formula(self, request):
        image = self.decode_image(request)
        try:
            contents, _ = self.infer_windows([({"id": 0, "kind": "formula"}, image)])
            return self.unwrap_formula(contents[0])
        finally:
            image.close()


def main():
    # CLI diagnostics use stderr; importing DocumentOcr leaves host stdout alone.
    protocol = sys.stdout
    sys.stdout = sys.stderr
    runtime = None
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            operation = request["op"]
            if operation == "shutdown":
                protocol.write(json.dumps({"id": request["id"], "result": True}) + "\n")
                protocol.flush()
                break
            if runtime is None:
                runtime = DocumentOcr()
            if operation == "prepare":
                result = runtime.prepare()
            elif operation == "layout":
                result = runtime.layout(request)
            elif operation == "regions":
                result = runtime.regions(request)
            elif operation == "formula":
                result = runtime.formula(request)
            else:
                raise ValueError("Unknown OCR operation.")
            response = {"id": request["id"], "result": result}
        except Exception as error:
            if "Layout model found no document regions" in str(error):
                sys.stderr.write(f"Document OCR note: {error}\n")
            else:
                traceback.print_exc(file=sys.stderr)
            response = {"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)}
        protocol.write(json.dumps(response, ensure_ascii=False) + "\n")
        protocol.flush()


if __name__ == "__main__":
    main()
