import { inflateRawSync } from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { GeneratedFile } from "@/lib/file-output";
import { createDocxFile, createPdfFile, createTextFile, createXlsxFile, createZip } from "@/lib/file-output";

export type ConversionTargetFormat = "pdf" | "word" | "excel" | "text" | "csv" | "html" | "image" | "images" | "zip";

export class ConversionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

export type SourceDocument = {
  name: string;
  mimeType: string;
  content: Uint8Array;
};

type ExtractedContent = {
  kind: "text" | "csv" | "docx" | "xlsx" | "pdf" | "image" | "powerpoint";
  text: string;
  rows: string[][];
  sourceType: string;
};

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

export function normalizeConversionTarget(value: string): ConversionTargetFormat {
  const normalized = value.toLowerCase();
  if (normalized === "txt") return "text";
  if (normalized === "doc" || normalized === "docx") return "word";
  if (normalized === "xlsx") return "excel";
  if (normalized === "jpg" || normalized === "jpeg" || normalized === "png") return "image";
  if (normalized === "images") return "images";
  return normalized as ConversionTargetFormat;
}

export function detectSourceType(source: Pick<SourceDocument, "name" | "mimeType">) {
  const lower = `${source.mimeType} ${source.name}`.toLowerCase();
  if (lower.includes("pdf") || /\.pdf$/i.test(source.name)) return "pdf";
  if (lower.includes("word") || /\.(docx?|rtf)$/i.test(source.name)) return "word";
  if (lower.includes("excel") || lower.includes("spreadsheet") || /\.(xlsx?|xls)$/i.test(source.name)) return "excel";
  if (lower.includes("powerpoint") || lower.includes("presentation") || /\.(pptx?|ppsx?)$/i.test(source.name)) return "powerpoint";
  if (lower.includes("csv") || /\.csv$/i.test(source.name)) return "csv";
  if (lower.includes("text") || /\.txt$/i.test(source.name)) return "text";
  if (lower.includes("image") || /\.(png|jpe?g|tiff?|bmp|gif|heic)$/i.test(source.name)) return "image";
  if (/\.zip$/i.test(source.name) || lower.includes("zip")) return "zip";
  return "unknown";
}

export async function convertDocumentContent(source: SourceDocument, target: string): Promise<GeneratedFile> {
  const targetFormat = normalizeConversionTarget(target);
  const sourceType = detectSourceType(source);

  if (sourceType === "zip" && targetFormat !== "zip") {
    throw new ConversionError("ZIP archives can only be bundled or downloaded as ZIP. Extract files first before converting their contents.", "UNSUPPORTED_ARCHIVE_CONVERSION");
  }

  if (targetFormat === "zip") {
    return createConvertedZip(source);
  }

  if (targetFormat === "pdf" && isOfficeSource(sourceType)) {
    return convertOfficeDocumentToPdf(source);
  }

  if (sourceType === "image") {
    if (targetFormat === "pdf" && isJpeg(source)) {
      return createJpegPdf(source);
    }
    if (targetFormat === "pdf") {
      throw new ConversionError("This image format needs an image rendering provider before it can be converted into a visual PDF. JPG/JPEG image to PDF is available now.", "IMAGE_RENDERER_REQUIRED");
    }
    if (targetFormat === "text" || targetFormat === "word" || targetFormat === "excel" || targetFormat === "csv") {
      throw new ConversionError("This image needs OCR before text or table output can be generated. Configure an OCR provider, then retry.", "OCR_REQUIRED");
    }
    throw new ConversionError("This image conversion is not supported by the local provider yet.", "UNSUPPORTED_IMAGE_CONVERSION");
  }

  if (targetFormat === "images" || targetFormat === "image") {
    throw new ConversionError("PDF or document page image export requires a rendering provider. Configure a PDF/image rendering service before using this conversion.", "RENDERER_REQUIRED");
  }

  const extracted = extractReadableContent(source);

  if (!hasReadableContent(extracted)) {
    if (sourceType === "pdf") {
      throw new ConversionError("No selectable text was found in this PDF. It may be scanned or image-based; configure OCR and retry, or use Accounting Intelligence for supported bank statements.", "PDF_OCR_REQUIRED");
    }
    throw new ConversionError("We could not extract readable content from this document. It may be encrypted, damaged, or an unsupported format.", "NO_READABLE_CONTENT");
  }

  if (targetFormat === "pdf") {
    if (isOfficeSource(sourceType)) {
      throw new ConversionError("Office to PDF conversion engine unavailable. LibreOffice headless is required for layout-preserving PDF output.", "CONVERSION_ENGINE_UNAVAILABLE");
    }
    return createPdfFile(source.name, contentLines(extracted));
  }

  if (targetFormat === "word") {
    return createDocxFile(source.name, contentLines(extracted));
  }

  if (targetFormat === "excel") {
    return createXlsxFile(source.name, workbookRows(extracted));
  }

  if (targetFormat === "csv") {
    return createCsvFile(source.name, workbookRows(extracted));
  }

  if (targetFormat === "text") {
    return createTextFile(source.name, contentLines(extracted));
  }

  if (targetFormat === "html") {
    return createHtmlFile(source.name, extracted);
  }

  throw new ConversionError(`Conversion to ${targetFormat} is not implemented.`, "UNSUPPORTED_CONVERSION");
}

function extractReadableContent(source: SourceDocument): ExtractedContent {
  const sourceType = detectSourceType(source);

  if (sourceType === "csv") {
    const text = normalizeText(decoder.decode(source.content));
    return { kind: "csv", text, rows: parseCsv(text), sourceType };
  }

  if (sourceType === "text") {
    const text = normalizeText(decoder.decode(source.content));
    return { kind: "text", text, rows: textRows(text), sourceType };
  }

  if (sourceType === "word") {
    const text = extractDocxText(source.content);
    return { kind: "docx", text, rows: textRows(text), sourceType };
  }

  if (sourceType === "excel") {
    const rows = extractXlsxRows(source.content);
    const text = rows.map((row) => row.join("\t")).join("\n");
    return { kind: "xlsx", text, rows, sourceType };
  }

  if (sourceType === "pdf") {
    const pdfInfo = inspectPdf(source.content, source.name);
    const extraction = extractPdfText(source.content, source.name);
    console.info("docucorex.pdf.extraction", {
      fileName: source.name,
      sizeBytes: source.content.byteLength,
      pageCount: pdfInfo.pageCount,
      pageCharacters: extraction.pageCharacters,
      totalCharacters: extraction.text.length,
    });
    if (!normalizeText(extraction.text)) {
      if (!hasOcrEngine()) {
        throw new ConversionError("OCR engine not installed. This PDF appears to be scanned or image-based, and no selectable text could be extracted.", "OCR_ENGINE_UNAVAILABLE");
      }
      throw new ConversionError("OCR fallback is not wired into this conversion worker yet. Configure OCRmyPDF/Tesseract, then retry.", "OCR_FALLBACK_REQUIRED");
    }
    const text = extraction.text;
    return { kind: "pdf", text, rows: textRows(text), sourceType };
  }

  const text = normalizeText(decoder.decode(source.content));
  return { kind: "text", text, rows: textRows(text), sourceType };
}

function isOfficeSource(sourceType: string) {
  return sourceType === "word" || sourceType === "excel" || sourceType === "powerpoint";
}

function convertOfficeDocumentToPdf(source: SourceDocument): GeneratedFile {
  const soffice = findExecutable("LIBREOFFICE_PATH", [
    "soffice",
    "libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/Users/patric/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/soffice",
    "/Users/patric/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice",
  ]);

  if (!soffice) {
    throw new ConversionError("Conversion engine unavailable. LibreOffice headless is required for DOCX, XLSX and PPTX to PDF conversion.", "CONVERSION_ENGINE_UNAVAILABLE");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "docucorex-convert-"));
  const extension = extname(source.name) || extensionForSourceType(detectSourceType(source));
  const inputPath = join(tempDir, `${baseName(source.name)}${extension}`);

  try {
    writeFileSync(inputPath, source.content);
    const result = spawnSync(
      soffice,
      ["--headless", "--norestore", "--nodefault", "--nolockcheck", "--nofirststartwizard", "--convert-to", "pdf", "--outdir", tempDir, inputPath],
      {
        cwd: tempDir,
        env: conversionProcessEnv(),
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    if (result.error || result.status !== 0) {
      const reason = result.error?.message || result.stderr || result.stdout || `LibreOffice exited with status ${result.status}`;
      throw new ConversionError(`Conversion engine unavailable. LibreOffice could not render this file: ${reason.trim()}`, "CONVERSION_ENGINE_UNAVAILABLE");
    }

    const outputPath = join(tempDir, `${baseName(source.name)}.pdf`);
    if (!existsSync(outputPath)) {
      throw new ConversionError("Conversion engine failed to produce a PDF output file.", "CONVERSION_OUTPUT_MISSING");
    }

    const content = new Uint8Array(readFileSync(outputPath));
    const pdfInfo = inspectPdf(content, `${baseName(source.name)}.pdf`);
    if (pdfInfo.pageCount < 1) {
      throw new ConversionError("Conversion engine produced a PDF with no pages.", "INVALID_CONVERTED_PDF");
    }

    return {
      fileName: `${baseName(source.name)}.pdf`,
      contentType: "application/pdf",
      content,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extensionForSourceType(sourceType: string) {
  if (sourceType === "word") return ".docx";
  if (sourceType === "excel") return ".xlsx";
  if (sourceType === "powerpoint") return ".pptx";
  return ".bin";
}

function conversionProcessEnv() {
  const popplerLib = "/Users/patric/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/lib";
  return {
    ...process.env,
    PATH: [
      "/Users/patric/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin",
      process.env.PATH ?? "",
    ].filter(Boolean).join(":"),
    DYLD_FALLBACK_LIBRARY_PATH: [
      popplerLib,
      process.env.DYLD_FALLBACK_LIBRARY_PATH ?? "",
    ].filter(Boolean).join(":"),
  };
}

function hasReadableContent(content: ExtractedContent) {
  const usefulText = content.text.replace(/[^\p{L}\p{N}]+/gu, "");
  return usefulText.length >= 8 || content.rows.some((row) => row.some((cell) => cell.trim().length >= 2));
}

function contentLines(content: ExtractedContent) {
  if (content.rows.length && content.kind !== "text") {
    return content.rows.map((row) => row.join("    "));
  }
  return content.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function workbookRows(content: ExtractedContent) {
  if (content.rows.length) {
    return content.rows;
  }
  return [["Extracted Text"], ...contentLines(content).map((line) => [line])];
}

function textRows(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
      if (line.includes(",")) return parseCsvLine(line);
      return [line];
    });
}

function normalizeText(value: string) {
  return value.replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function xmlText(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function readZipEntries(bytes: Uint8Array) {
  const entries = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 30 < bytes.length) {
    const signature = readUint32(bytes, offset);
    if (signature !== 0x04034b50) break;
    const compression = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const fileNameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + fileNameLength));
    const compressed = bytes.slice(dataStart, dataEnd);
    const content = compression === 8 ? new Uint8Array(inflateRawSync(compressed)) : compressed;
    entries.set(name, content);
    offset = dataEnd;
  }

  return entries;
}

function readUint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function extractDocxText(bytes: Uint8Array) {
  const entries = readZipEntries(bytes);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) return "";
  const xml = decoder.decode(documentXml);
  return normalizeText(
    xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<w:t[^>]*>/g, "")
      .replace(/<\/w:t>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " "),
  );
}

function extractXlsxRows(bytes: Uint8Array) {
  const entries = readZipEntries(bytes);
  const sharedStringsXml = entries.get("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml ? Array.from(decoder.decode(sharedStringsXml).matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)).map((match) => xmlText(match[1])) : [];
  const sheetName = Array.from(entries.keys()).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) return [];

  const sheetXml = decoder.decode(entries.get(sheetName)!);
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const value = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      if (attrs.includes('t="s"')) {
        cells.push(sharedStrings[Number(value)] ?? "");
      } else {
        cells.push(xmlText(value));
      }
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function inspectPdf(bytes: Uint8Array, fileName: string) {
  if (!bytes.byteLength) {
    throw new ConversionError("The PDF file is empty.", "EMPTY_PDF");
  }

  if (!startsWithPdfHeader(bytes)) {
    throw new ConversionError("The uploaded file does not appear to be a valid PDF.", "INVALID_PDF_HEADER");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "docucorex-pdf-"));
  const pdfPath = join(tempDir, `${baseName(fileName)}.pdf`);

  try {
    writeFileSync(pdfPath, bytes);
    const pdfinfo = findExecutable("PDFINFO_PATH", [
      "pdfinfo",
      "/Users/patric/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdfinfo",
    ]);

    let pageCount = 0;
    if (pdfinfo) {
      try {
        const output = execFileSync(pdfinfo, [pdfPath], { encoding: "utf8", timeout: 30_000 });
        pageCount = Number(output.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
      } catch {
        pageCount = 0;
      }
    }

    if (!pageCount) {
      pageCount = countPdfPagesFromBytes(bytes);
    }

    if (pageCount < 1) {
      throw new ConversionError("The PDF has no readable pages.", "PDF_HAS_NO_PAGES");
    }

    return { pageCount };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractPdfText(bytes: Uint8Array, fileName: string) {
  const tempDir = mkdtempSync(join(tmpdir(), "docucorex-pdf-text-"));
  const pdfPath = join(tempDir, `${baseName(fileName)}.pdf`);

  try {
    writeFileSync(pdfPath, bytes);
    const python = findExecutable("PYTHON_PATH", [
      "/Users/patric/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
      "python3",
      "python",
    ]);

    if (python) {
      const script = `
import json
import sys

path = sys.argv[1]
pages = []
try:
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            pages.append(page.extract_text() or "")
except Exception:
    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        pages = [(page.extract_text() or "") for page in reader.pages]
    except Exception as exc:
        print(json.dumps({"error": str(exc), "pages": []}))
        sys.exit(0)

print(json.dumps({"pages": pages}))
`;
      const result = spawnSync(python, ["-c", script, pdfPath], { encoding: "utf8", timeout: 60_000 });
      if (result.status === 0 && result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout) as { pages?: string[] };
          const pages = Array.isArray(parsed.pages) ? parsed.pages.map((page) => normalizeText(page)) : [];
          return {
            text: normalizeText(pages.join("\n\n")),
            pageCharacters: pages.map((page) => page.length),
          };
        } catch {
          // Fall through to the lightweight parser.
        }
      }
    }

    return extractPdfTextWithLightweightParser(bytes);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractPdfTextWithLightweightParser(bytes: Uint8Array) {
  const raw = decoder.decode(bytes);
  const pieces: string[] = [];

  for (const match of raw.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    pieces.push(unescapePdfString(match[0].replace(/\)\s*Tj$/, "").slice(1)));
  }

  for (const match of raw.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    for (const part of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      pieces.push(unescapePdfString(part[0].slice(1, -1)));
    }
  }

  const text = normalizeText(pieces.join("\n"));
  return { text, pageCharacters: text ? [text.length] : [] };
}

function startsWithPdfHeader(bytes: Uint8Array) {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function countPdfPagesFromBytes(bytes: Uint8Array) {
  const raw = decoder.decode(bytes);
  return Array.from(raw.matchAll(/\/Type\s*\/Page\b/g)).length;
}

function unescapePdfString(value: string) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function parseCsv(text: string) {
  return text.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"" && line[index + 1] === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function csvEscape(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function createCsvFile(sourceName: string, rows: string[][]): GeneratedFile {
  return {
    fileName: `${baseName(sourceName)}.csv`,
    contentType: "text/csv; charset=utf-8",
    content: encoder.encode(rows.map((row) => row.map(csvEscape).join(",")).join("\n")),
  };
}

function createHtmlFile(sourceName: string, content: ExtractedContent): GeneratedFile {
  const body = content.rows.length
    ? `<table>${content.rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlEscape(cell)}</td>`).join("")}</tr>`).join("")}</table>`
    : `<pre>${htmlEscape(content.text)}</pre>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(sourceName)}</title><style>body{font-family:Arial,sans-serif;margin:32px;line-height:1.45}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:6px}pre{white-space:pre-wrap}</style></head><body><h1>${htmlEscape(sourceName)}</h1>${body}</body></html>`;
  return {
    fileName: `${baseName(sourceName)}.html`,
    contentType: "text/html; charset=utf-8",
    content: encoder.encode(html),
  };
}

function createConvertedZip(source: SourceDocument): GeneratedFile {
  const entries = [
    {
      name: source.name.replace(/^\/+/, ""),
      content: source.content,
    },
  ];

  try {
    const extracted = extractReadableContent(source);
    if (hasReadableContent(extracted)) {
      entries.push({
        name: `${baseName(source.name)}-extracted-text.txt`,
        content: encoder.encode(contentLines(extracted).join("\n")),
      });
    }
  } catch {
    // ZIP packaging should still include the original even if text extraction is unavailable.
  }

  return {
    fileName: `${baseName(source.name)}.zip`,
    contentType: "application/zip",
    content: createZip(entries),
  };
}

function isJpeg(source: SourceDocument) {
  return source.content[0] === 0xff && source.content[1] === 0xd8 && (/jpe?g/i.test(source.mimeType) || /\.jpe?g$/i.test(source.name));
}

function createJpegPdf(source: SourceDocument): GeneratedFile {
  const imageName = "Im1";
  const imageBytes = source.content;
  const stream = "q\n500 0 0 360 56 360 cm\n/Im1 Do\nQ";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /${imageName} 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width 1000 /Height 720 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n${binaryString(imageBytes)}\nendstream`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return { fileName: `${baseName(source.name)}.pdf`, contentType: "application/pdf", content: latin1Bytes(body) };
}

function binaryString(bytes: Uint8Array) {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
}

function latin1Bytes(value: string) {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    output[index] = value.charCodeAt(index) & 0xff;
  }
  return output;
}

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function findExecutable(envName: string, candidates: string[]) {
  const explicit = process.env[envName]?.trim();
  const allCandidates = explicit ? [explicit, ...candidates] : candidates;

  for (const candidate of allCandidates) {
    if (!candidate) continue;
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }

    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    const found = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
    if (found) return found;
  }

  return null;
}

function hasOcrEngine() {
  return Boolean(findExecutable("OCRMYPDF_PATH", ["ocrmypdf"]) || findExecutable("TESSERACT_PATH", ["tesseract"]));
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
}
