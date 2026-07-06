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
    openingBalance: toNumber(first([/Opening\s*Balance\s*[:\-]?\s*(R?\s*[0-9, ]+\.\d{2})/i], text)),
    closingBalance: toNumber(first([/Closing\s*Balance\s*[:\-]?\s*(R?\s*[0-9, ]+\.\d{2})/i], text)),
    declaredCreditTotal: toNumber(first([/Credit\s*Transactions?\s*\d+\s+(R?\s*[0-9, ]+\.\d{2})/i, /Total\s*Credits?\s*[:\-]?\s*(R?\s*[0-9, ]+\.\d{2})/i], text)),
    declaredDebitTotal: toNumber(first([/Debit\s*Transactions?\s*\d+\s+(R?\s*[0-9, ]+\.\d{2})/i, /Total\s*Debits?\s*[:\-]?\s*(R?\s*[0-9, ]+\.\d{2})/i], text)),
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
