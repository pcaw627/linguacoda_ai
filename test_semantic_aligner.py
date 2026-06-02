"""
Sanity-check script for the new semantic alignment pipeline.

Exercises the two real-world cases that drove the LLM → SimAlign rewrite,
plus a few edge-case checks (parenthetical stripping, punctuation handling,
empty input). Does NOT use the HTTP server — calls semantic_aligner.align
directly so it works whether or not transcription_server.py is running.

Run with (from the project root):

    chcp 65001 ; conda activate livesub ; python test_semantic_aligner.py

First run will be slow — pkuseg and XLM-R base both download on first use.
"""

import json
import sys

import semantic_aligner


def _print_result(label: str, result: dict) -> None:
    src_chunks = result["transcriptionChunks"]
    trg_chunks = result["translationChunks"]
    corrs = result["correlations"]

    src_lookup = {c["id"]: c["text"] for c in src_chunks}
    trg_lookup = {c["id"]: c["text"] for c in trg_chunks}

    print(f"\n=== {label} ===")
    print(f"  src chunks ({len(src_chunks)}): {[c['text'] for c in src_chunks]}")
    print(f"  trg chunks ({len(trg_chunks)}): {[c['text'] for c in trg_chunks]}")
    print("  alignments:")
    for c in corrs:
        src_text = src_lookup.get(c["id"], "?")
        if c["matches"]:
            trg_texts = [trg_lookup.get(m, "?") for m in c["matches"]]
            print(f"    {c['id']} '{src_text}'  →  {c['matches']} {trg_texts}")
        else:
            print(f"    {c['id']} '{src_text}'  →  (unmapped)")


def check_pair(label: str, src: str, trg: str, expectations=None) -> bool:
    """Run align() on a pair and optionally assert that certain (src_substring,
    trg_substring) pairs end up in the same alignment group."""
    result = semantic_aligner.align(src, trg)
    _print_result(label, result)

    if not expectations:
        return True

    src_lookup = {c["id"]: c["text"] for c in result["transcriptionChunks"]}
    trg_lookup = {c["id"]: c["text"] for c in result["translationChunks"]}
    ok = True
    for expected_src, expected_trgs in expectations:
        # Find any src chunk whose text contains the expected substring
        matching_corrs = [
            c for c in result["correlations"]
            if expected_src in src_lookup.get(c["id"], "")
        ]
        if not matching_corrs:
            print(f"  ✗ no src chunk found containing '{expected_src}'")
            ok = False
            continue
        # For at least one matching src chunk, every expected target should appear
        any_match = False
        for c in matching_corrs:
            mapped_texts = [trg_lookup.get(m, "") for m in c["matches"]]
            covered = all(
                any(et in mt for mt in mapped_texts) for et in expected_trgs
            )
            if covered:
                any_match = True
                print(f"  ✓ '{src_lookup[c['id']]}'  →  {mapped_texts}  covers {expected_trgs}")
                break
        if not any_match:
            print(f"  ✗ '{expected_src}' did not align to all of {expected_trgs}")
            ok = False
    return ok


def main() -> int:
    print("Warming up aligner (first run downloads models, may take minutes)...")
    semantic_aligner.warmup()

    all_ok = True

    # Bug 1 from the user report: "墨西哥城" should align to both "Mexico" and "City".
    all_ok &= check_pair(
        "Mexico City — many-to-many",
        "然，我们做一个类比的话，墨西哥城其实跟咱北。",
        "However, if we make an analogy, Mexico City is actually like Beijing.",
        expectations=[("墨西哥城", ["Mexico", "City"])],
    )

    # Bug 2 from the user report: "每一天" should not align to "about".
    # We assert the positive: it should align to "day" (and maybe related words).
    all_ok &= check_pair(
        "Every day — should align to 'day', not 'about'",
        "咱咱北京平均工资现在大概8000块钱一个月吧，1一个平均到每一天就是2300块钱。",
        "Our Beijing average wage is currently around 8,000 yuan per month, which is about 2,300 yuan per day on average.",
        expectations=[("每一天", ["day"])],
    )

    # Parenthetical stripping — should NOT see "(referring to..." chunks
    print("\n=== Parenthetical stripping ===")
    result = semantic_aligner.align(
        "我去了北京（中国首都）。",
        "I went to Beijing (the capital of China).",
    )
    src_texts = [c["text"] for c in result["transcriptionChunks"]]
    trg_texts = [c["text"] for c in result["translationChunks"]]
    print(f"  src chunks: {src_texts}")
    print(f"  trg chunks: {trg_texts}")
    has_paren_residue = any(("(" in t or "（" in t or ")" in t or "）" in t) for t in src_texts + trg_texts)
    if has_paren_residue:
        print("  ✗ parenthetical content leaked into chunk texts")
        all_ok = False
    else:
        print("  ✓ parentheticals stripped from both sides")

    # Empty input — should not crash
    print("\n=== Empty input ===")
    empty_result = semantic_aligner.align("", "")
    print(json.dumps(empty_result, ensure_ascii=False))
    if (empty_result["transcriptionChunks"] == []
            and empty_result["translationChunks"] == []
            and empty_result["correlations"] == []):
        print("  ✓ empty input handled cleanly")
    else:
        print("  ✗ empty input produced unexpected output")
        all_ok = False

    # Numbers + punctuation handling on the English side
    print("\n=== Numbers + punctuation ===")
    num_result = semantic_aligner.align(
        "他赚8000块钱。",
        "He earns 8,000 yuan.",
    )
    en_chunks = [c["text"] for c in num_result["translationChunks"]]
    print(f"  trg chunks: {en_chunks}")
    if "8,000" in en_chunks:
        print("  ✓ '8,000' kept as a single chunk")
    else:
        print("  ✗ '8,000' was not preserved as a single chunk")
        all_ok = False
    if any(ch in en_chunks for ch in [".", ",", ";", ":"]):
        print("  ✗ standalone punctuation leaked into chunks")
        all_ok = False
    else:
        print("  ✓ standalone punctuation kept out of chunks")

    print("\n" + ("ALL CHECKS PASSED" if all_ok else "SOME CHECKS FAILED"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
