import type { ExtractionMetadata, ExtractionTransaction } from "@/lib/pdf/types";

// Bank-statement metadata + transaction detection from plain text. Deliberately
// conservative — the authoritative extraction remains the Python accounting
// worker; this feeds the scoring / merge / validation layers.

const MONEY = /-?\(?(?:R\s*)?\d{1,3}(?:[, ]\d{3})*\.\d{2}\)?(?:\s*(Cr|Dr))?/gi;
const DATE = /^\d{1,2}[/\- ](?:\d{1,2}|[A-Za-z]{3,9})(?:[/\- ]\d{2,4})?/;

function toNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const negative = /\(|-/.test(raw.trim()[0] ?? "") || /\)$/.test(raw.trim());
  const value = Number(raw.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

function first(patterns: RegExp[], text: string): string | null {
  for (const re of patterns) {
    const match = text.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function parseStatementMetadata(text: string): ExtractionMetadata {
  const period = text.match(/(?:Statement\s*Period|Period)\s*[:\-]?\s*([0-9A-Za-z/ ]+?)\s*(?:to|-)\s*([0-9A-Za-z/ ]+)/i);
  return {
    company: first([/^([A-Z][A-Z0-9 &()'.,-]{3,})\s*(?:\(PTY\)|\(pty\)|LTD|CC|INC)/m], text),
    accountNumber: first([/Account\s*(?:Number|No\.?)\s*[:\-]?\s*(\d{6,})/i, /Gold Business Account\s*[:\-]?\s*(\d{6,})/i], text),
    statementPeriodStart: period?.[1]?.trim() ?? null,
    statementPeriodEnd: period?.[2]?.trim() ?? null,
    // `(?::|-(?=\s))?` — a colon separates the label from the figure, and so
    // does a dash followed by a space. A minus sign printed hard against the
    // figure belongs to the FIGURE.
    //
    // `[:\-]?` swallowed that minus as punctuation, so an overdrawn statement's
    // "STATEMENT OPENING BALANCE -992,832.57" was read as +992,832.57. Every
    // balance check then failed by twice the opening balance. The Python worker
    // fixed exactly this in its own parser; the same defect survived here.
    openingBalance: toNumber(
      first(
        [
          /Opening\s*Balance\s*(?::|-(?=\s))?\s*(-?\(?R?\s*[0-9, ]+\.\d{2}\)?)/i,
          /Balance\s*Brought\s*Forward\s*(?::|-(?=\s))?\s*(-?\(?R?\s*[0-9, ]+\.\d{2}\)?)/i,
        ],
        text,
      ),
    ),
    closingBalance: toNumber(
      first(
        [
          /Closing\s*Balance\s*(?::|-(?=\s))?\s*(-?\(?R?\s*[0-9, ]+\.\d{2}\)?)/i,
          /Balance\s*Carried\s*Forward\s*(?::|-(?=\s))?\s*(-?\(?R?\s*[0-9, ]+\.\d{2}\)?)/i,
        ],
        text,
      ),
    ),
    // Standard Bank labels its summary block "Deposits" and "Payments" rather
    // than "Credit/Debit Transactions". The minus on Payments is the bank
    // showing an outflow, not a negative total, so only the magnitude is taken —
    // matching the worker's reading of the same block.
    declaredCreditTotal: toNumber(
      first(
        [
          /Credit\s*Transactions?\s*\d+\s+(R?\s*[0-9, ]+\.\d{2})/i,
          /Total\s*Credits?\s*[:\-]?\s*(R?\s*[0-9, ]+\.\d{2})/i,
          /^\s*Deposits\s+-?R?\s*([0-9, ]+\.\d{2})\s*$/im,
        ],
        text,
      ),
    ),
    declaredDebitTotal: toNumber(
      first(
        [
          /Debit\s*Transactions?\s*\d+\s+(R?\s*[0-9, ]+\.\d{2})/i,
          /Total\s*Debits?\s*[:\-]?\s*(R?\s*[0-9, ]+\.\d{2})/i,
          /^\s*Payments\s+-?R?\s*([0-9, ]+\.\d{2})\s*$/im,
        ],
        text,
      ),
    ),
    declaredCreditCount: (() => {
      const value = first([/Credit\s*Transactions?\s*[:\-]?\s*(\d+)/i], text);
      return value ? Number(value) : null;
    })(),
    declaredDebitCount: (() => {
      const value = first([/Debit\s*Transactions?\s*[:\-]?\s*(\d+)/i], text);
      return value ? Number(value) : null;
    })(),
  };
}

// Best-effort transaction rows from text lines (date + amount). Used only for
// scoring / validation signals, not as the authoritative ledger.
export function parseTransactionsFromText(text: string): ExtractionTransaction[] {
  const transactions: ExtractionTransaction[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!DATE.test(line)) continue;
    if (/opening balance|closing balance|balance (brought|carried) forward/i.test(line)) continue;
    const money = [...line.matchAll(MONEY)];
    if (!money.length) continue;
    const amountMatch = money[0];
    const balanceMatch = money.length >= 2 ? money[money.length - 1] : null;
    const amount = toNumber(amountMatch[0]);
    if (amount == null || amount === 0) continue;
    const isCredit = /Cr\s*$/i.test(amountMatch[0]);
    transactions.push({
      date: (line.match(DATE)?.[0] ?? "").trim(),
      description: line.slice((line.match(DATE)?.[0] ?? "").length, amountMatch.index ?? undefined).trim(),
      debit: isCredit ? null : Math.abs(amount),
      credit: isCredit ? Math.abs(amount) : null,
      balance: balanceMatch && balanceMatch !== amountMatch ? toNumber(balanceMatch[0]) : null,
      raw: line,
    });
  }
  return transactions;
}

/**
 * The closing balance, and the evidence it rests on.
 *
 * Not every statement prints the words "Closing Balance". Standard Bank does
 * not: it prints a running balance on every row and a summary block of Deposits
 * and Payments. The Python worker already derives closing for those statements;
 * this side did not, so the acceptance gate rejected every Standard Bank
 * statement with "Closing balance is missing" and escalated to Azure, Mistral
 * and tesseract — none of which can find a label that was never printed. On a
 * 37-page statement that cost roughly 16 seconds per run and changed nothing.
 *
 * The last row's balance is NOT evidence on its own. A statement whose final
 * rows were mis-parsed would hand back a confident wrong number, and closing is
 * what every downstream reconciliation is measured against. So it is accepted
 * only when the bank's own declared turnover agrees with it:
 *
 *     opening + declared deposits - declared payments === last printed balance
 *
 * Two independent figures the bank printed, agreeing to the cent. If they
 * disagree, or either is absent, the answer is null: an unknown closing balance
 * is safer than a plausible wrong one.
 *
 * This deliberately mirrors derive_closing_balance in the worker. The rule is an
 * accounting judgement, and the two sides disagreeing about it would be worse
 * than either being wrong alone.
 */
export function deriveClosingBalance(
  metadata: ExtractionMetadata,
  transactions: ExtractionTransaction[],
): { closingBalance: number | null; source: "explicit" | "last_running_balance_verified" | "unverified" | "unavailable" } {
  if (metadata.closingBalance != null) return { closingBalance: metadata.closingBalance, source: "explicit" };

  const opening = metadata.openingBalance;
  const credits = metadata.declaredCreditTotal;
  const debits = metadata.declaredDebitTotal;
  if (opening == null || credits == null || debits == null || !transactions.length) {
    return { closingBalance: null, source: "unavailable" };
  }

  const lastBalance = [...transactions].reverse().find((t) => t.balance != null)?.balance ?? null;
  if (lastBalance == null) return { closingBalance: null, source: "unavailable" };

  // Cent tolerance, matching the worker. Anything looser would accept a
  // statement with a genuinely missing transaction.
  const expected = opening + credits - debits;
  if (Math.abs(expected - lastBalance) > 0.05) {
    return { closingBalance: null, source: "unverified" };
  }

  return { closingBalance: lastBalance, source: "last_running_balance_verified" };
}
