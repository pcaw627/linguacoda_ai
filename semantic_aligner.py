"""
Cross-lingual semantic unit alignment.

Pipeline
--------
1. Strip parenthetical clarifiers/tags from both sides (ASCII `()` and
   full-width `（）`), so things like "(referring to X)" never become chunks.
2. Tokenize each side independently:
   - Chinese (detected via Han characters): pkuseg word segmentation, so
     multi-character words like "墨西哥城" stay together as one chunk.
     pkuseg is a hard dependency — if it's not importable, /align fails
     loudly rather than silently degrading. On Windows/Python 3.10+ install
     pkuseg via `scripts/install_pkuseg.ps1` (see that script's header).
   - Latin scripts: whitespace split + outer-punctuation strip. Inner
     punctuation (e.g., the comma in "8,000", the apostrophe in "don't") is
     preserved. Pure-punctuation tokens are dropped — they remain in the
     source string as gap text between chunks.
3. Run SimAlign (XLM-R base, IterMax matching) on the tokenized pair to
   produce many-to-many word alignments. IterMax handles 1:N and N:1
   alignments naturally — exactly what we need for cases like
   "墨西哥城" → ["Mexico", "City"].
4. Return chunks + correlations in the shape the renderer already consumes:
       {
         "transcriptionChunks": [{"id": "t1", "text": "..."}, ...],
         "translationChunks":   [{"id": "e1", "text": "..."}, ...],
         "correlations":        [{"id": "t1", "matches": ["e1", "e2"]}, ...]
       }

This pipeline is deterministic given pinned model weights — same input
always produces identical output, which the prior LLM-based pipeline
could not guarantee.
"""

import re
import sys
import threading
from typing import Any, Dict, List

# Match Han ideographs (CJK Unified + Extension A). Used both to detect a
# "Chinese-y" sentence and to keep Han chars from being treated as outer
# punctuation by the Latin tokenizer.
_HAN_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

# Match any parenthetical group, ASCII or full-width. Non-greedy and only
# matches groups that don't themselves contain parens, so we iterate to a
# fixed point in `_strip_parentheticals` to handle nesting.
_PAREN_RE = re.compile(r"[\(（][^\(\)（）]*[\)）]")

# Strip leading/trailing non-word/non-Han chars from a whitespace token. Inner
# punctuation (comma in "8,000", apostrophe in "don't", hyphen in "well-known")
# is preserved.
_OUTER_PUNCT_RE = re.compile(
    r"^[^\w\u4e00-\u9fff\u3400-\u4dbf]+|[^\w\u4e00-\u9fff\u3400-\u4dbf]+$",
    re.UNICODE,
)

# SimAlign config — XLM-R base with IterMax matching, suitable for Chinese↔English
# (and most other language pairs covered by XLM-R).
_SIMALIGN_MODEL = "xlm-roberta-base"
_SIMALIGN_TOKEN_TYPE = "bpe"
_SIMALIGN_MATCHING_METHOD = "i"  # "i" → only IterMax, returned under key "itermax"

_aligner = None
_aligner_lock = threading.Lock()
_pkuseg = None
_pkuseg_lock = threading.Lock()


def _get_aligner():
    """Lazily load the SimAlign model.

    Heavy: pulls XLM-R base (~1 GB) on first use. Reused for every subsequent
    request. Guarded by a lock so concurrent first-callers don't race the load.
    """
    global _aligner
    with _aligner_lock:
        if _aligner is None:
            from simalign import SentenceAligner  # lazy: keep module-load light
            print(
                f"[SemanticAligner] Loading SimAlign ({_SIMALIGN_MODEL})...",
                file=sys.stderr,
                flush=True,
            )
            _aligner = SentenceAligner(
                model=_SIMALIGN_MODEL,
                token_type=_SIMALIGN_TOKEN_TYPE,
                matching_methods=_SIMALIGN_MATCHING_METHOD,
            )
            print("[SemanticAligner] SimAlign ready.", file=sys.stderr, flush=True)
        return _aligner


def _get_pkuseg():
    """Lazily load pkuseg (Chinese word segmentation). Reused for every call.

    pkuseg is a hard dependency. If the import fails (e.g. it was never
    installed because the PyPI sdist's bundled C++ won't compile on this
    Python/OS), surface a clear error pointing at the install script rather
    than silently degrading segmentation quality.
    """
    global _pkuseg
    with _pkuseg_lock:
        if _pkuseg is None:
            try:
                import pkuseg  # lazy: keep module-load light
            except ImportError as e:
                raise ImportError(
                    "pkuseg is required for semantic alignment but is not "
                    "installed. On Windows/Python 3.10+ install it via "
                    "`powershell -ExecutionPolicy Bypass -File "
                    "scripts/install_pkuseg.ps1` (see that script's header "
                    "for prereqs and the explanation of the C++/Cython issue)."
                ) from e
            print("[SemanticAligner] Loading pkuseg...", file=sys.stderr, flush=True)
            _pkuseg = pkuseg.pkuseg()
            print("[SemanticAligner] pkuseg ready.", file=sys.stderr, flush=True)
        return _pkuseg


def _strip_parentheticals(text: str) -> str:
    """Remove ASCII/full-width parenthetical clarifiers like `(referring to X)`
    or `（注：…）`. Iterates to a fixed point so nested groups flatten."""
    prev = None
    cur = text
    while prev != cur:
        prev = cur
        cur = _PAREN_RE.sub(" ", cur)
    return cur


def _has_content(tok: str) -> bool:
    """True iff `tok` has at least one letter/digit. Han characters count
    (Python classifies them as alphanumeric), so this also passes through
    Chinese tokens unchanged. Used to drop pure-punctuation tokens."""
    return any(ch.isalnum() for ch in tok)


def _contains_han(text: str) -> bool:
    return bool(_HAN_RE.search(text))


def _tokenize_chinese(text: str) -> List[str]:
    """Word-segment Chinese with pkuseg, dropping whitespace/punctuation tokens."""
    seg = _get_pkuseg()
    out: List[str] = []
    for w in seg.cut(text):
        w = w.strip()
        if w and _has_content(w):
            out.append(w)
    return out


def _tokenize_latin(text: str) -> List[str]:
    """Whitespace-split a Latin-script sentence, stripping outer punctuation
    from each token and discarding pure-punctuation tokens.

    Examples:
        "around 8,000 yuan."   → ["around", "8,000", "yuan"]
        "don't worry."         → ["don't", "worry"]
        "well-known U.S. firm" → ["well-known", "U.S", "firm"]
    """
    out: List[str] = []
    for w in text.split():
        core = _OUTER_PUNCT_RE.sub("", w)
        if core and _has_content(core):
            out.append(core)
    return out


def _tokenize_side(text: str) -> List[str]:
    """Tokenize one side, auto-picking the tokenizer by script.

    A sentence containing any Han character goes through pkuseg; otherwise it
    falls through to the Latin tokenizer. This is intentionally a simple
    heuristic — mixed-script sentences (CJK with embedded English) are still
    handled by pkuseg, which is happy to keep Latin runs as their own tokens.
    """
    cleaned = _strip_parentheticals(text or "").strip()
    if not cleaned:
        return []
    if _contains_han(cleaned):
        return _tokenize_chinese(cleaned)
    return _tokenize_latin(cleaned)


def align(transcription: str, translation: str) -> Dict[str, Any]:
    """Tokenize both sides and produce many-to-many alignment chunks.

    Returns a dict with `transcriptionChunks`, `translationChunks`, and
    `correlations`. Every transcription chunk appears in `correlations`
    exactly once with a (possibly empty) `matches` array of translation IDs.
    """
    src_tokens = _tokenize_side(transcription)
    trg_tokens = _tokenize_side(translation)

    transcription_chunks = [
        {"id": f"t{i + 1}", "text": tok} for i, tok in enumerate(src_tokens)
    ]
    translation_chunks = [
        {"id": f"e{i + 1}", "text": tok} for i, tok in enumerate(trg_tokens)
    ]

    if not src_tokens or not trg_tokens:
        return {
            "transcriptionChunks": transcription_chunks,
            "translationChunks": translation_chunks,
            "correlations": [
                {"id": c["id"], "matches": []} for c in transcription_chunks
            ],
        }

    aligner = _get_aligner()
    raw = aligner.get_word_aligns(src_tokens, trg_tokens)
    # `matching_methods="i"` returns {"itermax": [(s, t), ...]}. Fall back to
    # the first available method if SimAlign ever changes its key name.
    pairs = raw.get("itermax") or next(iter(raw.values()), [])

    # Bucket targets per source, preserving target order so the matches array
    # reads left-to-right in the translation sentence.
    matches_by_src: Dict[int, List[int]] = {i: [] for i in range(len(src_tokens))}
    for s, t in pairs:
        if 0 <= s < len(src_tokens) and 0 <= t < len(trg_tokens):
            if t not in matches_by_src[s]:
                matches_by_src[s].append(t)

    correlations: List[Dict[str, Any]] = []
    for i in range(len(src_tokens)):
        match_ids = [f"e{t + 1}" for t in sorted(matches_by_src[i])]
        correlations.append({"id": f"t{i + 1}", "matches": match_ids})

    return {
        "transcriptionChunks": transcription_chunks,
        "translationChunks": translation_chunks,
        "correlations": correlations,
    }


def warmup() -> None:
    """Best-effort load + tiny dry-run so the first `/align` request isn't slow.

    pkuseg and SimAlign are independent (separate libraries, separate locks),
    so we load them on separate threads to overlap their startup cost — most
    of the wall-clock time is spent in C-extension / torch model loading that
    releases the GIL, so this meaningfully shortens cold start.

    Each step is independently guarded so a missing dependency (e.g., pkuseg
    not installed) doesn't prevent the rest of the server from coming up —
    the `/align` endpoint will surface the same error on first use, pointing
    the user at `scripts/install_pkuseg.ps1`.
    """
    def _warm_pkuseg():
        try:
            _get_pkuseg().cut("你好")
        except Exception as e:
            print(f"[SemanticAligner] pkuseg warmup failed: {e}", file=sys.stderr, flush=True)

    def _warm_simalign():
        try:
            _get_aligner().get_word_aligns(["hello"], ["你好"])
        except Exception as e:
            print(f"[SemanticAligner] SimAlign warmup failed: {e}", file=sys.stderr, flush=True)

    threads = [
        threading.Thread(target=_warm_pkuseg, name="warmup-pkuseg", daemon=True),
        threading.Thread(target=_warm_simalign, name="warmup-simalign", daemon=True),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def is_ready() -> bool:
    """True iff both pkuseg and the SimAlign aligner have been loaded at least once."""
    return _aligner is not None and _pkuseg is not None
