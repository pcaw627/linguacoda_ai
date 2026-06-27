"""
Client for connecting to the external transcription server or compute gateway.
"""
import os
import requests
import base64
import numpy as np
from typing import Optional
from pathlib import Path
import time

TOKEN_FILE = Path(__file__).parent / ".transcription_server.token"
SERVER_URL = "http://127.0.0.1:8765"
GATEWAY_URL = os.environ.get("LINGUACODA_COMPUTE_GATEWAY_URL", "").strip().rstrip("/")
JWT_FILE = os.environ.get("LINGUACODA_COMPUTE_JWT_FILE", "").strip()
HEALTH_CHECK_TIMEOUT = 2
REQUEST_TIMEOUT = 30


class TranscriptionClient:
    """Client for external transcription server or remote compute gateway."""

    def __init__(self, server_url: str = SERVER_URL):
        self.via_gateway = bool(GATEWAY_URL)
        self.server_url = GATEWAY_URL if self.via_gateway else server_url
        self.token = None if self.via_gateway else self._load_token()
        self.session = requests.Session()
        self._refresh_auth_headers()
        self._last_health_check = 0
        self._health_check_interval = 5
        self._server_was_running = False

    def _load_token(self) -> Optional[str]:
        if TOKEN_FILE.exists():
            try:
                with open(TOKEN_FILE, "r") as f:
                    token = f.read().strip()
                    if token:
                        return token
            except Exception as e:
                print(f"Warning: Failed to load token: {e}", file=__import__("sys").stderr)
        return None

    def _load_compute_jwt(self) -> Optional[str]:
        if not JWT_FILE:
            return None
        try:
            with open(JWT_FILE, "r") as f:
                token = f.read().strip()
                return token or None
        except OSError:
            return None

    def _refresh_auth_headers(self) -> None:
        headers = {"Content-Type": "application/json"}
        if self.via_gateway:
            jwt = self._load_compute_jwt()
            if jwt:
                headers["Authorization"] = f"Bearer {jwt}"
        elif self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self.session.headers.clear()
        self.session.headers.update(headers)

    def is_server_running(self, force_check: bool = False) -> bool:
        import time as time_module

        current_time = time_module.time()
        if not force_check and (current_time - self._last_health_check) < self._health_check_interval:
            return self._server_was_running

        try:
            response = self.session.get(
                f"{self.server_url}/health",
                timeout=HEALTH_CHECK_TIMEOUT,
            )
            if self.via_gateway:
                if response.status_code == 200:
                    data = response.json()
                    is_running = bool(data.get("transcription", {}).get("ready"))
                else:
                    is_running = False
            else:
                is_running = response.status_code == 200
            self._server_was_running = is_running
            self._last_health_check = current_time
            return is_running
        except (requests.exceptions.RequestException, requests.exceptions.Timeout):
            self._server_was_running = False
            self._last_health_check = current_time
            return False

    def transcribe(self, audio_data: np.ndarray, language: str = "auto") -> tuple[str, str]:
        if not self.is_server_running(force_check=True):
            return ("", language if language != "auto" else "unknown")

        try:
            if audio_data.dtype != np.float32:
                audio_data = audio_data.astype(np.float32)

            audio_bytes = audio_data.tobytes()
            audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

            endpoint = f"{self.server_url}/transcribe"
            self._refresh_auth_headers()
            response = self.session.post(
                endpoint,
                json={"audio": audio_b64, "language": language},
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code == 200:
                result = response.json()
                return (
                    result.get("transcription", ""),
                    result.get("detectedLang", language if language != "auto" else "unknown"),
                )
            elif response.status_code == 503:
                return ("", language if language != "auto" else "unknown")
            else:
                print(
                    f"Transcription request failed: {response.status_code} - {response.text}",
                    file=__import__("sys").stderr,
                )
                return ("", language if language != "auto" else "unknown")

        except requests.exceptions.Timeout:
            print("Transcription request timed out", file=__import__("sys").stderr)
            return ("", language if language != "auto" else "unknown")
        except Exception as e:
            print(f"Transcription error: {e}", file=__import__("sys").stderr)
            return ("", language if language != "auto" else "unknown")

    def transcribe_batch(self, audio_chunks: list, language: str = "auto") -> list:
        results = []
        for chunk in audio_chunks:
            text, lang = self.transcribe(chunk, language)
            results.append((text, lang))
        return results

    def is_ready(self) -> bool:
        return self.is_server_running()

    def cleanup(self):
        if hasattr(self, "session"):
            self.session.close()
