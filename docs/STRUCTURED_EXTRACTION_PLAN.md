# Structured extraction — architecture review & implementation plan

**Status:** partially implemented — see the status table below.
**Scope:** make Azure Document Intelligence a first-class *structured parser*, and
generalise that capability so every provider can expose structure.
**Explicit constraint:** provider ORDER is unchanged. Azure remains an escalation
after the acceptance gate rejects native extraction.

---

## Implementation status

Last verified against the tree on 2026-08-06 (`main` @ 24837a7).

| Phase | Status | Evidence |
|---|---|---|
| **1. Three confidences** | ✅ **shipped** | `lib/accounting/confidence.ts` (`buildConfidenceTrio`, `reconciliationConfidence`); migration `019_confidence_split.sql`; PRs #25, #26 |
| **2. Azure structured parsing** | ✅ **shipped** | `lib/pdf/azure/*` (geometry, columnRoles, normalizeTables, layout, rowsFromTables, buildStructured); `structured?` on `ExtractionResult`; `tests/pdf/azure-structured.test.ts`. Three deviations from §3/§4 — see below |
| **3. Structured scoring + ranking** | ❌ **not started** | `scoreExtraction.ts` unchanged; no structured signals |
| **4. Worker protocol v2** | ❌ **not started** | `buildWorkerInput` still returns `preExtractedText: string` only (`lib/pdf/workerHandoff.ts:38`); worker has no `transactions_from_rows` |
| **5. Shadow measurement** | ⚠️ **built, never run** | `lib/pdf/shadowComparison.ts`, migrations `018`, `020`; PRs #25, #26 — but see below |
| **6. Persist structure** | ⚠️ **partial** | `018`/`020` persist *shadow* comparisons; no `structured_summary` column exists |

### Two things that are not obvious from the table

**Phase 5 has produced no data.** The sampling gate, the comparison table and the
skip accounting are all built and tested, but `ACCOUNTING_SHADOW_AZURE` is set in
no environment — it is commented out in `.env.example` and absent from
`.env.local` and `.env.production`. Shadow mode has therefore never executed and
`extraction_shadow_comparisons` is empty. **§0's decision gate is still open**:
the plan says measure before committing to phase 4, and nothing has been
measured. Enabling the flag costs one variable.

**Phase 4 now has a producer, and did not before.** Until phase 2 landed, Azure's
structure was discarded at the door: `toExtractionTables` flattened `cells[]`
into `string[][]`, dropping `rowSpan`, `columnSpan`, `polygon`, per-cell
`confidence` and `kind` — everything §4 depends on. **2 → 3 → 4 is a hard
ordering, not a preference**; building 4 first would have meant writing a
consumer against a contract with no implementation to validate it.

### Where the implementation deviates from this plan

The plan is not authoritative where it is wrong. Three corrections, all made in
phase 2 and all covered by tests:

1. **§4b's continuation rule is wrong for FNB and was not implemented as
   written.** The plan treats "empty date + populated description" as a wrapped
   description. FNB prints the date **once per date group**, so every later
   transaction in a group has no date of its own — that rule folds real debits
   into the previous row and loses them, which is precisely the ACAPOLITE
   failure the accounting regression fixture exists to catch. The discriminator
   is **money, not date**: a row qualifies only with no date, no value in any
   money column, and some description text.
2. **`ColumnRole` gains `"amount"`.** FNB prints one signed Amount column with a
   Cr/Dr suffix rather than separate debit and credit columns; without it the
   most important column on a real statement resolves to `"unknown"`.
3. **`StructuredRow.absorbedRows` replaces `continuationOf`.** Joining happens
   in Node where the polygons are, so continuation rows are merged rather than
   emitted separately and the worker never redoes geometry in Python. The useful
   record is therefore the reverse direction — which source rows were folded in.

Also **not** implemented: `keyValues.ts`. It requires the
`features=keyValuePairs` add-on, which bills per page, and §10 question 4 is
unanswered — requesting it would start the spend before the decision.

---

## 0. What this plan does and does not fix

Read this first — it determines whether the investment is worth it.

| Symptom | Fixed by this plan? |
|---|---|
| Transactions reconstructed by regex from flattened text | ✅ yes — the core of it |
| Wrapped descriptions split across rows | ✅ yes — geometry-based joining |
| Merchant names mangled by line-splitting | ✅ yes — descriptions preserved as Azure groups them |
| Page headers/footers polluting the transaction stream | ✅ yes — `paragraphs[].role` |
| One "Confidence" number that hides which subsystem is weak | ✅ yes — item 8 |
| **The 79% figure itself** | ❌ **no** |
| **18 transactions marked Review Required** | ❌ **no** |

The 79% is the mean of `classify_transaction()` rule confidences
(`main.py:3969`), and the 18 review items are accounting-policy flags. Neither is
an extraction metric. Item 8 makes that **visible** by splitting the number into
three; it does not raise it. Raising it is rule-table and AI-classification work,
tracked separately.

### The cost/benefit tension you should decide on

Azure runs **only when the acceptance gate rejects native extraction**. Your
current statements reconcile at R0.00, so they pass, so Azure never runs. Every
capability below therefore applies to a **minority of documents** — the ones
pdfplumber cannot parse today.

That is the correct economic design and I am not proposing to change it. But it
caps the return on this work. Three options:

| Option | Effect | Cost |
|---|---|---|
| **A. Keep as-is** (recommended default) | Structure benefits only failing documents | No change |
| **B. Per-type policy** — `bank_statement` tries Azure first, generic documents keep the ladder | Structure on every statement | ~$10/1,000 pages on all statements |
| **C. Shadow mode** — run Azure in `after()` on accepted statements, record but never adopt | Measures the benefit before paying for it | Full cost, zero risk |

**C then B** is the honest sequence: measure first. Option B is a provider-order
change *scoped by document type* — if you consider that out of bounds, say so and
we stay on A.

---

## 1. Current state

From the audit. Azure returns rich structure; we consume a string and a number.

```
Azure analyzeResult
├── content ──────────────────▶ combinedText ──▶ regex ──▶ transactions
├── pages[].spans ────────────▶ page slicing
├── pages[].words[].confidence ▶ one averaged number
├── pages[].lines ────────────▶ fallback only
├── tables[] ─────────────────▶ scoring only, never transactions
├── paragraphs[] ─────────────▶ .length only
└── everything else ──────────▶ discarded
```

Two hard walls:

1. `transactions: parseTransactionsFromText(combinedText)` — rows are re-derived
   by regex even when Azure supplied them as cells.
2. `buildWorkerInput` sends `preExtractedText: string`. The Node→Python boundary
   is a flat string, so structure cannot reach the FNB parser regardless of how
   well we parse it.

Wall 2 is the binding constraint. Fixing wall 1 alone improves Node-side scoring
and nothing the user sees.

---

## 2. Target architecture

```
                 ┌──────────────────────────────────────────────┐
   PDF ─────────▶│ Provider (pdfjs | pdfplumber | azure | ...)  │
                 │   emits ExtractionProviderResult             │
                 │   { text, tables, rows, cells, layout,       │
                 │     paragraphs, metadata, confidence }       │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │ Structured scoring  (extends scoreExtraction) │
                 │  ocrQuality · tableQuality · rowContinuity    │
                 │  numericAccuracy · balanceAccuracy           │
                 │  dateConsistency · merchantContinuity        │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │ acceptExtraction()  — UNCHANGED single gate  │
                 └───────────────────┬──────────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────────┐
                 │ Worker handoff: structured FIRST, text falls  │
                 │ back. Worker is provider-agnostic.            │
                 └──────────────────────────────────────────────┘
```

Providers stay interchangeable. Providers that cannot produce structure (PDF.js,
Tesseract, Mistral) simply return empty `tables`/`rows` and are scored on the
text-only signals — no special-casing anywhere.

---

## 3. The provider contract

Extends `ExtractionResult` rather than replacing it, so every existing consumer
keeps working.

```ts
// lib/pdf/types.ts — all fields OPTIONAL, so today's providers stay valid
export type ExtractionProviderResult = ExtractionResult & {
  structured?: {
    tables: StructuredTable[];
    rows: StructuredRow[];        // provider's own row segmentation
    layout: LayoutBlock[];        // reading order + roles
    keyValues: Record<string, StructuredValue>;
    pageMeta: PageMeta[];
    quality: StructuredQuality;   // see §7
  };
};

type StructuredTable = {
  pageNumber: number;
  rowCount: number; columnCount: number;
  headers: Array<{ index: number; label: string; role: ColumnRole }>;
  cells: StructuredCell[];
  boundingRegion?: Region;
};

type ColumnRole = "date" | "description" | "debit" | "credit" | "balance" | "reference" | "unknown";

type StructuredCell = {
  rowIndex: number; columnIndex: number;
  rowSpan: number; columnSpan: number;
  content: string;
  kind?: "columnHeader" | "rowHeader" | "content";
  confidence?: number;            // min word confidence within the cell
  region?: Region;
};

type StructuredRow = {
  pageNumber: number;
  cells: Record<ColumnRole, string | null>;
  raw: string;
  confidence: number;             // min cell confidence in the row
  continuationOf?: number;        // wrapped-description linkage
  region?: Region;
};

type LayoutBlock = {
  order: number;                  // reading order
  role: "title" | "sectionHeading" | "pageHeader" | "pageFooter" | "pageNumber" | "paragraph";
  content: string;
  pageNumber: number;
  region?: Region;
};

type Region = { pageNumber: number; polygon: number[] };  // 8 numbers, Azure order
type PageMeta = { pageNumber: number; width: number; height: number; unit: string; angle: number };
type StructuredValue = { value: string; confidence: number | null; region?: Region };
```

**Selection marks and styles/languages** are captured into `layout` and
`pageMeta` respectively but have no consumer for bank statements. Included for
completeness of the contract; not worth requesting the add-on features for.

---

## 4. Azure structured parsing

New: `lib/pdf/azure/` — the provider grows a folder rather than a 600-line file.

| Module | Responsibility |
|---|---|
| `client.ts` | submit / poll / raw response (extracted from today's provider) |
| `normalizeTables.ts` | cells → `StructuredTable`, incl. `rowSpan`/`columnSpan` |
| `columnRoles.ts` | `cells[].kind === "columnHeader"` → `ColumnRole`, by label match |
| `rowsFromTables.ts` | `StructuredTable` → `StructuredRow[]` |
| `geometry.ts` | polygon helpers: y-overlap, row bands, containment |
| `layout.ts` | `paragraphs[].role` + reading order → `LayoutBlock[]` |
| `keyValues.ts` | `keyValuePairs[]` → account number, period, balances |

### 4a. Rows from tables (replaces regex)

1. Identify the transaction table: the table whose header roles include a
   `date` **and** at least one of `debit`/`credit`/`balance`.
2. Map columns **semantically** via `columnHeader` cells, not by index — column
   order varies between banks and even between pages.
3. Each `rowIndex` becomes one `StructuredRow`.
4. `parseTransactionsFromText` is retained as the fallback when no table
   qualifies, so nothing regresses.

### 4b. Wrapped descriptions, by geometry

The current `split_compound_candidate_line` heuristics guess. Geometry knows.

1. Rows whose `date` cell is empty but whose `description` is populated are
   **continuation candidates**.
2. Confirm by vertical proximity: the candidate's polygon top is within a
   tolerance of the previous row's polygon bottom, and horizontally aligned to
   the description column.
3. Join with a single space, set `continuationOf`, and **preserve the merchant
   string exactly as Azure grouped it** — no re-tokenising.

Tolerance derives from median row height on the page, so it scales with DPI and
page size. `pageMeta.angle` corrects skew before comparison.

### 4c. Page furniture

Drop `LayoutBlock`s with role `pageHeader` / `pageFooter` / `pageNumber` before
building text. This removes a whole class of noise the FNB parser currently
fights with `strip_fnb_page_artifacts` / `is_fnb_page_artifact`.

### 4d. Confidence, per cell not per document

`min(word.confidence)` within a cell → cell confidence → row confidence. Lets us
flag *a specific amount* as low-confidence instead of averaging the whole
document to one number.

---

## 5. Worker protocol

The change that makes everything else reach the workbook.

### Request (additive; every field optional)

```jsonc
{
  "run_id": "...", "storage_path": "...",           // unchanged
  "pre_extracted_text": "...",                       // unchanged, still sent
  "extraction_format_version": 2,                    // NEW — negotiation
  "pre_extracted_rows":       [ /* StructuredRow */ ],
  "pre_extracted_tables":     [ /* StructuredTable */ ],
  "pre_extracted_cells":      [ /* StructuredCell */ ],
  "pre_extracted_layout":     [ /* LayoutBlock */ ],
  "pre_extracted_key_values": { },
  "pre_extracted_metadata":   { }
}
```

### Worker consumption order

```python
if payload.pre_extracted_rows and rows_are_usable(payload.pre_extracted_rows):
    transactions = transactions_from_rows(...)        # NEW structured path
    source = "structured"
else:
    transactions = parse_from_text(full_text)          # UNCHANGED text path
    source = "text"
```

`rows_are_usable()` requires: a date and at least one amount on ≥80% of rows, and
a row count within tolerance of `transaction_candidate_lines(full_text)`. If
structured rows look worse than the text would yield, the text path wins — the
same "choose by yield, not by format" rule already applied to text selection.

**The existing text path is untouched.** A v1 caller, or a provider with no
structure, behaves exactly as today.

### Provider-agnostic

The worker consumes `StructuredRow` and never learns which provider produced it.
`extraction_source` remains a label for diagnostics only.

---

## 6. Provider ranking

Extends `scoreExtraction`; does **not** replace it. Four of the seven signals
already exist there.

| Signal | Status | Definition |
|---|---|---|
| OCR quality | **exists** (`pageCoverage`, char counts) | text recovered per page |
| Table quality | new | qualifying tables ÷ pages; header roles resolved |
| Row continuity | new | rows with a date and ≥1 amount ÷ total rows |
| Numeric accuracy | **partly exists** (`amounts`) | parseable amount cells ÷ amount cells |
| Balance accuracy | **exists** (`runningBalanceConsistent`) | balance chain holds |
| Date consistency | **partly exists** (`dates`) | monotonic, within statement period |
| Merchant continuity | new | descriptions that are non-empty and not truncated mid-token |

`structuredScore = weighted sum`, used **alongside** the existing text score.
Providers with no structure score 0 on the structured signals and are ranked on
text alone — so pdfplumber does not lose to Azure merely for lacking tables.

**`acceptExtraction()` is not modified.** It keeps consuming `selection` and
`validation`; ranking only changes *which candidate wins the merge*, which is
`mergeExtractionResults`' job. The single-gate property is preserved.

---

## 7. Three confidences

The most valuable item for you, and the cheapest.

| Name | Source | Meaning |
|---|---|---|
| **Extraction Confidence** | `selection.confidence` (Node) | how accurately the document was read |
| **Accounting Classification Confidence** | `avg_confidence` (worker, `main.py:3969`) — **today's "79%"** | how confidently transactions were categorised |
| **Reconciliation Confidence** | derived from `validation` — difference, missing rows, continuity | how reliable the reconstructed statement is |

Never combined. Every surface shows all three or names which one it shows.

This alone would have prevented the last two investigations: the 79% looked like
an OCR problem, and it never was.

---

## 8. Implementation plan

Phased so each lands independently and is separately revertible.

| Phase | Work | Risk | Value without later phases | Status |
|---|---|---|---|---|
| **1. Three confidences** | Split the metric; API + UI; no extraction change | very low | **High** — ends the misdiagnosis | ✅ shipped |
| **2. Azure structured parsing** | `lib/pdf/azure/*`, contract in types, rows from tables, geometry joining | low | Node-side scoring only | ✅ shipped |
| **3. Structured scoring + ranking** | Extend `scoreExtraction`, `mergeExtractionResults` | medium | Better provider choice | ❌ not started |
| **4. Worker protocol v2** | `main.py` structured path, `rows_are_usable`, regression suite | **high** | **This is where users see it** | ❌ unblocked, not started |
| **5. Shadow measurement** | Option C from §0 — run Azure on accepted statements, record only | low | Data to justify §0 option B | ⚠️ built, flag never set |
| **6. Persist structure** | Migration 018, diagnostics UI | low | Auditability | ⚠️ shadow only |

**Phase 1 first.** It is a day of work, it is the actual fix for the reported
confusion, and it is independent of everything else. **Phase 4 is the one that
matters** for output quality, and it is the riskiest — the FNB parser is ~4,000
lines built around text lines.

### Revised sequencing (2026-08-06)

Phases 1 and 2 are done. Phase 4 is unblocked but should still not be next:

1. **Set `ACCOUNTING_SHADOW_AZURE=true`** and let phase 5 do the job it was built
   for. One variable, no code. Until this runs, §0's option A/B/C question is
   being answered by assertion rather than evidence, and phases 3–4 are justified
   by a benefit nobody has measured. Phase 2 makes this measurement strictly
   better: the shadow record can now compare *structure* recovered, not only text.
2. **Phase 3**, which turns phase 2's descriptive `StructuredQuality` counts into
   scoring signals. Medium risk, because it changes which candidate wins a merge.
3. **Phase 4** last, and only with shadow data in hand — it is the phase that
   touches a ~4,000-line text-oriented FNB parser, and the only one users see.

### API changes

- `GET /api/pdf/analyze/:id` — add `structured` summary + the three confidences (additive)
- `GET /api/accounting/fnb/runs/:id` — three confidences (additive)
- `POST {worker}/process-statement` — `extraction_format_version: 2` + six structured fields (additive, negotiated)

### Worker changes

- `ProcessRequest`: six optional fields + version
- New: `transactions_from_rows()`, `rows_are_usable()`
- Existing text path untouched
- `run_regression.sh` gains structured fixtures; both paths must stay green

### Database changes

Migration `018_structured_extraction.sql`, all nullable:

```sql
alter table accounting_statement_runs
  add column if not exists extraction_confidence_pct    numeric,
  add column if not exists classification_confidence_pct numeric,
  add column if not exists reconciliation_confidence_pct numeric,
  add column if not exists extraction_source            text,     -- structured | text
  add column if not exists structured_summary           jsonb;    -- SUMMARY only
```

⚠️ **Do not persist raw Azure output.** Full layout with polygons for a
multi-page statement can run to megabytes; storing it per run will bloat the
table and slow every query that selects `*` (the worker does exactly that at
`main.py:3587`). `structured_summary` holds counts, column-role mapping, per-page
quality — not geometry. Raw output stays in logs if needed for debugging.

`extraction_confidence` (existing) is kept and mirrored to
`extraction_confidence_pct` so nothing breaks during rollout.

### UI changes

- Statement workspace: three labelled metrics instead of one "Confidence"
- Review queue: show *which* confidence triggered each item
- Parser debug: structured panel — tables found, column roles, rows built, joins made, per-provider structured scores
- `accounting-intelligence.tsx:2210, 2393` currently render `run.confidence` bare; these become explicitly "Classification"

### Backwards compatibility

- Every type change is an optional field or an added union member
- Worker v1 payloads still work; the worker prefers structure only when present and usable
- Old runs render with `null` for the new confidences — UI must show "—", not 0%
- Migration is additive with `if not exists`; the write path stays best-effort as with 013/017

### Migration impact

No backfill. Existing runs keep their single `confidence` value, which continues
to mean classification confidence. New runs populate all three. The UI must not
imply historical runs had a low extraction confidence when the field is simply
absent.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Phase 4 destabilises the FNB parser** | **High** | Structured path is additive; `rows_are_usable` falls back; both paths in the regression suite |
| Structured rows worse than text on some layouts | Medium | Yield comparison before adoption, same rule as text selection |
| Azure column headers absent or unlabelled | Medium | `columnRoles` falls back to positional inference, then to the text path |
| Geometry joining over-merges distinct rows | Medium | Tolerance from median row height; cap joins per row; log every join |
| `structured_summary` bloat | Medium | Summary only, never raw; size assertion in tests |
| 300s Vercel ceiling | **High, pre-existing** | Unresolved. Structured parsing adds CPU, not I/O, but the budget problem stands |
| Effort spent on documents Azure rarely sees | **High** | §0 — measure with shadow mode before committing to phase 4 |

## 10. Open questions for you

1. ~~**§0 option A, B or C?**~~ **Answered: C.** The shadow-mode machinery was
   built (PRs #25, #26). **But the question it was meant to settle is still
   open**, because the flag enabling it was never set, so no comparison has ever
   been recorded. C is implemented, not performed.
2. Is a per-document-type provider order (statements → Azure first) within
   bounds, or does "do not change provider order" mean globally fixed? — **still
   open**, and cannot be answered without the data from (1).
3. ~~Should phase 1 ship on its own immediately?~~ **Answered: yes, and it did.**
4. Do you want key-value pairs? It needs `features=keyValuePairs`, adds cost,
   and account number / period already parse reliably from text. — **still open.**

### New question

5. **Is Azure escalation firing at all in production?** §0 noted that Azure runs
   only when the acceptance gate rejects native extraction, and that current
   statements reconcile at R0.00 and therefore pass. If that is still true, the
   entire structured-extraction investment applies to zero documents today, and
   the shadow numbers from (1) would show it immediately.
