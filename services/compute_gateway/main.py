"""
Compute Gateway — unified HTTP entry for transcription server + Ollama.

  # LAN dev (no JWT):
  python -m services.compute_gateway.main --bind 0.0.0.0 --port 8080

  # Internet / Cloudflare Tunnel (JWT required):
  set LINGUACODA_REMOTE_MODE=1
  set JWT_SECRET=your-shared-secret
  python -m services.compute_gateway.main --remote --bind 127.0.0.1 --port 8080
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import urlparse

import requests

from services.compute_gateway.auth import authenticate_request, remote_mode_enabled
from services.compute_gateway.config import (
    load_transcription_token,
    ollama_endpoint,
    ollama_model,
    transcription_server_url,
)
from services.compute_gateway.limits import GatewayLimits

TRANSCRIBE_TIMEOUT = 120
OLLAMA_TIMEOUT = 120
ALIGN_TIMEOUT = 120
MAX_BODY_BYTES = 6 * 1024 * 1024
MAX_TRANSCRIBE_BODY_BYTES = 5 * 1024 * 1024


class GatewayRuntime:
    def __init__(self, remote_mode: bool) -> None:
        self.remote_mode = remote_mode
        self.limits = GatewayLimits()


class GatewayHTTPServer(HTTPServer):
    def __init__(self, server_address, RequestHandlerClass, runtime: GatewayRuntime):
        self.runtime = runtime
        super().__init__(server_address, RequestHandlerClass)


def _ollama_generate(prompt: str, *, json_format: bool = False) -> str:
    payload: dict[str, Any] = {
        "model": ollama_model(),
        "prompt": prompt,
        "stream": False,
    }
    if json_format:
        payload["format"] = "json"

    response = requests.post(
        f"{ollama_endpoint()}/api/generate",
        json=payload,
        timeout=OLLAMA_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()
    text = data.get("response", "")
    if not isinstance(text, str):
        raise ValueError("Ollama returned no response text")
    return text.strip()


def _transcription_headers() -> dict[str, str]:
    token = load_transcription_token()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _proxy_transcription_health() -> dict[str, Any]:
    try:
        response = requests.get(
            f"{transcription_server_url()}/health",
            headers=_transcription_headers(),
            timeout=5,
        )
        if response.status_code == 200:
            return response.json()
    except requests.RequestException:
        pass
    return {"status": "unreachable", "ready": False, "alignerReady": False}


def _proxy_ollama_health() -> dict[str, Any]:
    try:
        response = requests.get(f"{ollama_endpoint()}/api/tags", timeout=5)
        if response.status_code == 200:
            return {"ok": True}
    except requests.RequestException:
        pass
    return {"ok": False}


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "LinguaCodaComputeGateway/0.2"

    @property
    def runtime(self) -> GatewayRuntime:
        return self.server.runtime  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        message = format % args
        print(f"[ComputeGateway] {message}", file=sys.stderr, flush=True)

    def _read_body(self, max_bytes: int) -> bytes | None:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return b""
        if length > max_bytes:
            self._json_response(413, {"error": "Payload too large"})
            return None
        return self.rfile.read(length)

    def _read_json_body(self, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any] | None:
        raw = self._read_body(max_bytes)
        if raw is None:
            return None
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json_response(400, {"error": "Invalid JSON"})
            return None

    def _json_response(
        self,
        status: int,
        payload: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _authenticate(self) -> dict[str, Any] | None:
        claims, error = authenticate_request(
            self.headers.get("Authorization"),
            remote_mode=self.runtime.remote_mode,
        )
        if error:
            self._json_response(401, {"error": error})
            return None
        return claims

    def _check_rate_limit(self, claims: dict[str, Any]) -> bool:
        if not self.runtime.remote_mode:
            return True
        key = str(claims.get("sub", "unknown"))
        allowed, retry_after = self.runtime.limits.rate_limiter.allow(key)
        if not allowed:
            self._json_response(
                429,
                {"error": "Rate limit exceeded", "retryAfterSeconds": retry_after},
                extra_headers={"Retry-After": str(retry_after)},
            )
            return False
        return True

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path != "/health":
            self._json_response(404, {"error": "Not found"})
            return

        ts = _proxy_transcription_health()
        ollama = _proxy_ollama_health()
        transcribe_stats = self.runtime.limits.transcribe.snapshot()
        ollama_stats = self.runtime.limits.ollama.snapshot()
        self._json_response(
            200,
            {
                "ok": True,
                "remoteMode": self.runtime.remote_mode,
                "transcription": {
                    "ready": bool(ts.get("ready")),
                    "alignerReady": bool(ts.get("alignerReady")),
                },
                "ollama": ollama,
                "transcribeActive": transcribe_stats["active"],
                "transcribeQueued": transcribe_stats["queued"],
                "ollamaActive": ollama_stats["active"],
            },
        )

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        claims = self._authenticate()
        if claims is None:
            return
        if not self._check_rate_limit(claims):
            return

        max_body = MAX_TRANSCRIBE_BODY_BYTES if path == "/transcribe" else MAX_BODY_BYTES
        body = self._read_json_body(max_body)
        if body is None:
            return

        try:
            if path == "/transcribe":
                self._handle_transcribe(body)
            elif path == "/align":
                self._handle_align(body)
            elif path == "/translate":
                self._handle_translate(body)
            elif path == "/vocab-context":
                self._handle_vocab_context(body)
            elif path == "/flashcard-entry":
                self._handle_flashcard_entry(body)
            else:
                self._json_response(404, {"error": "Not found"})
        except requests.HTTPError as err:
            detail = err.response.text if err.response is not None else str(err)
            self._json_response(
                err.response.status_code if err.response else 502,
                {"error": detail},
            )
        except requests.RequestException as err:
            self._json_response(502, {"error": str(err)})
        except ValueError as err:
            self._json_response(400, {"error": str(err)})

    def _handle_transcribe(self, body: dict[str, Any]) -> None:
        if not self.runtime.limits.transcribe.try_acquire():
            self._json_response(
                429,
                {"error": "Too many concurrent transcriptions", "retryAfterSeconds": 5},
                extra_headers={"Retry-After": "5"},
            )
            return
        try:
            response = requests.post(
                f"{transcription_server_url()}/transcribe",
                json=body,
                headers=_transcription_headers(),
                timeout=TRANSCRIBE_TIMEOUT,
            )
            response.raise_for_status()
            self._json_response(response.status_code, response.json())
        finally:
            self.runtime.limits.transcribe.release()

    def _handle_align(self, body: dict[str, Any]) -> None:
        response = requests.post(
            f"{transcription_server_url()}/align",
            json=body,
            headers=_transcription_headers(),
            timeout=ALIGN_TIMEOUT,
        )
        response.raise_for_status()
        self._json_response(response.status_code, response.json())

    def _handle_translate(self, body: dict[str, Any]) -> None:
        if not self._with_ollama_slot(lambda: self._translate_inner(body)):
            return

    def _translate_inner(self, body: dict[str, Any]) -> None:
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            self._json_response(400, {"error": "text is required"})
            return
        prompt = (
            "Translate the following text to English. "
            f"Only provide the translation, no explanations:\n\n{text}"
        )
        translation = _ollama_generate(prompt)
        self._json_response(200, {"translation": translation})

    def _handle_vocab_context(self, body: dict[str, Any]) -> None:
        if not self._with_ollama_slot(lambda: self._vocab_context_inner(body)):
            return

    def _vocab_context_inner(self, body: dict[str, Any]) -> None:
        word = body.get("word")
        if not isinstance(word, str) or not word.strip():
            self._json_response(400, {"error": "word is required"})
            return
        prompt = (
            f'Give a brief example (under 100 words) of how the Chinese word "{word}" '
            "is used in context. Include one or two short example sentences in Chinese "
            "with English translations. Be concise."
        )
        context = _ollama_generate(prompt)
        self._json_response(200, {"context": context})

    def _handle_flashcard_entry(self, body: dict[str, Any]) -> None:
        if not self._with_ollama_slot(lambda: self._flashcard_inner(body)):
            return

    def _flashcard_inner(self, body: dict[str, Any]) -> None:
        word = body.get("word")
        if not isinstance(word, str) or not word.strip():
            self._json_response(400, {"error": "word is required"})
            return
        prompt = (
            f'You are a Chinese-English dictionary. For the Chinese word "{word}", '
            "list every distinct pronunciation together with its meaning. Respond with "
            "ONLY a single JSON object and nothing else: no greeting, no explanation, "
            'no markdown, no text before or after it. Use exactly this shape: '
            '{"entries":[{"pinyin":"pin yin with tone marks","meaning":"very brief English definition"}]}. '
            "Each meaning must be at most 5 words. Include one array item per distinct "
            "pronunciation/meaning."
        )
        raw = _ollama_generate(prompt, json_format=True)
        self._json_response(200, {"raw": raw})

    def _with_ollama_slot(self, fn) -> bool:
        if not self.runtime.limits.ollama.try_acquire():
            self._json_response(
                429,
                {"error": "Ollama busy", "retryAfterSeconds": 3},
                extra_headers={"Retry-After": "3"},
            )
            return False
        try:
            fn()
            return True
        finally:
            self.runtime.limits.ollama.release()


def main() -> None:
    parser = argparse.ArgumentParser(description="LinguaCoda Compute Gateway")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address")
    parser.add_argument("--port", type=int, default=8080, help="Listen port")
    parser.add_argument(
        "--remote",
        action="store_true",
        help="Require JWT on POST endpoints (or set LINGUACODA_REMOTE_MODE=1)",
    )
    parser.add_argument(
        "--bind",
        dest="host",
        help="Alias for --host (e.g. --bind 0.0.0.0)",
    )
    args = parser.parse_args()

    remote_mode = args.remote or remote_mode_enabled()
    runtime = GatewayRuntime(remote_mode=remote_mode)

    server = GatewayHTTPServer((args.host, args.port), GatewayHandler, runtime)
    mode_label = "remote (JWT required)" if remote_mode else "local (no JWT)"
    print(
        f"[ComputeGateway] Listening on http://{args.host}:{args.port} [{mode_label}]",
        file=sys.stderr,
        flush=True,
    )
    print(
        f"[ComputeGateway] Transcription → {transcription_server_url()}",
        file=sys.stderr,
        flush=True,
    )
    print(
        f"[ComputeGateway] Ollama → {ollama_endpoint()} ({ollama_model()})",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[ComputeGateway] Stopping", file=sys.stderr, flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
