# DocuCoreX Financial Intelligence: gap analysis, architecture and roadmap

Status 2026-10-20. **DocuCoreX production status: NOT READY.** This is a plan. Nothing here is deployed, and nothing marked PROPOSED exists in code.

Labels: **VERIFIED** (checked against code or a live system) · **IMPLEMENTED** (in code on `main`) · **TESTED** (covered by a suite) · **PROPOSED** · **BLOCKED** · **NOT VERIFIED**.

Evidence: the read-only repository audit of `main` at `25a42ba` (file paths below) and [DOCUCLIPPER_RESEARCH.md](DOCUCLIPPER_RESEARCH.md). DocuClipper capabilities are what its public pages say, not tested behaviour.

## 1. Where DocuCoreX stands (VERIFIED from code)

DocuCoreX's **accounting depth already exceeds DocuClipper**. Migrations 035–048 provide a double-entry ledger, journals, period locking, GL, trial balance, bank reconciliation, VAT codes and periods, period close with append-only audit events, fixed assets, and receivables/payables. DocuClipper stops at extraction and export.

**Intake breadth is far narrower:**
- Bank parsers: one dedicated parser (FNB). Standard Bank, ABSA, Nedbank, Capitec and Investec are detected but parsed generically, with validation off.
- Input: PDF only.
- Currency and dates: ZAR and day-first dates only.
- Exports: no QBO/OFX/IIF.
- Integrations: none live; the integrations page is a static catalogue.

## 2. Feature matrix

Priority: **P0** essential · **P1** high value · **P2** competitive · **P3** later. Complexity: S/M/L/XL.

| Feature | DocuClipper (public) | DocuCoreX today | Proposed | Cx | Value | Pri |
|---|---|---|---|---|---|---|
| Statement balance reconciliation | Reconciled badge | IMPLEMENTED: opening/closing/running checks (`workers/accounting_worker/main.py` `validate_statement`), combine continuity | Surface a reconciled badge per statement in the UI; never "reconciled" unless arithmetic passes | S | High | P0 |
| Decimal-safe amounts | n/a | PARTIAL: DB `numeric`, worker parses `Decimal` then converts to `float` (`decimal_to_float`) | Keep `Decimal` end to end in the worker; TS money via integer cents | M | High | P0 |
| Formula-injection-safe exports | n/a | **Fixed in draft PR #200** (worker XLSX, CSV) | Merge after review | S | High | P0 |
| Edit extracted values (amount, date, description, add/remove rows) with history | Inline edit, add, include/exclude | ABSENT: only category/VAT/notes editable; audit exists (`accounting_action_audit`) | Correction model: raw value kept, corrected value + who/when; re-run validation | M | High | P0 |
| Bank coverage: SA big 5 | All listed, 5 guides | FNB dedicated; others generic with validation off (`engine/profiles.py`) | Per-bank adapters with validation on, each gated by a synthetic + consented corpus | L | Very high | P0 |
| SA long tail (Investec, Discovery, TymeBank, African Bank) | Listed | Investec detected only | Adapters after the big 5 | L | High | P1 |
| Scanned statements | OCR | IMPLEMENTED OCR stack (tesseract/ocrmypdf, Azure layout, Mistral, OpenAI vision) for documents; accounting intake is PDF text-first | Route scanned statements through the existing OCR worker before parsing | M | High | P1 |
| Image / CSV / XLSX statement intake | Images via OCR | ABSENT (`assertFnbPdf`) | Accept images (OCR) and bank CSV exports | M | Med | P2 |
| Re-upload / duplicate statement detection | Byte-identical + overlap | PARTIAL: within one statement only | Content fingerprint (account + period + balances), cross-run overlap check | M | High | P1 |
| Learning categorisation | Keyword rules only | IMPLEMENTED: rules learned from corrections (`accounting_classification_rules`, 004) | Expose rule management UI; measure precision | S | High | P1 |
| Transfers / recurring | Titles only | IMPLEMENTED (032, 033) | Keep | — | — | — |
| Multi-currency | Not documented | ABSENT (`MONEY_TOKEN` is `R`-only) | Currency per account and line; no FX conversion in v1 | L | Med (SA-first) | P2 |
| Date locale (MM/DD) | Profile setting | ABSENT (day-first only) | Per-workspace locale, statement-level detection | S | Med | P2 |
| Per-value provenance (page, bbox, raw vs normalised, method, confidence) | n/a | PARTIAL: page, raw_text, confidences (019/021/023); Azure polygons discarded | Persist bbox and raw/normalised per field | M | High | P1 |
| Invoice/receipt extraction to AP | Fields + approvals + sync | PARTIAL: generic OpenAI schema (`lib/providers/openai/extraction.ts`), no VAT number/due date, no AP posting | SA tax-invoice fields (VAT no., due date, per-line VAT), post to payables (043) after review | L | High | P1 |
| Invoice duplicate detection | Rule-based | ABSENT | Same rule shape (supplier + total ± tolerance + date window + number) | S | High | P1 |
| Bank rows → ledger | n/a | PARTIAL: `source_transaction_id` exists, nothing posts (plan stage 5) | Reviewed rows post journals via the existing posting gate | M | Very high | P0 |
| Invoice ↔ payment matching | Titles only | PARTIAL: reconciliation suggestions (039) | Use 043 open items + bank rows with tolerances; user confirms | M | High | P1 |
| QBO / OFX / QFX / IIF export | All plans | ABSENT | OFX first (universal), then QBO Web Connect, IIF | M | High | P1 |
| Xero / QuickBooks / Sage sync | QBO, Xero direct | ABSENT (UI catalogue only) | Xero first (strong in SA), then QBO; Sage Business Cloud research | XL | High | P2 |
| Public API + webhooks | REST, HMAC webhooks | PARTIAL: keys stored hashed, never verified (`app/api/api-keys`) | Key verification, scoped tokens, OpenAPI, signed webhooks | L | Med | P2 |
| Statement fraud signals | 0–100 score (Business tier) | ABSENT | PDF metadata + balance tie-out + producer fingerprint as **signals**, never a verdict | M | Med | P2 |
| Forensic multi-account tracing | Business tier | PARTIAL: flow-of-funds analytics (`lib/accounting/flow-of-funds.ts`) | Projects across accounts with merge | L | Med | P3 |
| VAT (SA) | Not SA-specific | IMPLEMENTED VAT codes/periods (040); bank-row VAT estimate labelled as estimate | VAT-invoice completeness checks; input/output VAT reports from reviewed documents only | M | High (SA) | P1 |
| AI financial assistant | MCP server advertised | ABSENT | Read-only, workspace-scoped, cites rows; no transfers, no SARS submission | L | Med | P3 |
| Native/WhatsApp receipt capture | None | ABSENT | Research | L | Med (SA) | P3 |

**Do not build:** automatic SARS submission, automatic deductibility decisions, unreviewed "reconciled" claims, or a duplicate auth/billing/storage stack.

## 3. Proposed architecture (PROPOSED)

The stages below extend existing modules; no new service is introduced.

```
Upload (existing /api/uploads + malware scan)  ──►  Classify (lib/ocr/classifyDocument)
   ──►  Text: pdf.js / pdfplumber service / OCR worker (existing)
   ──►  Structured extraction: bank adapter (workers/accounting_worker/engine/*) | invoice/receipt schema
   ──►  Normalise (Decimal, ISO dates, currency)  ──►  Validate (balance chain, totals, duplicates)
   ──►  Review UI (corrections recorded, validation re-run)
   ──►  Post / reconcile (existing ledger 036–043)  ──►  Export (CSV/XLSX/OFX/QBO) · Analyse
```

- **One provenance record per extracted value:** `document_id`, `page`, `bbox` (nullable), `raw_text`, `normalised_value`, `method` (`text|ocr|azure|mistral|openai|rule`), `confidence`, `validation_status`, and correction history (`corrected_value`, `corrected_by`, `corrected_at`). For bank rows this extends `accounting_transactions`; a new table is not needed for v1.
- **AI is used only where it measurably helps.** That means ambiguous categorisation and recovery of failed parses, already behind `external_ai_processing` (051) and `ACCOUNTING_AI_RECOVERY`. AI never produces an amount that the validators can't tie back to the document.
- **Feature flags:** none exist today, so add a per-workspace `features` JSON (or env + workspace allow-list) and keep every new surface behind it until it is verified.

### Bank statement normalised schema (PROPOSED additions to `accounting_transactions`)
`posting_date`, `reference`, `currency` (default `ZAR`), `amount_raw`, `balance_raw`, `source_bbox`, `extraction_method`, `corrected_*`. Existing columns already cover `transaction_date`, `description`, debit/credit, `balance`, `category`, confidences, `source_page`, `raw_text`.

**Validation rules** (Decimal only; the first three exist today, the rest are proposed):
- opening + Σcredits − Σdebits = closing;
- each running balance continues the previous one;
- declared count and totals match;
- no duplicate within or across runs;
- dates lie inside the period;
- debit/credit sign agrees with the balance movement;
- a single currency per account in v1.

A statement is **Reconciled** only when every rule passes; anything else is **Needs review**, with the failing rule named.

### SA bank roadmap (PROPOSED)
| Bank | Today | Next step | Blocker |
|---|---|---|---|
| FNB | Dedicated parser, validation on | Keep; add the scanned path | — |
| Standard Bank | Generic parser; tested on one real 615-row statement (`tests/pdf/standard-bank-balances.test.ts`) | Dedicated profile, validation on | Consented sample corpus |
| ABSA, Nedbank, Capitec | Detected, generic | Adapter each | Consented or synthetic layouts |
| Investec, Discovery, TymeBank, African Bank | Detected (Investec) or nothing | After the big 5 | Samples |

**Evidence rule:** no accuracy claim for a bank without an evaluation set. Gaps are recorded, not filled with assumptions.

### Invoice/receipt (PROPOSED)
- **Fields to add:** supplier VAT number, customer VAT number, due date, per-line VAT, document type (tax invoice, credit note, PO, supplier statement).
- **Validation:** Σlines − discounts + VAT = total. A rounding tolerance of R0.01 per line is flagged and never silently corrected.
- **SA tax-invoice completeness:** check for the fields a valid tax invoice must carry, as a warning list for human review.
- **Posting:** to payables (043) only after review.

### Reconciliation (PROPOSED)
- **Matching keys:** amount (exact, or tolerance), date window, reference, supplier, currency, account.
- **Confidence:** each match is scored and listed with the reasons it matched.
- **Confirmation:** a match is confirmed only by a user; probable matches stay labelled probable. This reuses 039 reconciliation items and 043 allocations.

## 4. Security and privacy (VERIFIED state + PROPOSED work)

**VERIFIED:**
- workspace RLS on every accounting table;
- RPC tenant guards (046);
- storage path enforcement (053/056);
- team roles (054);
- worker shared-secret auth;
- database-backed rate limits (050);
- append-only audit events (041);
- a per-workspace external-AI opt-out (051).

**Gaps:**
- formula injection (fixed in PR #200, unmerged);
- the malware scanner is not provisioned and the accounting upload path skips it;
- no retention or purge policy;
- usage and cost metering is not persisted;
- prompt-injection handling for AI recovery: statement text is sent to the model, and its output must stay schema-bound and pass the validators (to verify).

**Compliance:** POPIA and GDPR are **NOT VERIFIED**. No compliance claim may be made until a legal review is done.

## 5. Cost model (ESTIMATES; verify current vendor prices before relying on them)

| Item | Basis | Estimate |
|---|---|---|
| Digital-PDF statement page (pdfplumber/PyMuPDF on the existing worker) | Compute only | ≈ $0.000–0.002/page |
| OCR page, tesseract on the existing conversion worker | Compute only | ≈ $0.001–0.005/page |
| Azure Document Intelligence layout (when used) | Vendor list price, order of $10 per 1,000 pages | ≈ $0.01/page |
| Mistral OCR (when used) | Vendor list price, order of $1–2 per 1,000 pages | ≈ $0.001–0.002/page |
| AI categorisation (gpt-4o-mini class, only ambiguous rows) | Small prompts, batch | ≈ $0.0005–0.003/page |
| Storage (Supabase Pro, included quota) | Marginal | negligible per page |
| Fixed: Render paid conversion worker (Starter), Supabase Pro, Vercel Pro | Existing plans | already paid; no new spend proposed |

**Margin reference:** DocuClipper charges about $0.16–0.34 per page. A digital-first pipeline costs DocuCoreX well under $0.02 per page in variable cost (estimate), so gross margin is dominated by fixed infrastructure and support, not per-page processing.

**Measurement needed:** persist cost per job (the `usage_counters` table exists but is never incremented) before pricing decisions.

## 6. Roadmap (milestones; none authorises deployment)
| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | Finish production remediation (worker cutover, 057/058, #195, CRON_SECRET, pdfplumber auth) | Release checklist below |
| 1 | P0 safety: PR #200 formula injection; Decimal end-to-end in the worker | Tests green; no float in money paths |
| 2 | Corrections with history + reconciled badge | Users can fix amount/date/description; validation re-runs |
| 3 | Bank rows → ledger (plan stage 5) | Reviewed rows post balanced journals; tests in `tests/sql` |
| 4 | Standard Bank, ABSA, Nedbank, Capitec adapters | Per-bank evaluation report (precision/recall, balance tie-out) on a consented/synthetic corpus |
| 5 | OFX then QBO export; duplicate-statement fingerprint | Format tests; import verified in target software |
| 6 | Invoice/receipt SA fields + AP posting + invoice duplicates | Totals validation tests; review gate |
| 7 | Xero integration | OAuth app approval (owner), sandbox tests |
| 8 | Public API + signed webhooks | OpenAPI, key verification, rate limits |
| 9 | Fraud signals, AI assistant (read-only, cited) | Red-team prompt-injection tests |

## 7. Test strategy (PROPOSED)
- Synthetic statement generator per bank layout: clean, scanned, rotated, multi-page, refunds and reversals, missing balances, duplicates.
- Metrics: transaction precision and recall, amount and date accuracy, balance tie-out rate, false-duplicate rate, seconds per page, cost per page.
- Existing suites to extend: `test:export`, `test:pdf`, `test:security`, `scripts/verify-ledger.sh`, and the accounting worker regression.

## 8. Production release checklist (for any financial feature)
1. Phase-0 remediation complete and DocuCoreX formally moved out of NOT READY by the owner.
2. Feature behind a flag, off by default.
3. Migrations dry-run on production in a rolled-back transaction; rollback script tested.
4. Cross-tenant isolation tests for every new table and RPC.
5. Evaluation report for any accuracy claim.
6. Export files opened in the target software.
7. No financial data in logs; retention rule defined.
8. Owner approval for merge, migration and deploy, separately.

## 9. Decisions for the owner
1. Priority order of phases 1–5. Recommended: as listed.
2. Source of bank samples: consented customer statements (needs POPIA consent wording) or synthetic layouts only.
3. Xero vs QuickBooks first. Recommended: Xero for SA.
4. Whether to pursue fraud signals, given the false-positive risk.
5. Pricing direction relative to DocuClipper (page packs and rollover).
