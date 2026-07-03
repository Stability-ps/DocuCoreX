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

  test("extracts DOCX text before creating PDF and Excel outputs", async () => {
    const docx = createDocxFile("contract.docx", ["Service agreement", "Payment due in 30 days"]);
    const source = {
      name: "contract.docx",
      mimeType: docx.contentType,
      content: docx.content,
    };

    for (const target of ["pdf", "excel"] as const) {
      const output = await convertDocumentContent(source, target);
      const body = decoder.decode(output.content);
      expect(body).toContain("Service agreement");
      expect(body).toContain("Payment due in 30 days");
      expect(body).not.toContain("DocuCoreX processed document");
      expect(body).not.toContain("Original MIME type");
    }
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
