/*!
 * @authormark v1 -- do not remove (authorship watermark)⁠​‌‌​‌‌‌​​‌​​​‌​​​‌‌‌​‌​​​‌‌‌‌​‌​​‌​‌​‌‌‌​​‌‌‌​​​​‌‌​‌​​​​‌‌​​‌​‌​‌​​‌​​​​‌‌​‌‌​​​‌​‌​‌​‌​‌​‌​‌‌‌​‌‌​‌​​‌​‌‌‌​​​‌​​‌‌‌​​​​‌‌​‌‌‌​​‌‌‌​‌​​​‌​‌​​​​​​‌‌‌​​‌​‌​‌​‌‌​​‌​‌‌​‌​​‌‌​‌​​​⁠
 * Copyright (c) 2026 Srinivasan Vijayaraghavan <srinivasan.shyam2000@gmail.com>
 * Author: https://github.com/Srinivasan-78
 * SPDX-License-Identifier: MIT
 * Fingerprint: AMK1.nDtzW8heHlUWiq8ntP9VZh
 */
// Browser port of src/convert.py. Every conversion runs locally in the page:
// no upload endpoint exists, because GitHub Pages serves static files only.

import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp", "gif"]);
const SHEET_EXTS = new Set(["xlsx", "xlsm", "xlsb", "xls", "ods"]);
const TEXT_EXTS = new Set(["txt", "md", "markdown", "rst", "log"]);
const HTML_EXTS = new Set(["html", "htm", "xml"]);
// Binary Word and PowerPoint need LibreOffice, which has no browser equivalent.
// Binary .xls is different: SheetJS reads BIFF directly, so it stays supported.
const NEEDS_LIBREOFFICE = new Set(["doc", "ppt"]);

// One conversion per core, but pdf.js and Tesseract each run their own threads,
// so leave headroom rather than saturating the machine.
const CONCURRENCY = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
const OCR_WORKERS = Math.max(1, Math.min(3, CONCURRENCY - 1));

const state = { results: [], busy: false };

// ---------------------------------------------------------------------------
// Markdown post-processing (identical rules to the Action)
// ---------------------------------------------------------------------------

function stripRepeatedLines(pages) {
  if (pages.length < 3) return pages;

  const edgeLines = (page, top) => {
    const lines = page.split("\n").map((l) => l.trim()).filter(Boolean);
    return top ? lines.slice(0, 2) : lines.slice(-2);
  };

  const counts = new Map();
  for (const page of pages) {
    const edges = new Set([...edgeLines(page, true), ...edgeLines(page, false)]);
    for (const line of edges) counts.set(line, (counts.get(line) || 0) + 1);
  }

  const threshold = Math.max(3, Math.floor(pages.length * 0.6));
  const boilerplate = new Set();
  for (const [line, count] of counts) {
    if (count >= threshold && line.length < 120) boilerplate.add(line);
  }
  if (boilerplate.size === 0) return pages;

  return pages.map((page) =>
    page.split("\n").filter((line) => !boilerplate.has(line.trim())).join("\n")
  );
}

function compactMarkdown(text) {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  // Long runs of table padding or underscores carry no information.
  out = out.replace(/([-_=*])\1{6,}/g, (_, char) => char.repeat(3));
  return out.trim() + "\n";
}

// Rough token estimate: about four characters per token for English prose.
const approxTokens = (text) => Math.max(1, Math.round(text.length / 4));

function yamlQuote(value) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function frontMatter(result) {
  return (
    "---\n" +
    `source: ${yamlQuote(basename(result.source))}\n` +
    `source_path: ${yamlQuote(result.source)}\n` +
    `kind: ${yamlQuote(result.kind)}\n` +
    `pages: ${result.pages}\n` +
    `ocr: ${result.ocrUsed}\n` +
    "---\n\n"
  );
}

const basename = (path) => path.split("/").pop();
const extension = (path) => (basename(path).split(".").length > 1 ? basename(path).split(".").pop().toLowerCase() : "");

// ---------------------------------------------------------------------------
// OCR worker pool
// ---------------------------------------------------------------------------

const ocrPool = { lang: "", workers: [], idle: [], queue: [] };

async function resetOcrPool(lang) {
  if (ocrPool.lang === lang) return;
  await Promise.all(ocrPool.workers.map((worker) => worker.terminate()));
  ocrPool.workers = [];
  ocrPool.idle = [];
  ocrPool.queue = [];
  ocrPool.lang = lang;
}

async function acquireOcrWorker() {
  if (ocrPool.idle.length > 0) return ocrPool.idle.pop();
  if (ocrPool.workers.length < OCR_WORKERS) {
    const worker = await Tesseract.createWorker(ocrPool.lang.split("+"));
    ocrPool.workers.push(worker);
    return worker;
  }
  return new Promise((resolve) => ocrPool.queue.push(resolve));
}

function releaseOcrWorker(worker) {
  const waiting = ocrPool.queue.shift();
  if (waiting) waiting(worker);
  else ocrPool.idle.push(worker);
}

async function ocrImage(source) {
  const worker = await acquireOcrWorker();
  try {
    const { data } = await worker.recognize(source);
    return (data.text || "").trim();
  } finally {
    releaseOcrWorker(worker);
  }
}

// ---------------------------------------------------------------------------
// Per format converters
// ---------------------------------------------------------------------------

async function convertPdf(file, cfg, result) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  result.pages = doc.numPages;

  const zoom = cfg.ocrDpi / 72;
  const pages = [];

  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    let text = joinTextItems(content.items).trim();

    const needsOcr =
      cfg.ocr === "always" || (cfg.ocr === "auto" && text.length < cfg.minCharsPerPage);

    if (needsOcr) {
      const canvas = await renderPage(page, zoom);
      const ocrText = await ocrImage(canvas);
      // Keep whichever extraction actually produced more content.
      if (ocrText.length > text.length) {
        text = ocrText;
        result.ocrUsed = true;
      }
      canvas.width = 0;
      canvas.height = 0;
    }
    pages.push(text);
    page.cleanup();
  }
  await doc.destroy();

  const cleaned = cfg.compact ? stripRepeatedLines(pages) : pages;
  return cleaned
    .map((text, index) => (text.trim() ? `## Page ${index + 1}\n\n${text.trim()}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

// pdf.js returns positioned fragments, so line breaks have to be rebuilt.
function joinTextItems(items) {
  let out = "";
  for (const item of items) {
    out += item.str;
    if (item.hasEOL) out += "\n";
    else if (item.str && !item.str.endsWith(" ")) out += " ";
  }
  return out;
}

async function renderPage(page, zoom) {
  const viewport = page.getViewport({ scale: zoom });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

async function convertImage(file, cfg, result) {
  result.pages = 1;
  const text = await ocrImage(file);
  result.ocrUsed = Boolean(text);
  return text;
}

async function convertSheet(file, cfg, result) {
  const buffer = await file.arrayBuffer();
  const book = XLSX.read(buffer, { type: "array", raw: false });
  return sheetsToMarkdown(book, result);
}

async function convertCsv(file, cfg, result) {
  const text = await file.text();
  const separator = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const book = XLSX.read(text, { type: "string", raw: false, FS: separator });
  return sheetsToMarkdown(book, result, file.name.replace(/\.[^.]+$/, ""));
}

function sheetsToMarkdown(book, result, fallbackName = "Sheet1") {
  const blocks = [];
  for (const name of book.SheetNames.length ? book.SheetNames : [fallbackName]) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
    const table = rowsToMarkdownTable(rows);
    if (!table) continue;
    result.pages += 1;
    blocks.push(`## ${name}\n\n${table}`);
  }
  return blocks.join("\n\n");
}

function rowsToMarkdownTable(rows) {
  const trimmed = rows.filter((row) => row.some((cell) => String(cell).trim() !== ""));
  if (trimmed.length === 0) return "";

  const width = Math.max(...trimmed.map((row) => row.length));
  // Columns that are empty in every row only add separator noise.
  const keep = [];
  for (let column = 0; column < width; column += 1) {
    if (trimmed.some((row) => String(row[column] ?? "").trim() !== "")) keep.push(column);
  }

  const cell = (row, column) =>
    String(row[column] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

  const [head, ...body] = trimmed;
  return [
    `| ${keep.map((c) => cell(head, c)).join(" | ")} |`,
    `| ${keep.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${keep.map((c) => cell(row, c)).join(" | ")} |`),
  ].join("\n");
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

async function convertDocx(file) {
  const buffer = await file.arrayBuffer();
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
  return turndown.turndown(value);
}

async function convertPptx(file, cfg, result) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const blocks = [];
  for (const path of slides) {
    const xml = await zip.file(path).async("string");
    const text = pptxSlideText(xml);
    result.pages += 1;
    if (text.trim()) blocks.push(`## Slide ${slideNumber(path)}\n\n${text.trim()}`);
  }
  return blocks.join("\n\n");
}

const slideNumber = (path) => Number(path.match(/slide(\d+)\.xml$/)[1]);

function pptxSlideText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const lines = [];
  for (const paragraph of doc.getElementsByTagNameNS("*", "p")) {
    const runs = paragraph.getElementsByTagNameNS("*", "t");
    const line = Array.from(runs).map((run) => run.textContent).join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n\n");
}

async function convertHtml(file) {
  return turndown.turndown(await file.text());
}

async function convertFile(file, path, cfg, result) {
  const ext = extension(path);

  if (NEEDS_LIBREOFFICE.has(ext)) {
    throw new Error(
      `.${ext} needs LibreOffice, which cannot run in a browser. Use the GitHub Action for this format.`
    );
  }
  if (ext === "pdf") {
    result.kind = "pdf";
    return convertPdf(file, cfg, result);
  }
  if (IMAGE_EXTS.has(ext)) {
    result.kind = "image";
    if (cfg.ocr === "off") {
      result.warnings.push("ocr disabled, image produced no text");
      return "";
    }
    return convertImage(file, cfg, result);
  }
  if (ext === "csv" || ext === "tsv") {
    result.kind = "spreadsheet";
    return convertCsv(file, cfg, result);
  }
  if (SHEET_EXTS.has(ext)) {
    result.kind = "spreadsheet";
    return convertSheet(file, cfg, result);
  }
  if (ext === "docx") {
    result.kind = "document";
    return convertDocx(file);
  }
  if (ext === "pptx") {
    result.kind = "document";
    return convertPptx(file, cfg, result);
  }
  if (HTML_EXTS.has(ext)) {
    result.kind = "document";
    return convertHtml(file);
  }
  if (TEXT_EXTS.has(ext)) {
    result.kind = "text";
    return file.text();
  }
  throw new Error(`unsupported file type .${ext || "(none)"}`);
}

// ---------------------------------------------------------------------------
// Input expansion: plain files, dropped folders, and zip archives
// ---------------------------------------------------------------------------

const SKIP_ENTRY = /(^|\/)(__MACOSX\/|\.DS_Store$|~\$|\._)/;

async function expandInputs(files) {
  const inputs = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (extension(path) !== "zip") {
      inputs.push({ file, path });
      continue;
    }
    // One level only: a zip inside a zip is left alone rather than recursed into.
    const stem = basename(path).replace(/\.zip$/i, "");
    const zip = await JSZip.loadAsync(file);
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if (entry.dir || SKIP_ENTRY.test(entryPath)) continue;
      const blob = await entry.async("blob");
      inputs.push({
        file: new File([blob], basename(entryPath)),
        path: `${stem}/${entryPath}`,
      });
    }
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function readConfig() {
  return {
    ocr: document.getElementById("ocr").value,
    ocrLang: document.getElementById("ocr-lang").value.trim() || "eng",
    ocrDpi: Number(document.getElementById("ocr-dpi").value) || 200,
    minCharsPerPage: Number(document.getElementById("min-chars").value) || 0,
    compact: document.getElementById("compact").checked,
  };
}

const usedOutputNames = new Set();

function outputNameFor(path) {
  const base = path.replace(/\.[^.]+$/, "");
  let candidate = `${base}.md`;
  // Two inputs may differ only by extension, so disambiguate collisions.
  let counter = 2;
  while (usedOutputNames.has(candidate)) {
    candidate = `${base}-${counter}.md`;
    counter += 1;
  }
  usedOutputNames.add(candidate);
  return candidate;
}

// Run `worker` over `items` with at most `limit` in flight, preserving order.
async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function run(files) {
  if (state.busy) return;
  state.busy = true;
  setBusy(true);

  const cfg = readConfig();
  setStatus("reading input…");

  let inputs;
  try {
    inputs = await expandInputs(files);
  } catch (error) {
    setStatus(`could not read input: ${error.message}`);
    state.busy = false;
    setBusy(false);
    return;
  }

  if (cfg.ocr !== "off") await resetOcrPool(cfg.ocrLang);

  // Reserve a row per input up front so the table keeps the drop order even
  // though conversions finish out of order.
  const slots = inputs.map(({ file, path }) => ({
    source: path,
    output: outputNameFor(path),
    status: "pending",
    kind: "",
    ocrUsed: false,
    pages: 0,
    sourceBytes: file.size,
    markdownChars: 0,
    approxTokens: 0,
    error: "",
    warnings: [],
    blob: null,
  }));
  state.results.push(...slots);
  render();

  let done = 0;
  const tick = () => setStatus(`converting ${done} of ${inputs.length}…`);
  tick();

  await runPool(inputs, CONCURRENCY, async ({ file, path }, index) => {
    const result = slots[index];
    result.status = "converting";
    render();

    let markdown = "";
    try {
      markdown = await convertFile(file, path, cfg, result);
    } catch (error) {
      result.status = "failed";
      result.error = `${error.name}: ${error.message}`;
      usedOutputNames.delete(result.output);
      result.output = "";
      done += 1;
      tick();
      render();
      return;
    }

    if (cfg.compact) markdown = compactMarkdown(markdown);
    result.status = markdown.trim() ? "converted" : "empty";
    if (result.status === "empty") result.error = "no text extracted";

    const document_ = `${frontMatter(result)}# ${basename(path)}\n\n${markdown}`;
    result.markdownChars = document_.length;
    result.approxTokens = approxTokens(document_);
    // Hold the output as a Blob, not a string, so a large batch does not keep
    // every document alive on the JS heap.
    result.blob = new Blob([document_], { type: "text/markdown;charset=utf-8" });
    done += 1;
    tick();
    render();
  });

  setStatus("");
  state.busy = false;
  setBusy(false);
}

function totals() {
  const written = state.results.filter((r) => r.markdownChars);
  const sourceBytes = written.reduce((sum, r) => sum + r.sourceBytes, 0);
  const markdownChars = written.reduce((sum, r) => sum + r.markdownChars, 0);
  return {
    converted: state.results.filter((r) => r.status === "converted").length,
    tokens: state.results.reduce((sum, r) => sum + r.approxTokens, 0),
    savedPct: sourceBytes ? Math.max(0, (1 - markdownChars / sourceBytes) * 100) : 0,
  };
}

function manifest() {
  const { tokens, savedPct } = totals();
  const written = state.results.filter((r) => r.markdownChars);
  return JSON.stringify(
    {
      files: state.results.map(({ blob, ...rest }) => rest),
      totals: {
        converted: state.results.filter((r) => r.status === "converted").length,
        failed: state.results.filter((r) => r.status === "failed").length,
        empty: state.results.filter((r) => r.status === "empty").length,
        approx_tokens: tokens,
        source_bytes: written.reduce((sum, r) => sum + r.sourceBytes, 0),
        markdown_chars: written.reduce((sum, r) => sum + r.markdownChars, 0),
        reduction_pct: Number(savedPct.toFixed(2)),
      },
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const resultsSection = document.getElementById("results");
const tableBody = document.querySelector("#table tbody");
const statusBox = document.getElementById("status");
const preview = document.getElementById("preview");
const toolbarButtons = document.querySelectorAll(".toolbar button");

function setStatus(text) {
  statusBox.textContent = text;
  statusBox.hidden = !text;
}

function setBusy(busy) {
  for (const button of toolbarButtons) button.disabled = busy;
}

let renderQueued = false;

function render() {
  // Conversions finish in bursts, so coalesce redraws into one frame.
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    draw();
  });
}

function draw() {
  resultsSection.hidden = state.results.length === 0;
  tableBody.replaceChildren();

  for (const result of state.results) {
    const row = document.createElement("tr");
    row.append(
      cellNode(result.source),
      cellNode(result.kind || "-"),
      cellNode(result.pages || "-"),
      cellNode(result.ocrUsed ? "yes" : "no"),
      cellNode(result.approxTokens || "-"),
      cellNode(result.error || result.status, result.status)
    );

    const action = document.createElement("td");
    if (result.blob) {
      action.append(
        actionButton("Copy", async (button) => {
          await copyText(await result.blob.text(), button);
        }),
        actionButton("Download", () => saveBlob(basename(result.output), result.blob)),
        actionButton("View", async () => {
          preview.textContent = await result.blob.text();
          preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
        })
      );
    }
    row.append(action);
    tableBody.append(row);
  }

  const { converted, tokens, savedPct } = totals();
  document.getElementById("totals").textContent =
    `Converted ${converted} of ${state.results.length} files, about ${tokens.toLocaleString()} tokens ` +
    `(${savedPct.toFixed(1)}% smaller than the raw inputs).`;
}

function cellNode(text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function actionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn small";
  button.textContent = label;
  button.addEventListener("click", () => handler(button));
  return button;
}

// Assemble every converted document the same way the merged download does.
async function mergedMarkdown() {
  const parts = [];
  for (const result of state.results) {
    if (!result.blob) continue;
    parts.push(await result.blob.text());
  }
  return parts.join("\n\n---\n\n");
}

async function copyText(text, button) {
  const label = button ? button.textContent : "";
  try {
    await writeClipboard(text);
    if (button) flash(button, "Copied");
    else setStatus(`copied ${text.length.toLocaleString()} characters`);
  } catch (error) {
    if (button) flash(button, "Press Ctrl+C");
    setStatus(`could not copy automatically: ${error.message}. The text is selected, press Ctrl+C.`);
  } finally {
    if (button) setTimeout(() => (button.textContent = label), 1500);
  }
}

async function writeClipboard(text) {
  // navigator.clipboard needs a secure context, which file:// and plain http
  // outside localhost do not provide, so fall back to a selected textarea.
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("clipboard blocked by the browser");
}

function flash(button, message) {
  button.textContent = message;
}

function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

document.getElementById("download-zip").addEventListener("click", async () => {
  const zip = new JSZip();
  for (const result of state.results) {
    if (result.blob) zip.file(result.output, result.blob);
  }
  zip.file("manifest.json", manifest());
  setStatus("building zip…");
  const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  setStatus("");
  saveBlob("markdown.zip", archive);
});

document.getElementById("download-merged").addEventListener("click", async () => {
  const parts = [];
  for (const result of state.results) {
    if (!result.blob) continue;
    if (parts.length) parts.push("\n\n---\n\n");
    parts.push(result.blob);
  }
  if (parts.length) {
    saveBlob("context.md", new Blob(parts, { type: "text/markdown;charset=utf-8" }));
  }
});

document.getElementById("copy-merged").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const text = await mergedMarkdown();
  if (text) await copyText(text, button);
});

document.getElementById("copy-preview").addEventListener("click", async (event) => {
  if (preview.textContent) await copyText(preview.textContent, event.currentTarget);
});

document.getElementById("clear").addEventListener("click", () => {
  state.results = [];
  usedOutputNames.clear();
  preview.textContent = "";
  draw();
});

for (const id of ["picker", "folder-picker"]) {
  document.getElementById(id).addEventListener("change", (event) => {
    const files = Array.from(event.target.files);
    event.target.value = "";
    run(files);
  });
}

const drop = document.getElementById("drop");
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", async (event) => {
  event.preventDefault();
  run(await filesFromDataTransfer(event.dataTransfer));
});

// A dropped folder arrives as a directory entry, so walk it to reach the files.
async function filesFromDataTransfer(transfer) {
  const entries = Array.from(transfer.items)
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length === 0) return Array.from(transfer.files);

  const files = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(file, "webkitRelativePath", { value: prefix + entry.name });
      files.push(file);
      return;
    }
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    } while (batch.length > 0); // readEntries returns at most 100 entries per call
  };

  for (const entry of entries) await walk(entry, "");
  return files;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const themeToggle = document.getElementById("theme-toggle");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  themeToggle.setAttribute("aria-pressed", String(theme === "light"));
  try {
    localStorage.setItem("theme", theme);
  } catch (error) {
    // Private browsing can refuse storage; the toggle still works for this visit.
  }
}

applyTheme(document.documentElement.getAttribute("data-theme") || "dark");

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});
