# External data flows — what leaves DocuCoreX, and who receives it

Audited 2026-10-19 from the code (every outbound HTTP call to a third party)
and from each provider's published terms on that date. This is an engineering
record, **not legal advice**; contractual terms (DPAs, account settings) must be
confirmed by whoever holds those accounts.

## First-party processing (never leaves DocuCoreX's own services)

| Engine | Where | What it sees |
|---|---|---|
| PDF.js text extraction | Vercel / conversion worker (in-process) | the PDF |
| pdfplumber service | Render (`services/pdf-plumber`, token-protected since #168) | the PDF |
| OCRmyPDF / Tesseract | Render conversion worker | the PDF / images |
| LibreOffice / Ghostscript conversions | Render conversion worker | the file being converted |
| Accounting parser (deterministic) | Render accounting worker | the statement PDF and text |

Supabase (database and storage, project region **eu-west-2, London**) holds the
documents and results; it is DocuCoreX's own infrastructure provider, not an AI
processor.

## Third-party AI providers

| Provider | Endpoint | What is sent | Whole document? | Personal / financial data | From | Triggered when |
|---|---|---|---|---|---|---|
| **Azure AI Document Intelligence** (`prebuilt-layout`) | `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | the **whole PDF**, base64 | **Yes** | Yes — statements carry names, ID and account numbers, transactions | Vercel and conversion worker (`lib/pdf/extractWithAzureDocumentIntelligence.ts`) | the acceptance gate rejected native extraction, or Enhanced OCR was asked for; and (opt-in) shadow mode `ACCOUNTING_SHADOW_AZURE=true` |
| **Mistral OCR** (`mistral-ocr-4-0`) | `https://api.mistral.ai/v1/ocr` | the **whole PDF**, base64 data URL | **Yes** | Yes | Vercel and conversion worker (`lib/pdf/extractWithMistralOcr.ts`) | Azure did not satisfy the gate, or Enhanced OCR |
| **OpenAI** — vision OCR | `https://api.openai.com/v1/chat/completions` | **page images** of scanned PDFs (≤ 10 pages at 150 dpi) or the whole uploaded image | Effectively yes (as images) | Yes | Vercel and conversion worker (`lib/providers/openai/vision-ocr.ts`) | OCR of a scanned document or image when OpenAI is the selected OCR provider |
| **OpenAI** — structured extraction | same | the document's **full extracted text** (no truncation) | Yes (as text) | Yes | Vercel and conversion worker (`lib/providers/openai/extraction.ts`) | every generic extraction job |
| **OpenAI** — accounting commentary | same | aggregated figures for a statement run (totals, counts, risk scores, company name, period) | No | Company name and financial totals | Vercel (`lib/accounting/ai-service.ts`) | a user asks for commentary |
| **OpenAI** — transaction classification | same | each unresolved row's **description and amount** | No | Counterparty names in descriptions | Render accounting worker (`main.py`) | rows the deterministic rules could not classify |
| **OpenAI** — counterparty reasoning | same | grouped counterparty evidence (recurrence, direction, amount profile) | No | Counterparty names | Render accounting worker | recurring unresolved counterparties |
| **OpenAI** — ledger recovery | same | **raw statement lines** | Partially | Yes | Render accounting worker (`engine/ai_recovery.py`) | deterministic parsing found no transactions; also switchable off with `ACCOUNTING_AI_RECOVERY=false` |

**Hugging Face:** no integration exists. No code calls any Hugging Face API or
model (verified by searching the codebase on 2026-10-19).

## Provider terms (published, as checked on 2026-10-19)

| Provider | Training on API data | Retention | Region | Source |
|---|---|---|---|---|
| OpenAI | **Not used by default** ("data sent to the OpenAI API is not used to train or improve OpenAI models" unless the customer opts in) | abuse-monitoring logs **up to 30 days**; Zero Data Retention only with OpenAI's prior approval | US by default; European processing needs approval for abuse-monitoring controls and a Modified Retention amendment | [OpenAI: your data](https://developers.openai.com/api/docs/guides/your-data) |
| Azure Document Intelligence | Microsoft's page does not describe any use of analyze inputs for training | input and results **deleted 24 h after the analysis completes** (or earlier via Delete Analyze Result) | the **region of the Document Intelligence resource** | [Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/document-intelligence/data-privacy-security) |
| Mistral | ⚠️ **API calls may be used to improve Mistral's services unless the organisation disables "Anonymous improvement data"** in admin.mistral.ai → Privacy. Scale plans are described as opted out by default; the default for other plans is not stated | not stated on the help pages checked; Zero Data Retention is available on pay-as-you-go for stateless calls, by request | not stated on the pages checked | [Mistral: training opt-out](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training), [Mistral: ZDR](https://help.mistral.ai/en/articles/347612-can-i-activate-zero-data-retention-zdr) |

### Actions for the account owner (cannot be done from code)

1. **Mistral:** in admin.mistral.ai → Privacy, confirm **"Anonymous improvement data" is OFF**, and consider requesting Zero Data Retention. Mistral receives whole bank-statement PDFs.
2. **Azure:** confirm the Document Intelligence resource's region (the code does not know it). A South African or EU region keeps the 24-hour copy closer to the data subjects.
3. **OpenAI:** confirm no data-sharing opt-in is enabled on the organisation; consider applying for Zero Data Retention / EU data residency.
4. **DPAs:** have a signed data processing agreement (or accepted DPA terms) on file for each of OpenAI, Mistral and Microsoft.

## Controls in the product

* **Per-workspace control (migration 051, `lib/privacy/external-processing.ts`).**
  The workspace owner can block external AI processing. When blocked, nothing
  in the table above is called for that workspace: the pipeline uses PDF.js,
  pdfplumber and Tesseract only; extraction is deterministic; accounting
  commentary is generated locally; the accounting worker makes no OpenAI call
  (`allow_external_ai: false`); shadow mode does not run. Enforced on the server
  in every entry point, and each engine is gated on the decision.
* **No choice recorded = allowed**, which is the behaviour every workspace has
  had until now. Whether the default should become "blocked" (opt-in consent) is
  an owner/legal decision, recorded below.
* **Fail-closed:** if the setting cannot be read, external processing is blocked
  for that request.

## POPIA (South Africa) — engineering view

POPIA section 72 restricts transferring personal information to a third party
in a foreign country unless, among other grounds, the recipient is bound by a
law, binding corporate rules or a binding agreement giving substantially similar
protection, or the data subject consents, or the transfer is necessary for a
contract with the data subject. Every provider above processes outside South
Africa. The defensible position therefore needs (a) a binding agreement (DPA)
with each provider, (b) disclosure of these processors in the privacy notice,
and (c) for customers who do not accept that, the per-workspace block above.
Bank statements carry ID and account numbers, so this matters. Whether
customer consent must be opt-in rather than opt-out is a legal decision.

## Not yet done

* Customer-facing disclosure (privacy notice / sub-processor list) and the
  Settings control UI — tracked separately; they need the owner's wording.
* Text minimisation: structured extraction still sends the full text; vision OCR
  silently drops pages after 10. Tracked in the AI roadmap.
