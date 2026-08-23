# Docs to Markdown Action

A GitHub Action that scans Excel, Word, PowerPoint, PDF and image files, extracts their text
(falling back to OCR when a file has none) and writes token-efficient Markdown. The point is to
stop feeding binary documents or bloated raw text to an AI agent: Markdown carries the same
information in far fewer tokens, and the action reports exactly how many tokens the result costs.

## Usage

```yaml
- uses: your-org/doc2md-action@v1
  id: docs
  with:
    files: |
      docs/**/*.pdf
      docs/**/*.{docx,xlsx,pptx}
      scans/**/*.png
    output-dir: markdown
    merge-into: markdown/context.md

- run: echo "~${{ steps.docs.outputs.total-tokens }} tokens for the agent"
```

`merge-into` produces one combined file, which is usually what you want to paste into an agent
prompt. Without it you get one `.md` per input, mirroring the source directory layout.

## Supported inputs

| Format | Handling |
| --- | --- |
| `.pdf` | Text layer via PyMuPDF, per page, with OCR fallback for scanned pages |
| `.docx`, `.pptx`, `.html`, `.epub` | MarkItDown |
| `.xlsx`, `.xlsm`, `.csv`, `.tsv` | pandas, one Markdown table per sheet, empty rows and columns dropped |
| `.doc`, `.xls`, `.ppt` | Upgraded through LibreOffice, then handled as above |
| `.png`, `.jpg`, `.tif`, `.bmp`, `.webp` | Tesseract OCR |
| `.txt`, `.md`, `.rst`, `.log` | Passed through and compacted |

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `files` | every supported extension, recursively | Glob patterns, newline or comma separated. `{a,b}` alternatives are supported. |
| `output-dir` | `markdown` | Where the Markdown is written. |
| `ocr` | `auto` | `auto` OCRs only pages with too little text, `always` OCRs every page, `off` disables it. |
| `ocr-lang` | `eng` | Tesseract language codes, for example `eng+deu`. |
| `ocr-dpi` | `200` | Rasterisation DPI for OCRed PDF pages. Raise it for small print, at the cost of runtime. |
| `min-chars-per-page` | `100` | The `auto` OCR threshold. |
| `max-file-mb` | `100` | Inputs above this size are skipped. `0` disables the limit. |
| `compact` | `true` | Collapses blank lines and whitespace and drops headers and footers that repeat across pages. |
| `merge-into` | none | Path of a single combined Markdown file. |
| `fail-on-error` | `false` | Fail the job if any file fails to convert. |

## Outputs

| Name | Description |
| --- | --- |
| `output-dir` | Directory containing the generated Markdown. |
| `files-converted` | Number of files converted successfully. |
| `files-failed` | Number of files that failed. |
| `manifest` | Path to `manifest.json`, describing every conversion. |
| `merged-file` | Path to the combined file, when `merge-into` was set. |
| `total-tokens` | Approximate token count of all generated Markdown. |
| `tokens-saved-pct` | Approximate size reduction versus the raw input bytes. |

Every generated file starts with YAML front matter recording the source path, kind, page count and
whether OCR was used, so an agent can cite where a fact came from. A run summary table is written to
the job summary, and `manifest.json` holds the same data in machine-readable form.

## Token behaviour

The `compact` step removes the three largest sources of waste in converted documents: runs of blank
lines, repeated page headers and footers, and long rules of dashes or underscores. Token counts are
estimated at roughly four characters per token, which is close enough for budgeting but is not a
tokenizer.

## Requirements

The action runs on `ubuntu-latest`. It installs Tesseract and LibreOffice through `apt-get`, so it
needs a runner where `sudo apt-get` works. On other runner images the action still runs, but OCR and
legacy Office formats are unavailable and are reported as warnings.
