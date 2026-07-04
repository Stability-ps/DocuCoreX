import { expect, test } from "@playwright/test";
import { createDocxFile, createPdfFile, createXlsxFile } from "@/lib/file-output";
import { convertDocumentContent, ConversionError } from "@/lib/document-conversion-engine";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

test.describe("Document conversion engine", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Run conversion engine smoke tests once.");
  });

  test("converts readable text into a PDF containing source content", async () => {
    const output = await convertDocumentContent(
      {
        name: "letter.txt",
        mimeType: "text/plain",
        content: encoder.encode("Dear client,\nThis is a real letter body."),
      },
      "pdf",
    );

    const body = decoder.decode(output.content);
    expect(output.contentType).toBe("application/pdf");
    expect(body).toContain("This is a real letter body");
    expect(body).not.toContain("DocuCoreX processed document");
    expect(body).not.toContain("Document ID:");
  });

  test("converts CSV into an Excel workbook containing table cells", async () => {
    const output = await convertDocumentContent(
      {
        name: "transactions.csv",
        mimeType: "text/csv",
        content: encoder.encode("Date,Description,Debit,Credit\n2026-07-01,Fuel,100.00,"),
      },
      "excel",
    );

    const body = decoder.decode(output.content);
    expect(output.fileName).toBe("transactions.xlsx");
    expect(body).toContain("Fuel");
    expect(body).toContain("Debit");
    expect(body).not.toContain("Original filename");
  });

  test("converts CSV into text, HTML and Word outputs with source content", async () => {
    const source = {
      name: "transactions.csv",
      mimeType: "text/csv",
      content: encoder.encode("Date,Description,Debit,Credit\n2026-07-01,Fuel,100.00,"),
    };

    for (const target of ["text", "html", "word"] as const) {
      const output = await convertDocumentContent(source, target);
      const body = decoder.decode(output.content);
      expect(body).toContain("Fuel");
      expect(body).toContain("Debit");
      expect(body).not.toContain("DocuCoreX processed document");
      expect(body).not.toContain("Original filename");
    }
  });

  test("extracts DOCX text before converting to plain text", async () => {
    const docx = createDocxFile("contract.docx", ["Service agreement", "Payment due in 30 days"]);
    const output = await convertDocumentContent(
      {
        name: "contract.docx",
        mimeType: docx.contentType,
        content: docx.content,
      },
      "text",
    );

    const body = new TextDecoder().decode(output.content);
    expect(body).toContain("Service agreement");
    expect(body).toContain("Payment due in 30 days");
    expect(body).not.toContain("DocuCoreX processed document");
    expect(body).not.toContain("MIME type");
  });

  test("extracts DOCX text before creating Excel output", async () => {
    const docx = createDocxFile("contract.docx", ["Service agreement", "Payment due in 30 days"]);
    const source = {
      name: "contract.docx",
      mimeType: docx.contentType,
      content: docx.content,
    };

    const output = await convertDocumentContent(source, "excel");
    const body = decoder.decode(output.content);
    expect(body).toContain("Service agreement");
    expect(body).toContain("Payment due in 30 days");
    expect(body).not.toContain("DocuCoreX processed document");
    expect(body).not.toContain("Original MIME type");
  });

  test("DOCX to PDF uses a real rendering engine or fails clearly", async () => {
    const docx = createDocxFile("contract.docx", ["Service agreement", "Payment due in 30 days"]);

    await expectOfficePdfConversion({
      name: "contract.docx",
      mimeType: docx.contentType,
      content: docx.content,
    });
  });

  test("XLSX to PDF uses a real rendering engine or fails clearly", async () => {
    const xlsx = createXlsxFile("statement.xlsx", [
      ["Date", "Description", "Debit", "Credit"],
      ["2026-07-01", "Fuel", "100.00", ""],
    ]);

    await expectOfficePdfConversion({
      name: "statement.xlsx",
      mimeType: xlsx.contentType,
      content: xlsx.content,
    });
  });

  test("PPTX to PDF requires the real rendering engine", async () => {
    const pptx = createMinimalPptx();

    await expectOfficePdfConversion({
      name: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: pptx,
    });
  });

  test("extracts XLSX rows before creating CSV and text outputs", async () => {
    const xlsx = createXlsxFile("statement.xlsx", [
      ["Date", "Description", "Debit", "Credit"],
      ["2026-07-01", "Fuel", "100.00", ""],
    ]);

    for (const target of ["csv", "text"] as const) {
      const output = await convertDocumentContent(
        {
          name: "statement.xlsx",
          mimeType: xlsx.contentType,
          content: xlsx.content,
        },
        target,
      );
      const body = new TextDecoder().decode(output.content);
      expect(body).toContain("Fuel");
      expect(body).toContain("Debit");
      expect(body).not.toContain("Detected type");
    }
  });

  test("extracts simple text-based PDF content before creating Excel", async () => {
    const pdf = createPdfFile("statement.pdf", ["Date Description Debit Credit Balance", "2026-07-01 Fuel 100.00 900.00"]);
    const output = await convertDocumentContent(
      {
        name: "statement.pdf",
        mimeType: "application/pdf",
        content: pdf.content,
      },
      "excel",
    );

    const body = decoder.decode(output.content);
    expect(body).toContain("Fuel");
    expect(body).toContain("Balance");
    expect(body).not.toContain("Detected type");
  });

  test("validates real PDF structure and extracts selectable text", async () => {
    const pdf = createPdfFile("statement.pdf", ["Date Description Debit Credit Balance", "2026-07-01 Fuel 100.00 900.00"]);
    const output = await convertDocumentContent(
      {
        name: "statement.pdf",
        mimeType: "application/pdf",
        content: pdf.content,
      },
      "text",
    );

    const body = new TextDecoder().decode(output.content);
    expect(body).toContain("Fuel");
    expect(countPdfPages(pdf.content)).toBeGreaterThan(0);
  });

  test("scanned PDF fails with OCR unavailable instead of fake success", async () => {
    await expect(
      convertDocumentContent(
        {
          name: "scanned.pdf",
          mimeType: "application/pdf",
          content: createBlankPdf(),
        },
        "text",
      ),
    ).rejects.toThrow(/OCR engine|OCR fallback/);
  });

  test("extracts simple text-based PDF content before creating Word, text, CSV and HTML", async () => {
    const pdf = createPdfFile("statement.pdf", ["Date Description Debit Credit Balance", "2026-07-01 Fuel 100.00 900.00"]);
    const source = {
      name: "statement.pdf",
      mimeType: "application/pdf",
      content: pdf.content,
    };

    for (const target of ["word", "text", "csv", "html"] as const) {
      const output = await convertDocumentContent(source, target);
      const body = decoder.decode(output.content);
      expect(body).toContain("Fuel");
      expect(body).toContain("Balance");
      expect(body).not.toContain("Document ID:");
    }
  });

  test("bundles original file and extracted text for ZIP output", async () => {
    const output = await convertDocumentContent(
      {
        name: "letter.txt",
        mimeType: "text/plain",
        content: encoder.encode("Real converted bundle content"),
      },
      "zip",
    );

    const body = decoder.decode(output.content);
    expect(output.contentType).toBe("application/zip");
    expect(body).toContain("letter.txt");
    expect(body).toContain("extracted-text.txt");
    expect(body).toContain("Real converted bundle content");
  });

  test("fails PDF page image export until a renderer provider is configured", async () => {
    const pdf = createPdfFile("statement.pdf", ["Date Description Debit Credit Balance", "2026-07-01 Fuel 100.00 900.00"]);

    await expect(
      convertDocumentContent(
        {
          name: "statement.pdf",
          mimeType: "application/pdf",
          content: pdf.content,
        },
        "images",
      ),
    ).rejects.toThrow("rendering provider");
  });

  test("fails image OCR when no OCR provider is configured", async () => {
    await expect(
      convertDocumentContent(
        {
          name: "receipt.png",
          mimeType: "image/png",
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
        "text",
      ),
    ).rejects.toThrow(ConversionError);
  });
});

async function expectOfficePdfConversion(source: { name: string; mimeType: string; content: Uint8Array }) {
  try {
    const output = await convertDocumentContent(source, "pdf");
    const body = decoder.decode(output.content);
    expect(output.contentType).toBe("application/pdf");
    expect(startsWithPdf(output.content)).toBe(true);
    expect(countPdfPages(output.content)).toBeGreaterThan(0);
    expect(body).not.toContain("/F1 18 Tf");
    expect(body).not.toContain("DocuCoreX processed document");
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionError);
    expect(error instanceof ConversionError ? error.code : "").toBe("CONVERSION_ENGINE_UNAVAILABLE");
  }
}

function startsWithPdf(bytes: Uint8Array) {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function countPdfPages(bytes: Uint8Array) {
  return Array.from(decoder.decode(bytes).matchAll(/\/Type\s*\/Page\b/g)).length;
}

function createBlankPdf() {
  return encoder.encode(
    `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
trailer
<< /Size 4 /Root 1 0 R >>
startxref
190
%%EOF`,
  );
}

function createMinimalPptx() {
  return encoder.encode("PK\u0003\u0004minimal-pptx-placeholder");
}
