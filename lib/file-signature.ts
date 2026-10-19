// Content checks for uploads: does the file actually start like the type its
// extension claims?
//
// validateUploadFiles checks the name and the DECLARED MIME type, both of which
// the client controls, and accepts application/octet-stream outright. So
// "invoice.pdf" could be an executable, an HTML page or anything else, and it
// would be stored and later handed to pdf.js, ocrmypdf, LibreOffice or a
// third-party OCR API as if it were a PDF. This reads the first bytes instead.
//
// Pure and dependency-free: it takes the head of the file, never the whole file,
// so the same check serves the multipart path (bytes in hand) and the direct
// upload path (a ranged read of the stored object).

/** Bytes callers should read from the start of a file. */
export const SIGNATURE_HEAD_BYTES = 8192;

export type SignatureResult = { ok: true } | { ok: false; reason: string };

type Matcher = (head: Uint8Array) => boolean;

const startsWith = (head: Uint8Array, bytes: number[], offset = 0) =>
  head.length >= offset + bytes.length && bytes.every((byte, index) => head[offset + index] === byte);

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

// The PDF spec puts "%PDF-" first, but readers (Acrobat, pdf.js) accept it
// anywhere in the first 1024 bytes, and real scanners emit such files.
const isPdf: Matcher = (head) => {
  const marker = ascii("%PDF-");
  const limit = Math.min(head.length, 1024) - marker.length;
  for (let offset = 0; offset <= limit; offset += 1) {
    if (startsWith(head, marker, offset)) return true;
  }
  return false;
};

const isPng: Matcher = (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg: Matcher = (head) => startsWith(head, [0xff, 0xd8, 0xff]);
const isGif: Matcher = (head) => startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"));
const isBmp: Matcher = (head) => startsWith(head, ascii("BM"));
const isTiff: Matcher = (head) => startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]);

// ISO base media file: "ftyp" at offset 4, then a HEIF-family brand.
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
const isHeic: Matcher = (head) => {
  if (!startsWith(head, ascii("ftyp"), 4) || head.length < 12) return false;
  return HEIF_BRANDS.has(String.fromCharCode(...head.slice(8, 12)));
};

// A ZIP local file header. docx/xlsx/pptx are ZIP containers. An empty archive
// (PK\x05\x06) has nothing to process, so it is not accepted.
const isZip: Matcher = (head) => startsWith(head, [0x50, 0x4b, 0x03, 0x04]);

// Legacy Office (doc/xls/ppt) is an OLE2 compound file.
const isOle: Matcher = (head) => startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const isRtf: Matcher = (head) => startsWith(head, ascii("{\\rtf"));

// Plain text has no signature, so the check is the reverse: refuse content that
// is evidently binary. A NUL byte never appears in UTF-8 or single-byte text;
// UTF-16 text is full of them, so a UTF-16 byte-order mark is accepted.
const isText: Matcher = (head) => {
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true;
  return !head.includes(0x00);
};

const MATCHERS: Record<string, { matches: Matcher; label: string }> = {
  pdf: { matches: isPdf, label: "a PDF" },
  png: { matches: isPng, label: "a PNG image" },
  jpg: { matches: isJpeg, label: "a JPEG image" },
  jpeg: { matches: isJpeg, label: "a JPEG image" },
  gif: { matches: isGif, label: "a GIF image" },
  bmp: { matches: isBmp, label: "a BMP image" },
  tif: { matches: isTiff, label: "a TIFF image" },
  tiff: { matches: isTiff, label: "a TIFF image" },
  heic: { matches: isHeic, label: "a HEIC image" },
  zip: { matches: isZip, label: "a ZIP archive" },
  docx: { matches: isZip, label: "a Word document" },
  xlsx: { matches: isZip, label: "an Excel workbook" },
  pptx: { matches: isZip, label: "a PowerPoint presentation" },
  doc: { matches: isOle, label: "a Word document" },
  xls: { matches: isOle, label: "an Excel workbook" },
  ppt: { matches: isOle, label: "a PowerPoint presentation" },
  rtf: { matches: isRtf, label: "an RTF document" },
  txt: { matches: isText, label: "a text file" },
  csv: { matches: isText, label: "a CSV file" },
};

const extensionOf = (fileName: string) => fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/**
 * Whether the first bytes of `head` are consistent with `fileName`'s extension.
 * `head` should be the first SIGNATURE_HEAD_BYTES of the file (fewer is fine for
 * a smaller file). An extension with no rule fails: validateUploadFiles decides
 * which extensions exist, and a new one must be given a rule here on purpose.
 */
export function checkFileSignature(fileName: string, head: Uint8Array): SignatureResult {
  const name = fileName || "File";
  if (head.length === 0) return { ok: false, reason: `${name} is empty.` };

  const rule = MATCHERS[extensionOf(fileName)];
  if (!rule) return { ok: false, reason: `${name} is not a supported file type.` };

  return rule.matches(head)
    ? { ok: true }
    : { ok: false, reason: `${name} does not look like ${rule.label}. It may be damaged or renamed from another type.` };
}

/**
 * Read at most `limit` bytes from a response body, then stop. Used for a ranged
 * read of a stored object: storage normally answers 206 with just the range, but
 * if it ignores the Range header and sends the whole (up to 200 MB) object, this
 * still reads only the head and cancels the rest.
 */
export async function readResponseHead(response: Response, limit = SIGNATURE_HEAD_BYTES): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const head = new Uint8Array(limit);
  let filled = 0;
  try {
    while (filled < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, limit - filled);
      head.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return head.slice(0, filled);
}
