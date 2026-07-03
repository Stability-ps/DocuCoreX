import { inflateRawSync } from "node:zlib";
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
  kind: "text" | "csv" | "docx" | "xlsx" | "pdf" | "image";
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
  if (lower.includes("csv") || /\.csv$/i.test(source.name)) return "csv";
  if (lower.includes("text") || /\.txt$/i.test(source.name)) return "text";
  if (lower.includes("image") || /\.(png|jpe?g|tiff?|bmp|gif|heic)$/i.test(source.name)) return "image";
  if (/\.zip$/i.test(source.name) || lower.includes("zip")) return "zip";
  return "unknown";
}

export async function convertDocumentContent(source: SourceDocument, target: string): Promise<GeneratedFile> {
  const targetFormat = normalizeConversionTarget(target);
  const sourceType = detectSourceType(source);

  if (targetFormat === "images" || targetFormat === "image") {
    throw new ConversionError("PDF or document page image export requires a rendering provider. Configure a PDF/image rendering service before using this conversion.", "RENDERER_REQUIRED");
  }

  if (sourceType === "zip" && targetFormat !== "zip") {
    throw new ConversionError("ZIP archives can only be bundled or downloaded as ZIP. Extract files first before converting their contents.", "UNSUPPORTED_ARCHIVE_CONVERSION");
  }

  if (targetFormat === "zip") {
    return createConvertedZip(source);
  }

  if (sourceType === "image") {
    if (targetFormat === "pdf" && isJpeg(source)) {
      return createJpegPdf(source);
    }
    throw new ConversionError("Image OCR or image conversion needs an OCR/image rendering provider. No readable text was extracted from this image.", "OCR_REQUIRED");
  }

  const extracted = extractReadableContent(source);

  if (!hasReadableContent(extracted)) {
    throw new ConversionError("We could not extract readable content from this document. It may be encrypted, scanned without OCR, damaged, or an unsupported format.", "NO_READABLE_CONTENT");
  }

  if (targetFormat === "pdf") {
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
    const text = extractPdfText(source.content);
    return { kind: "pdf", text, rows: textRows(text), sourceType };
  }

  const text = normalizeText(decoder.decode(source.content));
  return { kind: "text", text, rows: textRows(text), sourceType };
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

function extractPdfText(bytes: Uint8Array) {
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

  return normalizeText(pieces.join("\n"));
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

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
}
