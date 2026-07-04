const textEncoder = new TextEncoder();

export type GeneratedFile = {
  fileName: string;
  contentType: string;
  content: Uint8Array;
  artifacts?: GeneratedFile[];
};

type ZipEntry = {
  name: string;
  content: Uint8Array;
};

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, dosDate };
}

function writeUint16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function createZip(entries: ZipEntry[]) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const { time, dosDate } = dosDateTime();

  for (const entry of entries) {
    const name = textEncoder.encode(entry.name.replace(/^\/+/, ""));
    const content = entry.content;
    const crc = crc32(content);
    const local: number[] = [];
    writeUint32(local, 0x04034b50);
    writeUint16(local, 20);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, time);
    writeUint16(local, dosDate);
    writeUint32(local, crc);
    writeUint32(local, content.length);
    writeUint32(local, content.length);
    writeUint16(local, name.length);
    writeUint16(local, 0);
    const localHeader = concat([new Uint8Array(local), name, content]);
    localParts.push(localHeader);

    const central: number[] = [];
    writeUint32(central, 0x02014b50);
    writeUint16(central, 20);
    writeUint16(central, 20);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, time);
    writeUint16(central, dosDate);
    writeUint32(central, crc);
    writeUint32(central, content.length);
    writeUint32(central, content.length);
    writeUint16(central, name.length);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, 0);
    writeUint32(central, offset);
    centralParts.push(concat([new Uint8Array(central), name]));
    offset += localHeader.length;
  }

  const centralDirectory = concat(centralParts);
  const end: number[] = [];
  writeUint32(end, 0x06054b50);
  writeUint16(end, 0);
  writeUint16(end, 0);
  writeUint16(end, entries.length);
  writeUint16(end, entries.length);
  writeUint32(end, centralDirectory.length);
  writeUint32(end, offset);
  writeUint16(end, 0);

  return concat([...localParts, centralDirectory, new Uint8Array(end)]);
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
}

function pdfEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function createPdfFile(_sourceName: string, lines: string[]): GeneratedFile {
  const cleanLines = lines.filter((line) => line.trim().length).slice(0, 44);
  const stream = [
    "BT",
    "/F1 18 Tf",
    "72 760 Td",
    `(${pdfEscape(cleanLines[0] ?? "DocuCoreX")}) Tj`,
    "/F1 10 Tf",
    ...cleanLines.slice(1).flatMap((line) => ["0 -18 Td", `(${pdfEscape(line)}) Tj`]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return {
    fileName: `${baseName(_sourceName)}.pdf`,
    contentType: "application/pdf",
    content: textEncoder.encode(body),
  };
}

export function createDocxFile(_sourceName: string, lines: string[]): GeneratedFile {
  const paragraphs = lines
    .map((line) => `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`)
    .join("");
  const content = createZip([
    {
      name: "[Content_Types].xml",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
      ),
    },
  ]);
  return {
    fileName: `${baseName(_sourceName)}.docx`,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    content,
  };
}

export function createXlsxFile(sourceName: string, rows: string[][]): GeneratedFile {
  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((cell, cellIndex) => `<c r="${String.fromCharCode(65 + cellIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`)
          .join("")}</row>`,
    )
    .join("");
  const content = createZip([
    {
      name: "[Content_Types].xml",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="DocuCoreX" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: textEncoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    },
  ]);
  return {
    fileName: `${baseName(sourceName)}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content,
  };
}

export function createTextFile(sourceName: string, lines: string[]): GeneratedFile {
  return {
    fileName: `${baseName(sourceName)}.txt`,
    contentType: "text/plain",
    content: textEncoder.encode(lines.join("\n")),
  };
}
