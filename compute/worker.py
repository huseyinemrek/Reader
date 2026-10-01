"""On-demand outbound-only CUDA OCR worker; shares the local pinned OCR engine."""
from __future__ import annotations

import argparse
import base64
import gc
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit

import httpx
import numpy as np
from dotenv import load_dotenv
from PIL import Image
import pymupdf

PIPELINE_VERSION = 15
BORDER = 12
MAX_WINDOW_PIXELS = 1_600_000
MAX_WINDOW_EDGE = 2400
ROOT = Path(__file__).resolve().parent.parent


class WorkerError(Exception):
    pass

class ApiError(WorkerError):
    pass



class LeaseLost(WorkerError):
    pass


def number(name, default, minimum=0.1):
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        raise WorkerError(f"{name} must be a number.") from None
    if not math.isfinite(value) or value < minimum:
        raise WorkerError(f"{name} must be at least {minimum}.")
    return value


def load_engine():
    if os.environ.get("OCR_DEVICE", "cuda") != "cuda":
        raise WorkerError("The compute worker requires OCR_DEVICE=cuda; CPU fallback is forbidden.")
    os.environ["OCR_DEVICE"] = "cuda"
    spec = importlib.util.spec_from_file_location("reader_document_ocr", ROOT / "local" / "document-ocr-worker.py")
    if spec is None or spec.loader is None:
        raise WorkerError("The shared local/document-ocr-worker.py engine is unavailable.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, module.DocumentOcr()


def release_engine(module, engine):
    if engine is not None:
        if engine.plan is not None:
            engine.plan["image"].close()
            engine.plan = None
        engine.cache.clear()
        engine.processor = engine.model = engine.layout_processor = engine.layout_model = None
    gc.collect()
    if module is not None and module.torch.cuda.is_available():
        module.torch.cuda.empty_cache()


def encode_png(image):
    import io
    with io.BytesIO() as buffer:
        image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")


def row_height(pixels, box):
    crop = pixels[box["y0"]:box["y1"], box["x0"]:box["x1"]]
    threshold = max(2, math.ceil(crop.shape[1] * 0.008))
    ink = np.count_nonzero(np.min(crop, axis=2) < 190, axis=1) >= threshold
    edges = np.diff(np.concatenate(([False], ink, [False])).astype(np.int8))
    heights = np.flatnonzero(edges == -1) - np.flatnonzero(edges == 1)
    heights = sorted(int(value) for value in heights if value >= 3)
    return heights[len(heights) // 2] if heights else crop.shape[0]


class SourcePage:
    """Render every recognition window from PDF operators, not enlarged page pixels."""
    def __init__(self, page):
        self.display = page.get_displaylist()
        self.scale = min(2.5, 3200 / max(page.rect.width, page.rect.height))
        self.width = math.ceil(page.rect.width * self.scale)
        self.height = math.ceil(page.rect.height * self.scale)
        pixmap = self.display.get_pixmap(matrix=pymupdf.Matrix(self.scale, self.scale),
                                        colorspace=pymupdf.csRGB, alpha=False)
        if (pixmap.width, pixmap.height) != (self.width, self.height):
            raise WorkerError("PDF page geometry does not match the server source dimensions.")
        self.image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
        self.pixels = np.asarray(self.image)
        self.stats = {"windows": 0, "textWindows": 0, "formulaWindows": 0, "pixels": 0, "maxPixels": 0}

    def window(self, window):
        bbox = window["bbox"]
        if any(not isinstance(bbox.get(key), (int, float)) or not math.isfinite(bbox[key])
               for key in ("x0", "y0", "x1", "y1")):
            raise WorkerError("Invalid source-window coordinates.")
        if not (0 <= bbox["x0"] < bbox["x1"] <= self.width and
                0 <= bbox["y0"] < bbox["y1"] <= self.height):
            raise WorkerError("Source window lies outside the page.")
        box = {key: math.floor(value) if key.endswith("0") else math.ceil(value)
               for key, value in bbox.items()}
        width, height = box["x1"] - box["x0"], box["y1"] - box["y0"]
        border = BORDER * 2 + 1
        a, b = width * height, border * (width + height)
        area_zoom = (math.sqrt(b * b + 4 * a * (MAX_WINDOW_PIXELS - border * border)) - b) / (2 * a)
        desired = 64 if window["kind"] == "formula" else 48
        zoom = min(4, max(1, desired / row_height(self.pixels, box)),
                   (MAX_WINDOW_EDGE - BORDER * 2) / max(width, height), area_zoom)
        output_width, output_height = math.ceil(width * zoom) + BORDER * 2, math.ceil(height * zoom) + BORDER * 2
        matrix = pymupdf.Matrix(self.scale * zoom, 0, 0, self.scale * zoom,
                               -box["x0"] * zoom, -box["y0"] * zoom)
        clip = pymupdf.Rect(box["x0"] / self.scale, box["y0"] / self.scale,
                           box["x1"] / self.scale, box["y1"] / self.scale)
        pixmap = self.display.get_pixmap(matrix=matrix, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
        with Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples) as crop:
            with Image.new("RGB", (output_width, output_height), "white") as output:
                # Clip to the content rectangle: no adjacent ink may enter the white border.
                with Image.new("RGB", (output_width - BORDER * 2, output_height - BORDER * 2), "white") as content:
                    content.paste(crop, (pixmap.x, pixmap.y))
                    output.paste(content, (BORDER, BORDER))
                encoded = encode_png(output)
        pixels = output_width * output_height
        self.stats["windows"] += 1
        self.stats["formulaWindows" if window["kind"] == "formula" else "textWindows"] += 1
        self.stats["pixels"] += pixels
        self.stats["maxPixels"] = max(self.stats["maxPixels"], pixels)
        return {"id": window["id"], "image": encoded, "width": output_width, "height": output_height}

    def close(self):
        self.pixels = None
        self.image.close()
        self.display = None


def recognize(engine, document, page_number, check):
    if not 1 <= page_number <= document.page_count:
        raise WorkerError("Claimed page is outside the PDF.")
    check()
    started = time.perf_counter()
    source = SourcePage(document[page_number - 1])
    try:
        image = encode_png(source.image)
        plan = engine.layout({"image": image, "width": source.width, "height": source.height})
        windows = []
        for window in plan["windows"]:
            check()
            windows.append(source.window(window))
        check()
        result = engine.regions({"planId": plan["planId"], "images": windows})
        result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
        result.setdefault("metrics", {})["sourceRender"] = source.stats
        return {"image": image, "result": result}
    finally:
        source.close()
        if engine.plan is not None:
            engine.plan["image"].close()
            engine.plan = None


class SshTunnel:
    """Optional encrypted outbound transport for a VPS without an HTTPS proxy."""
    def __init__(self, stopping):
        self.child = None
        self.url = None
        host = os.environ.get("SSH_HOST", "").strip()
        if not host:
            return
        user = os.environ.get("SSH_USER", "ubuntu").strip()
        key = Path(os.environ.get("SSH_KEY_FILE", "")).expanduser()
        if not user or not key.is_file() or host.startswith("-") or any(c.isspace() for c in host + user):
            raise WorkerError("SSH_HOST, SSH_USER and an existing SSH_KEY_FILE are required for the tunnel.")
        port = int(number("SSH_PORT", 22, minimum=1))
        remote_port = int(number("SSH_REMOTE_PORT", 3000, minimum=1))
        if port > 65535 or remote_port > 65535:
            raise WorkerError("SSH ports must be between 1 and 65535.")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            local_port = listener.getsockname()[1]
        command = ["ssh", "-N", "-T", "-i", str(key), "-p", str(port),
                   "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                   "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15",
                   "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
                   "-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}", f"{user}@{host}"]
        try:
            self.child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.PIPE)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if stopping.is_set():
                    raise InterruptedError("Stopped while opening the SSH tunnel.")
                if self.child.poll() is not None:
                    details = self.child.stderr.read().decode("utf-8", errors="replace").strip()
                    raise WorkerError(f"SSH tunnel failed: {details[:1000]}")
                try:
                    with socket.create_connection(("127.0.0.1", local_port), timeout=0.2):
                        self.url = f"http://127.0.0.1:{local_port}"
                        print("Using an encrypted outbound SSH tunnel; bearer token stays inside SSH.", file=sys.stderr)
                        return
                except OSError:
                    stopping.wait(0.1)
            raise WorkerError("SSH tunnel did not become ready; check host key, SSH key permissions and connectivity.")
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.child is not None:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait()
            self.child.stderr.close()
            self.child = None


class Api:
    def __init__(self, base_url=None):
        self.url = (base_url or os.environ.get("VPS_URL", "")).strip().rstrip("/")
        self.secret = os.environ.get("WORKER_SECRET", "").strip()
        parts = urlsplit(self.url)
        if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise WorkerError("VPS_URL must be an HTTPS base URL without credentials, query, or fragment.")
        try:
            loopback = parts.hostname.lower() == "localhost" or ipaddress.ip_address(parts.hostname).is_loopback
        except ValueError:
            loopback = parts.hostname.lower() == "localhost"
        unsafe = os.environ.get("ALLOW_UNSAFE_HTTP", "false").lower() == "true"
        if parts.scheme != "https" and not (parts.scheme == "http" and (loopback or unsafe)):
            raise WorkerError("HTTPS is required except loopback HTTP or explicit ALLOW_UNSAFE_HTTP=true.")
        if not self.secret or "\n" in self.secret or "\r" in self.secret:
            raise WorkerError("WORKER_SECRET must be a nonempty bearer secret.")
        self.timeout = httpx.Timeout(number("VPS_READ_TIMEOUT_SECONDS", 120),
                                     connect=number("VPS_CONNECT_TIMEOUT_SECONDS", 15),
                                     write=number("VPS_WRITE_TIMEOUT_SECONDS", 120),
                                     pool=number("VPS_CONNECT_TIMEOUT_SECONDS", 15))
        self.client = self.new_client()

    def new_client(self):
        return httpx.Client(timeout=self.timeout, headers={"Authorization": f"Bearer {self.secret}"},
                            follow_redirects=False)

    def endpoint(self, job, action):
        return f"/api/compute/jobs/{quote(str(job['id']), safe='')}/{action}"

    def request(self, method, path, payload=None, client=None):
        try:
            response = (client or self.client).request(method, self.url + path, json=payload)
        except httpx.HTTPError:
            raise ApiError(f"VPS {method} request failed (network/TLS/timeout); check connectivity and timeout settings.") from None
        if response.status_code in (404, 409, 410):
            raise LeaseLost(f"VPS rejected job ownership or freshness (HTTP {response.status_code}).")
        if response.status_code >= 300:
            raise ApiError(f"VPS {method} request rejected (HTTP {response.status_code}).")
        return response

    def claim(self):
        response = self.request("GET", "/api/compute/jobs")
        if response.status_code == 204:
            return None
        try:
            job = response.json()
            if job["pipelineVersion"] != PIPELINE_VERSION:
                raise WorkerError("VPS pipeline version differs from this compute worker (15).")
            if job.get("mode", "compute") != "compute":
                raise WorkerError("VPS attempted to assign a non-compute job.")
            if not isinstance(job["page"], int) or job["page"] < 1:
                raise ValueError()
            if not isinstance(job["leaseToken"], str) or not job["leaseToken"]:
                raise ValueError()
            if job["inputUrl"] != self.endpoint(job, "input") or not job["bookId"]:
                raise ValueError()
            if not math.isfinite(float(job["leaseSeconds"])) or float(job["leaseSeconds"]) <= 0:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise WorkerError("VPS returned an invalid compute claim.") from None
        return job

    def download(self, job, target, check):
        try:
            with self.client.stream("GET", self.url + job["inputUrl"],
                                    headers={"X-Compute-Lease": job["leaseToken"]}) as response:
                if response.status_code in (404, 409, 410):
                    raise LeaseLost("PDF input lease or source is no longer valid.")
                if response.status_code != 200:
                    raise ApiError(f"PDF input download rejected (HTTP {response.status_code}).")
                with target.open("wb") as output:
                    for chunk in response.iter_bytes(1024 * 1024):
                        check()
                        output.write(chunk)
        except httpx.HTTPError:
            raise ApiError("PDF input download failed (network/TLS/timeout).") from None

    def close(self):
        self.client.close()


class Lease:
    def __init__(self, api, job, claim_started):
        self.api, self.job = api, job
        self.seconds = float(job["leaseSeconds"])
        self.deadline = claim_started + self.seconds
        self.done = threading.Event()
        self.lost = threading.Event()
        self.thread = threading.Thread(target=self.heartbeat, name="compute-lease", daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def check(self):
        if self.lost.is_set() or time.monotonic() >= self.deadline:
            raise LeaseLost("Compute lease expired or was rejected; result cannot be delivered.")

    def heartbeat(self):
        delay = min(30, self.seconds / 3)
        with self.api.new_client() as client:
            while not self.done.wait(delay):
                started = time.monotonic()
                try:
                    self.check()
                    response = self.api.request("POST", self.api.endpoint(self.job, "renew"),
                                                {"leaseToken": self.job["leaseToken"]}, client=client)
                    seconds = float(response.json()["leaseSeconds"])
                    if not math.isfinite(seconds) or seconds <= 0:
                        raise ValueError()
                    self.seconds = seconds
                    self.deadline = started + seconds
                    delay = min(30, seconds / 3)
                except LeaseLost:
                    self.lost.set()
                    return
                except (WorkerError, ValueError, KeyError, TypeError):
                    print("Lease renewal failed; retrying while the existing lease remains valid.", file=sys.stderr)
                    delay = min(3, max(0.1, self.deadline - time.monotonic()))
                    if time.monotonic() >= self.deadline:
                        self.lost.set()
                        return

    def __exit__(self, *_):
        self.done.set()
        self.thread.join()


class PdfCache:
    def __init__(self, directory):
        self.path = Path(directory) / "input.pdf"
        self.key = None
        self.document = None

    def get(self, api, job, check):
        key = (job["bookId"], job.get("sourceVersion"))
        if self.document is not None and key[1] is not None and key == self.key:
            return self.document
        self.close()
        api.download(job, self.path, check)
        self.document = pymupdf.open(self.path)
        if not self.document.is_pdf or self.document.needs_pass:
            self.close()
            raise WorkerError("The claimed source must be an unencrypted PDF.")
        self.key = key
        return self.document

    def close(self):
        if self.document is not None:
            self.document.close()
            self.document = None
        self.key = None
        self.path.unlink(missing_ok=True)


def finish(api, job, lease, payload):
    attempts = int(number("VPS_DELIVERY_ATTEMPTS", 3, minimum=1))
    for attempt in range(attempts):
        lease.check()
        try:
            api.request("POST", api.endpoint(job, "complete"), {"leaseToken": job["leaseToken"], **payload})
            return
        except LeaseLost:
            raise
        except WorkerError:
            if attempt + 1 == attempts:
                raise
            print("Completion delivery failed; retrying the same idempotent lease result.", file=sys.stderr)
            time.sleep(min(2 ** attempt, 5))


def fail(api, job, message, requeue):
    try:
        api.request("POST", api.endpoint(job, "fail"),
                    {"leaseToken": job["leaseToken"], "error": message, "requeue": requeue})
    except WorkerError as error:
        print(f"Could not release active job: {error} Server lease expiry will recover it.", file=sys.stderr)


def drain(api, engine, stopping):
    failed = False
    with tempfile.TemporaryDirectory(prefix="reader-compute-") as directory:
        cache = PdfCache(directory)
        try:
            while not stopping.is_set():
                started = time.monotonic()
                job = api.claim()
                if job is None:
                    print("Compute queue drained (204); worker exiting.")
                    return 1 if failed else 0
                with Lease(api, job, started) as lease:
                    def check():
                        lease.check()
                        if stopping.is_set():
                            raise InterruptedError("Worker stopping; active job released.")
                    try:
                        document = cache.get(api, job, check)
                        payload = recognize(engine, document, job["page"], check)
                    except InterruptedError:
                        fail(api, job, "Worker stopped by user.", True)
                        return 130
                    except LeaseLost:
                        raise
                    except ApiError as error:
                        fail(api, job, str(error), True)
                        raise
                    except Exception as error:
                        # OCR/source failures are permanent for this attempt, never silently CPU-retried.
                        message = str(error).replace(api.secret, "[redacted]").replace(job["leaseToken"], "[redacted]")
                        fail(api, job, message[:2000], False)
                        print(f"Page {job['page']} inference failed: {message}", file=sys.stderr)
                        failed = True
                        continue
                    # If a stop arrived during CUDA inference, finish delivery before exiting.
                    try:
                        finish(api, job, lease, payload)
                    except WorkerError:
                        fail(api, job, "Completion delivery failed or lease was lost.", True)
                        raise
                    print(f"Completed page {job['page']} ({payload['result']['elapsedMs']} ms).")
            return 130
        finally:
            cache.close()


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--smoke-pdf", type=Path, help="Run real CUDA OCR on a local PDF without contacting a VPS.")
    parser.add_argument("--page", type=int, default=1, help="1-based local smoke PDF page.")
    parser.add_argument("--output", type=Path, help="Write smoke completion-shaped JSON (image + semantic result).")
    args = parser.parse_args()
    load_dotenv(args.env_file, override=False)
    stopping = threading.Event()
    def stop(_signum, _frame):
        stopping.set()
        print("Stop requested; releasing active work or finishing current CUDA delivery.", file=sys.stderr)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    module = engine = api = tunnel = None
    try:
        if args.smoke_pdf is None:
            tunnel = SshTunnel(stopping)
            api = Api(tunnel.url)  # Validate transport before downloading/loading models.
        elif args.output is not None and args.output.resolve() == args.smoke_pdf.resolve():
            raise WorkerError("Smoke output must not overwrite its input PDF.")
        module, engine = load_engine()
        print("Preparing pinned CUDA BF16 OCR models before claiming any lease...", file=sys.stderr)
        metadata = engine.prepare()
        print(json.dumps(metadata, ensure_ascii=False))
        if stopping.is_set():
            return 130
        if args.smoke_pdf is not None:
            def check():
                if stopping.is_set():
                    raise InterruptedError("Smoke stopped by user.")
            with pymupdf.open(args.smoke_pdf) as document:
                payload = recognize(engine, document, args.page, check)
            if args.output is not None:
                args.output.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            result = payload["result"]
            print(json.dumps({key: result[key] for key in ("width", "height", "elapsedMs", "metrics", "qualityLimits")},
                             ensure_ascii=False))
            for region in result["regions"]:
                print(json.dumps(region, ensure_ascii=False))
            return 0
        return drain(api, engine, stopping)
    except InterruptedError:
        return 130
    except Exception as error:
        message = str(error)
        if api is not None:
            message = message.replace(api.secret, "[redacted]")
        print(f"Compute worker failed: {message}", file=sys.stderr)
        return 1
    finally:
        if api is not None:
            api.close()
        if tunnel is not None:
            tunnel.close()
        release_engine(module, engine)


if __name__ == "__main__":
    raise SystemExit(main())
