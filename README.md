# Docs to Markdown

A GitHub Action that turns PDFs, Word documents, Excel sheets, PowerPoint decks and
scanned images into plain Markdown files.

Why bother? AI tools and code search can't read a `.pdf` or an `.xlsx` — they read text.
This action does the reading for you, on every push, and leaves behind text files anyone
(or anything) can open.

## Quick start

Put your documents somewhere in the repo, for example a `docs/` folder. Then create the
file `.github/workflows/convert.yml`:

```yaml
name: Convert documents to Markdown

on:
  push:
    paths:
      - "docs/**"

jobs:
  convert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: srinivasan-78/doc2md-action@v1
        with:
          files: docs/**/*
          merge-into: markdown/context.md

      - uses: actions/upload-artifact@v4
        with:
          name: markdown
          path: markdown/
```

Push it. When the run finishes, open the workflow run on GitHub and download the
`markdown` artifact — that's your documents as text.

That's the whole thing. Everything below is optional.

## What the two settings above do

- `files` — which documents to convert. `docs/**/*` means "everything under `docs/`,
  including subfolders". You can list several patterns, one per line.
- `merge-into` — also glue every converted document into one big file. Handy when you
  want to paste the lot into ChatGPT or Claude. Leave it out and you just get one `.md`
  per document instead.

## What it can read

| You have | You get |
| --- | --- |
| PDF | The text of each page. If a page is a scan with no text, it is read with OCR |
| Word, PowerPoint, HTML | Headings, paragraphs and lists as Markdown |
| Excel, CSV | One Markdown table per sheet |
| Old Office files (`.doc`, `.xls`, `.ppt`) | Converted to the modern format first, then as above |
| Photos and screenshots (`.png`, `.jpg`, …) | Any text in the image, read with OCR |

Every output file begins with a short header naming the document it came from, so you can
always trace a sentence back to its source.

## Other settings

All optional — the defaults are sensible.

| Setting | Default | What it does |
| --- | --- | --- |
| `files` | every supported file in the repo | Which documents to convert |
| `output-dir` | `markdown` | Where to put the results |
| `ocr` | `auto` | `auto` reads scans only when a page has no text, `always` reads every page as an image (slow), `off` never does |
| `ocr-lang` | `eng` | Language of the scans. Combine with `+`, e.g. `eng+deu` |
| `ocr-dpi` | `200` | Higher values read small print better but take longer |
| `min-chars-per-page` | `100` | A PDF page with fewer characters than this is treated as a scan |
| `max-file-mb` | `100` | Files bigger than this are skipped. `0` means no limit |
| `compact` | `true` | Strips blank lines and the headers and footers repeated on every page |
| `merge-into` | none | Path for a single combined file |
| `fail-on-error` | `false` | Set to `true` to fail the job when a document can't be read |

## Things the action tells you afterwards

Use these in later steps as `${{ steps.<id>.outputs.<name> }}`:

`output-dir`, `files-converted`, `files-failed`, `merged-file`, `total-tokens`,
`tokens-saved-pct`, and `manifest` — the path to a `manifest.json` listing every document,
its page count and whether OCR was needed.

The same numbers appear as a table in the workflow run summary, so usually you don't need
to wire anything up.

## Good to know

- Runs on `ubuntu-latest`. It installs Tesseract (for OCR) and LibreOffice (for old Office
  files) at the start of the job, which adds a minute or two to the first run.
- On Windows or macOS runners the conversion still works, but scans and old Office files
  are skipped with a warning.
- `total-tokens` is an estimate, roughly four characters per token. Close enough for
  budgeting, not a real tokenizer.
- One unreadable document does not stop the run. It is listed as failed and everything
  else still converts.
