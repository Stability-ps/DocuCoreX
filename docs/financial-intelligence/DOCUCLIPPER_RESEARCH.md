# DocuClipper: public competitive research

Seen 2026-10-20. **Public sources only**: docuclipper.com marketing pages, help docs, API docs, pricing, the Xero App Store (ZA) listing, and G2/Capterra search snippets. No account was created, nothing was logged into, and no interface was used, so **every accuracy claim below is NOT VERIFIED by testing**. Doc pages were read through page summaries; a few help articles were seen by title only.

Source types: **(a)** DocuClipper official · **(b)** third party · **(c)** not found.

DocuClipper's own pages contradict each other on four points, flagged inline: AI vs rules-only categorisation, Afrikaans vs English-only statements, a 120- vs 200-page trial, and two different webhook registration paths.

## A. Bank statements
| Capability | Observed | Source |
|---|---|---|
| Digital and scanned PDFs | Text-layer extraction; OCR for scans (300 DPI+ recommended) | (a) homepage |
| Fields | Date, description, debit/credit, running balance, payee, cheque number; value dates mentioned in the FNB guide | (a) docs/missing-or-wrong-transactions, FNB blog |
| Balance reconciliation | opening + credits − debits = closing; green **Reconciled** or red **Not Reconciled** badge; editing a balance re-runs it. Claims 94.6% of 118k+ digital periods tied out (self-reported) | (a) docs/how-reconciliation-works |
| Multi-account / multi-period | Statements split by account; Document, Account and Period selectors; rows can be reassigned by hand; the docs admit periods are sometimes merged by mistake | (a) same |
| Multi-currency | **Not documented** | (c) |
| Dates | MM/DD vs DD/MM profile setting; year inferred from the statement period; ISO/US/UK export formats, set per team | (a) docs/customize-date-format |
| Bank coverage | Not template-based; the "supported banks" page lists banks already processed; English-language PDFs required | (a) docs/supported-banks |
| South Africa | **All 9 major SA banks are listed** (FNB, ABSA, Standard Bank, Nedbank, Capitec, Investec, Discovery, TymeBank, African Bank). How-to guides exist for 5 of them. The ABSA guide claims Afrikaans works, **contradicting** the English-only rule. One AWS Marketplace reviewer reported weak SA coverage, later fixed | (a), (b) |
| Categorisation | Deterministic keyword rules (longest match wins, user overrides, bulk vendor CSV); triggered by hand. **Contradiction:** the homepage says "rules and AI" | (a) docs/how-docuclipper-transaction-categorization-works |
| Duplicates | Upload rejects byte-identical files (no pages charged). Overlapping periods flagged by date + amount + description, accounts matched by last 4 digits; "Coverage" tab with missing periods. Rescans and reissued statements are not caught | (a) docs/detecting-duplicate-statements-and-transactions |
| Correction workflow | Inline cell edits, add transaction, include/exclude toggle, bulk credit/debit swap, side-by-side PDF view | (a) |
| Accuracy claim | "99.9%" field-level, no published method | (a) marketing |

## B. Invoices · C. Receipts
| Capability | Observed | Source |
|---|---|---|
| Invoice fields | Vendor, number, date, due date, customer, line items (description/qty/price), subtotal, tax, total | (a) |
| Invoice duplicates | Vendor match + total within $0.01 + date within 3 days + upload within 90 days + number/customer match. Flags only, never blocks; overrides stick | (a) docs/how-docuclipper-detects-duplicate-invoices |
| Approvals | Rule-based approvers (Match All/Any, Require All/Any); approved invoices sync to QBO/Xero; history kept; plan tier not stated | (a) docs/invoice-approval-workflow |
| AP extras | AP ageing, PO matching, invoice-to-bank matching (titles only) | (a) docs index |
| Receipts | Merchant, date, subtotal, tax, tip, total, payment method, line items; totals cross-check; capture by mobile web, Drive or email. **No native app yet** (waitlist) | (a) solutions/mobile-receipt-capture |

## D. Integrations and exports
| Capability | Observed | Source |
|---|---|---|
| QuickBooks Online | Direct API sync, multiple companies; edits re-sync without duplicating | (a) integrations/quickbooks |
| QuickBooks Desktop | IIF and QBO Web Connect files | (a) |
| Xero | Direct sync for invoices; Xero-format CSV for bank statements; App Store (ZA) 4.8/5 from 12 reviews | (a), (b) |
| File formats | Excel, CSV, QBO, QFX, OFX, QIF, IIF on all plans. Preset CSV layouts for Xero, Sage, MYOB, NetSuite, Quicken | (a) pricing |
| Others listed | Sage, NetSuite, Dynamics 365, Google Sheets, Drive, Dropbox, OneDrive, Box, Gmail (depth NOT VERIFIED) | (a) |

## E. Financial intelligence
| Capability | Observed | Source |
|---|---|---|
| Cash flow | Daily balance chart, income/expense bars, category breakdown, CSV | (a) docs/cashflow-analysis |
| Fraud | 0–100 authenticity score (PDF metadata, template fingerprint, balance tie-out); Business tier and up; `fraud.detected` webhook | (a) docs/understanding-bank-statement-fraud-detection |
| Forensic tracing | Multi-account projects, Sankey flow of funds, transfer-match IDs, multi-sheet XLSX; no manual account merge yet; Business tier and up | (a) docs/multi-account-tracing |
| Audit logs | Business tier and up | (a) pricing |

## F. Developer and security
| Capability | Observed | Source |
|---|---|---|
| API | REST, scoped rotatable tokens, async upload, JSON results; all paid plans; no published rate limits or SDKs | (a) integrations/api |
| Webhooks | Uploaded / completed / failed / deleted / limit / fraud events; HMAC-SHA256 signature; 10 s timeout with retries; delivery log. **Two different registration paths** in the docs | (a) |
| Security | SOC 2 Type II claimed (no public report); TLS 1.2+; **encryption at rest not stated**; AWS; GDPR, DPA, SCCs; MFA; SAML on Enterprise | (a) security |
| Retention | Deleted 90 days after cancellation; trial files about 30 days | (a) |

## H. Pricing (2026-10-20)
| Plan | Pages/month | USD/month (annual) | ZAR/month (annual) |
|---|---|---|---|
| Starter | 60 (120, 300 options) | $20.30 | R142.10 |
| Business | 640 (1,000, 1,500 options) | $111.30 | R779.10 |
| Enterprise | 1,800 (3,000, 5,000 options) | $279.30 | R1,955.10 |

About **$0.17–0.34 per page** at the base tier of each plan with annual billing (calculated: $20.30 ÷ 60 ≈ $0.34; $111.30 ÷ 640 ≈ $0.17; $279.30 ÷ 1,800 ≈ $0.16). No rollover and no stated overage price. 14-day trial without a card; the page allowance is stated as 120 in one place and 200 in another.

## Openings for DocuCoreX
1. **Tested SA depth.** DocuClipper lists all 9 SA banks but documents 5, requires English, and publishes no per-bank accuracy. DocuCoreX can publish measured accuracy per bank.
2. **Multi-currency**: undocumented there.
3. **Content-based duplicate detection**: theirs only catches byte-identical files.
4. **Categorisation that learns from corrections**: their docs say keyword-only. DocuCoreX already learns rules from accountant corrections.
5. **A real ledger behind the extraction.** DocuClipper stops at export; DocuCoreX already has journals, GL, trial balance, VAT periods, period close and reconciliation.
6. **Transparent accuracy and data commitments**: explicit encryption at rest, POPIA, no model training on customer data.
7. **Pricing**: rollover or page packs, and fraud/forensics on a cheaper tier.
8. **Native or WhatsApp receipt capture** (they have none).
