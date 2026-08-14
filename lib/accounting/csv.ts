/**
 * A small, dependency-free CSV reader.
 *
 * No server imports — the browser and the tests both use this. Handles
 * quoted fields, embedded commas, embedded quotes ("" is a literal quote),
 * and both \n and \r\n line endings. Nothing here writes CSV — that's
 * `toCsv` in lib/accounting/ledger.ts; this module only reads it.
 */

/** Parses raw CSV text into rows of raw string cells, header row included. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // A trailing row with no final newline still needs to be flushed.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  // Only the one artifact a trailing "\n" produces — a final row that is a
  // single empty field — is dropped here. Anything else, including a blank
  // line in the middle of the file, is left in: row numbers are assigned
  // against this array's index, and a blank line skipped BEFORE numbering
  // would shift every row after it by one, which is exactly the kind of gap
  // that would make an error report point at the wrong line.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  return rows;
}

/**
 * Parses CSV text into header-keyed row objects. The header row's cells,
 * trimmed and lower-cased, are the keys — so a template's "Account Code"
 * column and an accountant's "account_code" both resolve the same way.
 *
 * Row numbers are assigned before blank lines are dropped, and a blank line
 * is dropped only after it has consumed its own number — so a blank line 5
 * does not pull row 6 up to become "row 5" in a later error message.
 */
export function parseCsvWithHeader(text: string): { headers: string[]; rows: Array<{ rowNumber: number; cells: Record<string, string> }> } {
  const raw = parseCsv(text);
  if (!raw.length) return { headers: [], rows: [] };

  const headers = raw[0].map((cell) => cell.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows = raw
    .slice(1)
    .map((cells, index) => ({
      // Row 1 is the header, so the first data row is the row a spreadsheet
      // editor would also call row 2.
      rowNumber: index + 2,
      cells,
    }))
    .filter(({ cells }) => cells.some((cell) => cell.trim() !== ""))
    .map(({ rowNumber, cells }) => {
      const record: Record<string, string> = {};
      headers.forEach((header, column) => {
        record[header] = (cells[column] ?? "").trim();
      });
      return { rowNumber, cells: record };
    });

  return { headers, rows };
}
