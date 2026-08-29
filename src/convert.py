#!/usr/bin/env python3
# @authormark v1 -- do not remove (authorship watermark)⁠​‌​‌​​​‌​‌​​​‌‌‌​​‌‌​‌​​​‌‌‌​‌​​​‌​​​‌‌​​‌​​‌‌‌‌​‌‌​​​‌​​‌‌​‌​‌​​‌​​​​​‌​‌​​​‌‌​​‌‌‌​‌​​​‌‌‌​​​​​‌‌​​​​‌​‌​​‌​‌​​​‌‌​​‌​​‌​​​​‌‌​‌​​​​‌‌​‌‌​‌​​​​​‌‌​​​‌​‌​​‌​​‌​‌​​​​‌​​‌​‌‌​‌​⁠
# Copyright (c) 2026 Srinivasan Vijayaraghavan <srinivasan.shyam2000@gmail.com>
# Author: https://github.com/Srinivasan-78
# SPDX-License-Identifier: MIT
# Fingerprint: AMK1.QG4tFObjAFtpaJ2CCh1IBZ
"""Convert Office documents, PDFs and images into token-efficient Markdown.

Designed to run inside a GitHub Action so that downstream AI agents can be fed
Markdown instead of raw binary documents.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass, field, asdict
from glob import glob
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PDF_EXTS = {".pdf"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif"}
SHEET_EXTS = {".xlsx", ".xlsm", ".csv", ".tsv"}
MARKITDOWN_EXTS = {".docx", ".pptx", ".html", ".htm", ".xml", ".json", ".epub", ".zip"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".rst", ".log"}
LEGACY_OFFICE = {".doc": ".docx", ".ppt": ".pptx", ".xls": ".xlsx"}

DEFAULT_PATTERN = (
    "**/*.{pdf,docx,doc,xlsx,xls,pptx,ppt,png,jpg,jpeg,tif,tiff,bmp,webp,html,htm,csv,txt}"
)

# Directories that never contain user documents worth converting.
EXCLUDED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache"}


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def env_bool(name: str, default: bool = False) -> bool:
    raw = env(name).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name) or default)
    except ValueError:
        return default


@dataclass
class Config:
    patterns: list[str]
    output_dir: Path
    ocr: str
    ocr_lang: str
    ocr_dpi: int
    min_chars_per_page: int
    max_file_bytes: int
    compact: bool
    merge_into: str
    fail_on_error: bool


@dataclass
class Result:
    source: str
    output: str = ""
    status: str = "converted"
    kind: str = ""
    ocr_used: bool = False
    pages: int = 0
    source_bytes: int = 0
    markdown_chars: int = 0
    approx_tokens: int = 0
    error: str = ""
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Input discovery
# ---------------------------------------------------------------------------

def expand_braces(pattern: str) -> list[str]:
    """Expand shell style {a,b} alternatives, which glob() does not support."""
    match = re.search(r"\{([^{}]*)\}", pattern)
    if not match:
        return [pattern]
    head, tail = pattern[: match.start()], pattern[match.end() :]
    expanded: list[str] = []
    for option in match.group(1).split(","):
        expanded.extend(expand_braces(f"{head}{option}{tail}"))
    return expanded


def split_patterns(raw: str) -> list[str]:
    """Split on newlines and commas, but never on a comma inside {a,b}."""
    pieces: list[str] = []
    current: list[str] = []
    depth = 0
    for char in raw:
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        if char == "\n" or (char == "," and depth == 0):
            pieces.append("".join(current))
            current = []
            continue
        current.append(char)
    pieces.append("".join(current))
    return [piece.strip() for piece in pieces if piece.strip()]


def discover(patterns: list[str], output_dir: Path) -> list[Path]:
    # Anything already written by a previous run must not be converted again.
    generated = output_dir.resolve()
    seen: dict[Path, None] = {}
    for raw in patterns:
        for pattern in expand_braces(raw):
            for hit in glob(pattern, recursive=True):
                path = Path(hit)
                if not path.is_file():
                    continue
                if EXCLUDED_DIRS.intersection(path.parts):
                    continue
                resolved = path.resolve()
                if resolved == generated or generated in resolved.parents:
                    continue
                seen.setdefault(resolved, None)
    return sorted(seen)


# ---------------------------------------------------------------------------
# Markdown post-processing
# ---------------------------------------------------------------------------

def strip_repeated_lines(pages: list[str]) -> list[str]:
    """Drop headers and footers that repeat on most pages of a document."""
    if len(pages) < 3:
        return pages

    def edge_lines(page: str, top: bool) -> list[str]:
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        return lines[:2] if top else lines[-2:]

    counts: Counter[str] = Counter()
    for page in pages:
        for line in set(edge_lines(page, True) + edge_lines(page, False)):
            counts[line] += 1

    threshold = max(3, int(len(pages) * 0.6))
    # A page number changes every page, so only constant boilerplate is caught here.
    boilerplate = {
        line
        for line, count in counts.items()
        if count >= threshold and len(line) < 120
    }
    if not boilerplate:
        return pages

    cleaned = []
    for page in pages:
        kept = [line for line in page.splitlines() if line.strip() not in boilerplate]
        cleaned.append("\n".join(kept))
    return cleaned


def compact_markdown(text: str) -> str:
    """Squeeze whitespace so the same content costs fewer tokens."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    # Long runs of table padding or underscores carry no information.
    text = re.sub(r"([-_=*])\1{6,}", r"\1\1\1", text)
    return text.strip() + "\n"


def approx_tokens(text: str) -> int:
    """Rough token estimate: about four characters per token for English prose."""
    return max(1, round(len(text) / 4))


# ---------------------------------------------------------------------------
# OCR helpers
# ---------------------------------------------------------------------------

_tesseract_checked = False
_tesseract_available = False


def tesseract_available() -> bool:
    global _tesseract_checked, _tesseract_available
    if not _tesseract_checked:
        _tesseract_available = shutil.which("tesseract") is not None
        _tesseract_checked = True
    return _tesseract_available


def ocr_image_bytes(data: bytes, cfg: Config) -> str:
    import pytesseract
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        if image.mode not in {"L", "RGB"}:
            image = image.convert("RGB")
        return pytesseract.image_to_string(image, lang=cfg.ocr_lang).strip()


# ---------------------------------------------------------------------------
# Per format converters
# ---------------------------------------------------------------------------

def convert_pdf(path: Path, cfg: Config, result: Result) -> str:
    try:
        import pymupdf as fitz
    except ImportError:  # PyMuPDF older than 1.24.3 only exposes the fitz name
        import fitz

    doc = fitz.open(path)
    result.pages = doc.page_count
    pages: list[str] = []
    zoom = cfg.ocr_dpi / 72.0

    for page in doc:
        text = page.get_text("text").strip()
        needs_ocr = cfg.ocr == "always" or (
            cfg.ocr == "auto" and len(text) < cfg.min_chars_per_page
        )
        if needs_ocr and tesseract_available():
            pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            ocr_text = ocr_image_bytes(pixmap.tobytes("png"), cfg)
            # Keep whichever extraction actually produced more content.
            if len(ocr_text) > len(text):
                text = ocr_text
                result.ocr_used = True
        elif needs_ocr:
            warning = "tesseract not installed, OCR skipped"
            if warning not in result.warnings:
                result.warnings.append(warning)
        pages.append(text)

    doc.close()

    if cfg.compact:
        pages = strip_repeated_lines(pages)

    body = []
    for index, text in enumerate(pages, start=1):
        if not text.strip():
            continue
        body.append(f"## Page {index}\n\n{text.strip()}")
    return "\n\n".join(body)


def convert_image(path: Path, cfg: Config, result: Result) -> str:
    if cfg.ocr == "off":
        result.warnings.append("ocr disabled, image produced no text")
        return ""
    if not tesseract_available():
        result.warnings.append("tesseract not installed, image produced no text")
        return ""
    text = ocr_image_bytes(path.read_bytes(), cfg)
    result.ocr_used = bool(text)
    return text


def convert_sheet(path: Path, cfg: Config, result: Result) -> str:
    import pandas as pd

    suffix = path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        separator = "\t" if suffix == ".tsv" else ","
        sheets = {path.stem: pd.read_csv(path, sep=separator, dtype=str)}
    else:
        sheets = pd.read_excel(path, sheet_name=None, dtype=str)

    blocks: list[str] = []
    for name, frame in sheets.items():
        frame = frame.dropna(how="all").dropna(axis=1, how="all").fillna("")
        if frame.empty:
            continue
        result.pages += 1
        blocks.append(f"## {name}\n\n{frame.to_markdown(index=False)}")
    return "\n\n".join(blocks)


def convert_with_markitdown(path: Path) -> str:
    from markitdown import MarkItDown

    return MarkItDown(enable_plugins=False).convert(str(path)).text_content or ""


def convert_legacy_office(path: Path, cfg: Config, result: Result) -> str:
    """Upgrade .doc/.xls/.ppt via LibreOffice, then convert the modern file."""
    if not shutil.which("soffice"):
        raise RuntimeError("libreoffice (soffice) is required for legacy Office formats")

    target_ext = LEGACY_OFFICE[path.suffix.lower()]
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [
                "soffice",
                "--headless",
                "--convert-to",
                target_ext.lstrip("."),
                "--outdir",
                tmp,
                str(path),
            ],
            check=True,
            capture_output=True,
            timeout=300,
        )
        converted = Path(tmp) / f"{path.stem}{target_ext}"
        if not converted.exists():
            raise RuntimeError(f"libreoffice did not produce {converted.name}")
        if target_ext == ".xlsx":
            return convert_sheet(converted, cfg, result)
        return convert_with_markitdown(converted)


def convert_file(path: Path, cfg: Config, result: Result) -> str:
    suffix = path.suffix.lower()
    if suffix in PDF_EXTS:
        result.kind = "pdf"
        return convert_pdf(path, cfg, result)
    if suffix in IMAGE_EXTS:
        result.kind = "image"
        return convert_image(path, cfg, result)
    if suffix in SHEET_EXTS:
        result.kind = "spreadsheet"
        return convert_sheet(path, cfg, result)
    if suffix in LEGACY_OFFICE:
        result.kind = "legacy-office"
        return convert_legacy_office(path, cfg, result)
    if suffix in MARKITDOWN_EXTS:
        result.kind = "document"
        return convert_with_markitdown(path)
    if suffix in TEXT_EXTS:
        result.kind = "text"
        return path.read_text(encoding="utf-8", errors="replace")
    result.kind = "document"
    return convert_with_markitdown(path)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def output_path_for(source: Path, cfg: Config, used: set[Path]) -> Path:
    try:
        relative = source.relative_to(Path.cwd())
    except ValueError:
        relative = Path(source.name)
    candidate = cfg.output_dir / relative.with_suffix(".md")
    # Two inputs may differ only by extension, so disambiguate collisions.
    counter = 2
    while candidate in used:
        candidate = candidate.with_name(f"{candidate.stem}-{counter}.md")
        counter += 1
    used.add(candidate)
    return candidate


def yaml_quote(value: str) -> str:
    """Quote a scalar so colons, quotes and hashes in a path stay valid YAML."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def front_matter(source: Path, result: Result) -> str:
    return (
        "---\n"
        f"source: {yaml_quote(source.name)}\n"
        f"source_path: {yaml_quote(result.source)}\n"
        f"kind: {yaml_quote(result.kind)}\n"
        f"pages: {result.pages}\n"
        f"ocr: {str(result.ocr_used).lower()}\n"
        "---\n\n"
    )


def load_config() -> Config:
    raw_patterns = env("INPUT_FILES") or DEFAULT_PATTERN
    patterns = split_patterns(raw_patterns)
    ocr = env("INPUT_OCR", "auto").lower()
    if ocr not in {"auto", "always", "off"}:
        print(f"::warning::unknown ocr mode '{ocr}', falling back to auto")
        ocr = "auto"
    max_mb = env_int("INPUT_MAX_FILE_MB", 100)
    return Config(
        patterns=patterns,
        output_dir=Path(env("INPUT_OUTPUT_DIR", "markdown") or "markdown"),
        ocr=ocr,
        ocr_lang=env("INPUT_OCR_LANG", "eng") or "eng",
        ocr_dpi=env_int("INPUT_OCR_DPI", 200),
        min_chars_per_page=env_int("INPUT_MIN_CHARS_PER_PAGE", 100),
        max_file_bytes=max_mb * 1024 * 1024 if max_mb > 0 else 0,
        compact=env_bool("INPUT_COMPACT", True),
        merge_into=env("INPUT_MERGE_INTO"),
        fail_on_error=env_bool("INPUT_FAIL_ON_ERROR", False),
    )


def write_outputs(values: dict[str, object]) -> None:
    target = os.environ.get("GITHUB_OUTPUT")
    if not target:
        return
    with open(target, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def write_summary(results: list[Result], total_tokens: int, saved_pct: float) -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if not target:
        return
    converted = [r for r in results if r.status == "converted"]
    lines = [
        "## Docs to Markdown",
        "",
        f"Converted **{len(converted)}** of **{len(results)}** files, "
        f"about **{total_tokens:,}** tokens of Markdown "
        f"({saved_pct:.1f}% smaller than the raw inputs).",
        "",
        "| Source | Kind | Pages | OCR | Tokens | Status |",
        "| --- | --- | ---: | :-: | ---: | --- |",
    ]
    for r in results:
        lines.append(
            f"| `{r.source}` | {r.kind or '-'} | {r.pages or '-'} | "
            f"{'yes' if r.ocr_used else 'no'} | {r.approx_tokens or '-'} | {r.status} |"
        )
    with open(target, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def main() -> int:
    cfg = load_config()
    sources = discover(cfg.patterns, cfg.output_dir)
    if not sources:
        print(f"::warning::no input files matched {cfg.patterns}")

    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    results: list[Result] = []
    used_paths: set[Path] = set()
    merged_sections: list[str] = []

    for source in sources:
        display = os.path.relpath(source, Path.cwd())
        result = Result(source=display, source_bytes=source.stat().st_size)

        if cfg.max_file_bytes and result.source_bytes > cfg.max_file_bytes:
            result.status = "skipped"
            result.error = f"larger than {cfg.max_file_bytes // (1024 * 1024)} MB"
            print(f"::warning file={display}::skipped, {result.error}")
            results.append(result)
            continue

        print(f"converting {display}")
        try:
            markdown = convert_file(source, cfg, result)
        except Exception as exc:  # noqa: BLE001 - one bad file must not stop the run
            result.status = "failed"
            result.error = f"{type(exc).__name__}: {exc}"
            print(f"::error file={display}::{result.error}")
            results.append(result)
            continue

        if cfg.compact:
            markdown = compact_markdown(markdown)
        if not markdown.strip():
            result.status = "empty"
            result.error = "no text extracted"
            print(f"::warning file={display}::no text extracted")

        document = f"{front_matter(source, result)}# {source.name}\n\n{markdown}"
        destination = output_path_for(source, cfg, used_paths)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(document, encoding="utf-8")

        result.output = str(destination)
        result.markdown_chars = len(document)
        result.approx_tokens = approx_tokens(document)
        for warning in result.warnings:
            print(f"::warning file={display}::{warning}")
        results.append(result)
        merged_sections.append(document)

    manifest_path = cfg.output_dir / "manifest.json"
    total_tokens = sum(r.approx_tokens for r in results)
    # Skipped and failed inputs produced no Markdown, so counting their bytes
    # here would report a reduction the action did not actually achieve.
    written = [r for r in results if r.markdown_chars]
    total_source_bytes = sum(r.source_bytes for r in written)
    total_md_chars = sum(r.markdown_chars for r in written)
    saved_pct = (
        max(0.0, (1 - total_md_chars / total_source_bytes) * 100)
        if total_source_bytes
        else 0.0
    )

    manifest_path.write_text(
        json.dumps(
            {
                "files": [asdict(r) for r in results],
                "totals": {
                    "converted": sum(1 for r in results if r.status == "converted"),
                    "failed": sum(1 for r in results if r.status == "failed"),
                    "skipped": sum(1 for r in results if r.status == "skipped"),
                    "empty": sum(1 for r in results if r.status == "empty"),
                    "approx_tokens": total_tokens,
                    "source_bytes": total_source_bytes,
                    "markdown_chars": total_md_chars,
                    "reduction_pct": round(saved_pct, 2),
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    merged_file = ""
    if cfg.merge_into and merged_sections:
        merged_path = Path(cfg.merge_into)
        merged_path.parent.mkdir(parents=True, exist_ok=True)
        merged_path.write_text("\n\n---\n\n".join(merged_sections), encoding="utf-8")
        merged_file = str(merged_path)

    failed = sum(1 for r in results if r.status == "failed")
    converted = sum(1 for r in results if r.status == "converted")

    write_outputs(
        {
            "output-dir": str(cfg.output_dir),
            "files-converted": converted,
            "files-failed": failed,
            "manifest": str(manifest_path),
            "merged-file": merged_file,
            "total-tokens": total_tokens,
            "tokens-saved-pct": round(saved_pct, 2),
        }
    )
    write_summary(results, total_tokens, saved_pct)

    print(
        f"done: {converted} converted, {failed} failed, "
        f"~{total_tokens} tokens, {saved_pct:.1f}% smaller than the inputs"
    )
    return 1 if (failed and cfg.fail_on_error) else 0


if __name__ == "__main__":
    sys.exit(main())
