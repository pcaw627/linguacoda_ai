"""Load shared settings from repo-root electron-config.json."""

from __future__ import annotations

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "electron-config.json"
TOKEN_PATH = REPO_ROOT / ".transcription_server.token"


def load_electron_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def ollama_endpoint() -> str:
    return os.environ.get(
        "OLLAMA_ENDPOINT",
        load_electron_config().get("ollamaEndpoint", "http://127.0.0.1:11434"),
    ).rstrip("/")


def ollama_model() -> str:
    return os.environ.get(
        "OLLAMA_MODEL",
        load_electron_config().get("ollamaModel", "gemma3:4b"),
    )


def transcription_server_url() -> str:
    return os.environ.get(
        "TRANSCRIPTION_SERVER_URL", "http://127.0.0.1:8765"
    ).rstrip("/")


def load_transcription_token() -> str | None:
    if TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    return None
