# DocuCoreX — Comprehensive Architecture & Code Audit

> Audit date: 2026-07-05  
> Auditor: Claude Code (claude-sonnet-4-6)  
> Scope: Read-only — no files were modified during this audit.

---

## 1. Architecture Overview

DocuCoreX is a multi-tenant SaaS document intelligence platform deployed across three independent services that communicate over HTTP:

**Service 1 — Next.js frontend** (Vercel)
- App Router with server components and client components
- Handles auth, all UI, most API routes, and job orchestration
- Falls back to in-memory mock data when Supabase is not configured

**Service 2 — Conversion worker** (Render, Docker)
- The same Next.js app running with `CONVERSION_WORKER_MODE=true`
- Has native OCR/format-conversion tools (`ocrmypdf`, `tesseract`, `ghostscript`, LibreOffice) that are unavailable in Vercel's serverless runtime
- Receives forwarded `/api/jobs/process` requests from Vercel

**Service 3 — Accounting worker** (Render, Python/FastAPI)
- Deterministic FNB PDF extraction with optional OpenAI classification
- Uploads Excel workbooks back to Supabase Storage

**Data layer — Supabase**
- PostgreSQL with Row Level Security
- Supabase Auth (email/password + Google + Microsoft/Azure OAuth)
- File storage in a `documents` bucket

---

## 2. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router) | 15.5.19 |
| UI library | React | 19.0.0 |
| Language | TypeScript | 5.7 |
| Styling | Tailwind CSS | 3.4.17 |
| Icons | Lucide React | 0.468 |
| Auth/DB/Storage | Supabase SSR | 0.12 / JS 2.108 |
| Package manager | pnpm | workspace |
| Accounting worker | Python / FastAPI | 3.12.8 |
| Conversion worker | Docker + Node | same Next.js codebase |
| E2E tests | Playwright | 1.61 |
| Type-check only | tsc (`tsconfig.lint.json`) | — |
| Linting | **None** (no ESLint configured) | — |
| Unit tests | **None** | — |

Custom design system: two-color palette (`royal-*` blues, `navy-*` darks) defined in `tailwind.config.ts`.

---

## 3. Folder Structure

```
app/
  api/                    ← ~50 API route files
    auth/signin|signup    ← server-side auth endpoints
    jobs/process          ← central job processor / conversion proxy
    uploads/              ← file upload, signed URLs, workflow
    accounting/fnb/       ← FNB statement pipeline
    conversions/          ← conversion jobs + debug
    documents/            ← CRUD + bulk
    invoices/             ← CRUD
    ...
  dashboard|upload|convert|accounting|invoices|... ← page routes
components/
  app-shell.tsx           ← global nav, search, notifications, profile
  dashboard-live.tsx      ← live data dashboard
  upload-center.tsx       ← drag-drop upload + conversion queue
  conversion-workflow.tsx ← /convert page single-job workflow
  document-library.tsx    ← document list with bulk actions
  document-workspace.tsx  ← per-document detail view
  accounting/accounting-intelligence.tsx ← main accounting UI
  invoices/               ← invoice list, create form, detail, preview
  placeholder-page.tsx    ← "coming soon" template
lib/
  types.ts                ← all shared TypeScript types
  supabase.ts             ← browser client + feature flags
  supabase-server.ts      ← server + service-role clients
  server-documents.ts     ← getWorkspaceContext(), upload/document helpers
  workflow-adapters.ts    ← OCR/extraction/conversion provider abstraction
  document-conversion-engine.ts ← actual conversion logic (node:child_process)
  mock-repository.ts      ← in-memory store for documents/jobs/etc
  app-state.ts            ← in-memory store for team/settings/etc
  workspace-bootstrap.ts  ← auto-create workspace on signup
  accounting/server.ts    ← accounting DB access layer
  accounting/types.ts     ← accounting TypeScript types
supabase/migrations/      ← 11 numbered SQL migrations
workers/
  conversion_worker/      ← Dockerfile + README
  accounting_worker/      ← Python FastAPI service
tests/e2e/                ← 2 Playwright spec files
```

---

## 4. Current Functionality

### Working and reasonably complete

- **Document upload** — XHR with progress tracking, pause/resume/cancel/retry, drag-drop, folder upload, queue persistence in localStorage
- **Document library** — list, search, filter, star, archive, rename, soft-delete, bulk actions, version history UI
- **Document workspace** — per-document detail with tabs: Overview, Preview, OCR, Extracted Data, AI Analysis, History, Comments, Downloads
- **File conversion** — PDF/Word/Excel/ZIP via conversion worker or local engine; two UX flows (Upload Center and Convert page)
- **FNB bank statement processing** — full pipeline: upload → Python worker → transactions extracted → Excel workbook → tabs: Transactions, Review Queue, Difference Inspector, Summary, Bank Rec, VAT, General Ledger, Trial Balance
- **Invoicing** — create, edit, list, PDF print, status management (draft/issued/paid/overdue/cancelled), VAT support, company profiles for branding
- **Company profiles** ��� reusable issuer/bank details for invoices, default currency/VAT/payment terms
- **Notifications** — full system (create, read, mark read, delete, bulk select/delete)
- **Audit logging** — all key actions recorded
- **Authentication** — email/password, Google OAuth, Microsoft/Azure OAuth, password reset, workspace auto-bootstrap on signup
- **App shell** — responsive sidebar (desktop) + bottom tab bar (mobile), global search, notifications dropdown, profile menu
- **Settings** — extensive console covering profile, appearance, notifications, security, audit logs, API keys, billing, team, companies, storage, OCR/AI providers, integrations
- **Dashboard** — live data: usage stats (docs/pages/credits), recent documents, job shortcuts
- **Mobile responsiveness** — scroll-aware bottom nav, safe-area-inset support, touch-manipulation, iOS font-size fix, PWA manifest
- **PWA** — manifest.json, apple-web-app meta, theme color
- **Cron job** — `/api/jobs/process` triggered by Vercel cron (though extremely sparse — see issues)

---

## 5. Missing Functionality

These are features that are advertised, listed in the nav, or have routes but no implementation:

| Feature | Evidence | Status |
|---|---|---|
| **PDF Editor** ("Adobe-class") | Landing page hero section; editor tools shown | Not implemented anywhere in app |
| **eSign** | Listed under Features on landing page | No route, no UI |
| **Document Archive** | `/documents/archive` in nav | `PlaceholderPage` |
| **Document Folders** | `/documents/folders` in nav and New menu | `PlaceholderPage` |
| **Document Trash / Recent / Shared** | Listed in nav sub-items | Routes don't exist (404) |
| **Intake** (`/intake`) | Listed in nav | Component exists but content unknown |
| **OCR sub-page** (`/convert/ocr`) | Nav sub-item | Route doesn't exist (404) |
| **Extraction sub-page** (`/convert/extraction`) | Nav sub-item | Route doesn't exist (404) |
| **Summaries / AI Q&A** (`/convert/summaries`) | Nav sub-item | Route doesn't exist (404) |
| **Compare** (`/convert/compare`) | Nav sub-item | Route doesn't exist (404) |
| **Translate** (`/convert/translate`) | Nav sub-item | Route doesn't exist (404) |
| **Redact** (`/convert/redact`) | Nav sub-item | Route doesn't exist (404) |
| **Settings > Developer** | Nav | `PlaceholderPage` |
| **Settings > Advanced** | Nav | `PlaceholderPage` |
| **Invoice email sending** | `// TODO` in `invoice-detail.tsx:51` | No transactional email provider wired |
| **Document sharing by email** | Hardcoded `"Email sharing coming soon."` in `document-library.tsx:251,826` | Not implemented |
| **2FA / MFA** | Login page note: "future-ready"; profile setting exists but does nothing | Not implemented |
| **Billing / Stripe** | Billing page and settings section present | No payment provider connected |
| **Virus scanning** | `virus_scan` in `job_type` DB enum | Never triggered or implemented |
| **Image export from PDF** | Conversion target in UploadCenter hardcoded `disabled: true` | Blocked by missing renderer |
| **ABSA / Nedbank / Standard Bank / Capitec / Investec accounting parsers** | `supportedBanks` array in accounting UI; `active: false` on all except FNB | Only FNB works |
| **Accounting advanced filters** | Button with tooltip "coming soon" | Not implemented |
| **Accounting column customization** | Button with tooltip "coming soon" | Not implemented |
| **Bank Reconciliation** (matching) | Tab exists, listed as a feature | Tab renders but matching logic not wired |
| **AI Assistant on documents** | "AI Analysis" tab in document workspace; advertised in landing | Uses mock data, no real LLM call from the workspace |
| **Reconciliation queue matching** | Tab shows review items | Interface only; no auto-match algorithm |

---

## 6. Broken Functionality

| Issue | Location | Impact |
|---|---|---|
| **Nav sub-items route to 404** | `product-data.ts` nav children: `/convert/ocr`, `/convert/extraction`, etc. | Clicking any of these 6 nav items hits a Next.js 404 |
| **Document sub-routes route to 404** | `/documents/recent`, `/documents/shared`, `/documents/trash` in nav | Clicking these 3 nav items hits 404 |
| **"Watch Demo" links to auth-gated `/dashboard`** | `app/page.tsx:243` | Redirects unauthenticated users to login instead of showing a demo |
| **"Features/Solutions/Developers/Pricing" footer links** | `app/page.tsx:544-547` | Link `/convert` for "Developers" and `/settings` for "Pricing" are wrong/misleading |
| **"Create Folder" in New menu routes to `PlaceholderPage`** | `product-data.ts:113` `href: "/documents/folders"` | Users get a dead-end "Coming soon" page |
| **"Remember this device" checkbox has no effect** | `app/login/page.tsx:357-363` | Renders a checkbox but no handler; purely cosmetic |
| **Sequential notification PATCH loop** | `app-shell.tsx:223-238` | For N selected notifications, fires N sequential API calls instead of a batch request; will visually lag and can partially fail |
| **`findLatestConvertedDocument` heuristic** | `conversion-workflow.tsx:172-191` | Finds the converted output by tag + timestamp proximity — fragile under concurrent conversions or slow uploads |
| **Conversion debug panel always visible in production** | `conversion-workflow.tsx:428-453` | The `conversionDebug` state object is rendered whenever it's set, with no production/dev guard; exposes internal job IDs and conversion IDs to end users in production |

---

## 7. UX/UI Observations

### Strengths

- Design language is consistent and polished — `royal-*` / `navy-*` palette, rounded corners, soft shadows
- Mobile shell is well-considered: bottom tab bar, scroll-hide behavior, safe area insets, iOS font-size fix preventing zoom
- Skeleton loading states in Dashboard; optimistic UI patterns in many forms
- Bulk selection with shift-click, long-press on mobile, toolbar actions — above average for a startup-stage product
- Session-storage caching (60s TTL) for profile and notifications avoids redundant requests on navigation

### Issues

- **Landing page advertises features that don't exist** (PDF editor, eSign, multiple bank parsers, Reconciliation, AI Assistant) — creates expectation gap
- **Nav is over-populated with dead routes** — 9+ links in the nav lead to 404 or placeholder pages; first-time users will be confused
- **No loading/error state** on the `/convert/ocr`, `/convert/summaries` etc. routes — they simply 404 rather than showing a graceful "coming soon"
- **The Conversion Workflow page has two separate UX flows** (`/upload` with UploadCenter and `/convert` with ConversionWorkflow) that have different capabilities but similar goals — creates confusion about which to use
- **Accounting tabs (Bank Rec, General Ledger, Trial Balance)** render but have no functional content beyond the tab UI
- **The `"Recommended: Accounting Intelligence"` prompt** in UploadCenter is smart UX but the recommendation logic is a naive keyword match on the filename/mime-type
- **Search is desktop-only** — the search bar in AppShell is `hidden` on mobile with no mobile equivalent
- **Notifications panel is absolute-positioned** and can overflow the viewport on small screens
- **"Forgot Password" is in a 3-tab segmented control** alongside Login and Create Account — unusual placement; feels like a fourth option, not a sub-flow
- **Profile menu on desktop does not show the user's email** — only name and company; makes it unclear which account is logged in with multiple tabs
- **"Continue to Dashboard (Dev Only)"** button on the login page will be a support issue if it ever leaks to production
- **Dark mode** — CSS has `color-scheme: light` locked; no dark mode support despite "Appearance" settings section existing

---

## 8. Database Observations

### Strengths

- RLS enabled on all sensitive tables
- Proper workspace isolation (every table scoped to `workspace_id`)
- Migrations are numbered and idempotent (`create table if not exists`, `add value if not exists`)
- `accounting_transactions` has `confidence`, `review_status`, `raw_text`, and `source_page` — good for audit trails

### Issues & Gaps

1. **Schema drift on `notifications` table** — Migration `002` creates `notifications` with a simple `read boolean` column. Migration `010` adds `entity_type`, `entity_id`, `href`, `read_at` and removes/renames `read`. The TypeScript `NotificationRecord` type references `readAt` (camelCase, nullable timestamp) but the original table has `read` (boolean). Migration 010 must have applied a transform — this is hard to track and risky to roll back.

2. **`job_type` enum has `virus_scan`** that is never used. Dead schema increases cognitive overhead.

3. **`conversions` table** is missing an `output_ready` boolean column — migration 011 adds `output_ready` as a `job_status` enum value rather than a separate column; the code checks for `status = 'output_ready'`, which is a non-standard use of a job status enum that can conflict with the existing `completed` semantic.

4. **`document_shares` table exists** (migration 002) but sharing is "coming soon" in the UI.

5. **`uploads` table** (migration 002) exists alongside `documents` — the relationship between them is unclear; the code primarily uses `documents` and `processing_jobs`, not the `uploads` table.

6. **No soft-delete on accounting runs** — hard delete only; if a document is deleted, `document_id` in the accounting run becomes null (`ON DELETE SET NULL`).

7. **`workspace-bootstrap.ts` creates a `team_members` record** for the owner but the `team_members` table has no unique constraint on `(workspace_id, user_id)` — only `(workspace_id, email)`; if a user changes their email this could cause duplicates.

8. **`companies` table `next_invoice_number`** — maintained as a counter in the DB, but there is no DB-level locking for concurrent invoice creation. Race conditions on sequence numbers are possible.

9. **No RLS policies visible in migration 002** for `notifications`, `team_members`, `document_shares`, `uploads`. Some may be handled via later migrations, but this warrants verification.

10. **No indexes on `conversions` table** — the initial schema has no indexes; queries in the job processor join documents and filter by status.

---

## 9. Performance Observations

| Issue | Severity | Details |
|---|---|---|
| **Client-side polling at 1.6s** | High | `UploadCenter` calls `/api/jobs/process` (POST) + `/api/uploads/workflow` (GET) every 1.6 seconds while `isProcessing` is true. For the Vercel frontend this also triggers a proxy to the Render worker. High request volume, no backoff. |
| **8 consecutive job-process calls at conversion start** | Medium | `startProcessing()` fires `fetch("/api/jobs/process")` 8 times in a tight loop. Intended to "kick" the worker but creates a thundering-herd mini-burst. |
| **No server-side pagination on `/api/documents`** | Medium | Returns all documents in one response; at scale this becomes a large JSON payload. The library shows the first 24 but fetches everything. |
| **Dashboard makes 4 parallel API calls on mount** | Low | `/api/profile`, `/api/usage`, `/api/jobs`, `/api/documents` — parallel is fine but `/api/documents` overlaps with the library's separate fetch. |
| **Conversion worker on Render Starter plan** | Medium | Free/starter Render instances spin down after inactivity; cold starts of 30–60s would cause conversion timeouts. No health-check ping configured in the frontend. |
| **Vercel cron runs once daily at 2am UTC** | High | Documents uploaded at any other time depend entirely on client-side polling. If a user closes the browser, jobs stall until the next 2am cron or a new browser session. |
| **No Supabase Realtime subscriptions** | Medium | All live updates are poll-based. Supabase Realtime could replace the polling loop for job status with zero client overhead. |
| **`sessionStorage` caching only** | Low | Profile and notification cache uses `sessionStorage` (60s TTL), which is per-tab. Opening a second tab re-fetches everything. |

---

## 10. Security Observations

| Issue | Severity | Details |
|---|---|---|
| **No file size validation in upload API** | High | `app/api/uploads/route.ts` reads `file.size` for logging but never rejects oversized files server-side. The 200 MB limit is only enforced in the UI; a raw POST bypasses it entirely. |
| **No virus scanning** | High | `virus_scan` exists in the `job_type` enum but is never triggered. Documents are uploaded directly to Supabase Storage without any malware check. |
| **No CSP or security headers** | Medium | `next.config.ts` has no `headers()` configuration. No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Strict-Transport-Security` headers are set. |
| **No rate limiting on auth or upload endpoints** | Medium | `/api/auth/signin`, `/api/auth/signup`, `/api/uploads` have no rate limiting. Susceptible to credential stuffing, brute force, and upload abuse. |
| **Conversion debug panel leaks internal IDs in production** | Medium | `conversion-workflow.tsx` shows `conversionId`, `jobId`, and current status when a conversion runs — there is no dev/prod guard on this panel. |
| **Worker secret over HTTP** | Low | `x-docucorex-worker-secret` header is HTTPS in practice (Render enforces TLS), but the codebase has no enforcement. |
| **"Remember this device" non-functional** | Low | The checkbox renders in the login form but has no handler. Users may rely on it for session management expectations. |
| **`NEXT_PUBLIC_ACCOUNTING_DIAGNOSTICS`** not in `.env.example` | Low | This flag enables diagnostic panels in production; if not explicitly set to `false` it could leak debug info. |
| **Supabase service role key** | OK | Used only server-side; never in `NEXT_PUBLIC_*` variables. No client exposure found. |
| **RLS on sensitive tables** | OK | All accounting, invoice, document, and company tables have RLS enabled with workspace-scoped policies. |
| **Auth is correctly server-side** | OK | Sign-in/sign-up are API routes, not client-side Supabase calls. Cookies set server-side via `@supabase/ssr`. |

---

## 11. Technical Debt

1. **Dual `fullName` / `full_name` normalization** — Profile data arrives from Supabase as `full_name` (snake_case) but app-state and some mock paths use `fullName` (camelCase). Multiple utility functions (`profileName()`, `firstName()`) guard both. Should be normalized at the data boundary.

2. **`@deprecated bankDetails` field** — `InvoiceRecord.bankDetails` is marked deprecated but remains in the DB schema and TypeScript type. Should be removed once all invoices have migrated to structured bank fields.

3. **Mock path vs. Supabase path divergence** �� Several API routes (e.g. `/api/conversions`, `/api/jobs/process`) have separate `if (!context)` branches for mock vs. Supabase. The mock paths accumulate bugs not caught in testing; they diverge silently from the real paths.

4. **Two conversion UX flows** — `UploadCenter` (`/upload`) and `ConversionWorkflow` (`/convert`) both convert documents but have different state machines, different polling strategies, and different capabilities. Duplicated logic that needs consolidation.

5. **No ESLint** — Only `tsc --noEmit` is run as "lint". Unused imports, shadowed variables, and accessibility issues go uncaught.

6. **Only 2 E2E test files; zero unit tests** — `app-smoke.spec.ts` and `conversion-engine.spec.ts`. The entire accounting pipeline, invoicing system, and document processing flow have no automated coverage.

7. **`localStorage` queue in UploadCenter** has no expiry or workspace-scoping — a queue from one session/workspace could surface in another.

8. **Sequential notification PATCHes** — Marking N notifications read fires N sequential HTTP calls. A batch endpoint exists conceptually (bulk delete works) but marking-read doesn't batch.

9. **Type assertions (`as SomeType`) are widespread** in API routes. Incoming `request.json()` bodies are cast without runtime validation (no Zod or similar); a malformed payload could cause unexpected runtime errors.

10. **`getConversionIdFromMessage()` / `getTargetFormat()` string-parsing** in `route.ts` extract the conversion ID from the job `message` field — this is fragile and error-prone; the conversion ID should be stored as a first-class column on `processing_jobs`.

11. **Accounting worker `AI_CLASSIFICATION_CACHE`** is a module-level Python dict — not persisted across restarts and not bounded in size; on a long-running worker it will grow unboundedly.

12. **`vercel.json` cron at `0 2 * * *`** (2am UTC daily) is effectively useless for real-time document processing. It exists as a safety net but the primary driver is client-side polling.

---

## 12. Prioritized Recommendations

### P0 — Critical / Fix Before Growth

1. **Add server-side file size validation** in `/api/uploads/route.ts` — reject files > 200 MB before writing to storage.
2. **Gate the conversion debug panel** behind `process.env.NODE_ENV !== "production"` — prevent internal IDs from leaking to users.
3. **Add rate limiting** to `/api/auth/signin`, `/api/auth/signup`, and `/api/uploads` — even a simple in-memory limiter per IP via middleware prevents brute-force and upload abuse.
4. **Fix the dead nav links** — either create the routes or remove them from `appNav`; 9 nav items routing to 404 will destroy trust with real users.

### P1 — High Priority / Before Public Launch

5. **Replace client-side polling with Supabase Realtime** subscriptions on `processing_jobs` and `conversions` tables — eliminate the 1.6s polling loop and the thundering-herd 8-call burst at conversion start.
6. **Add security headers** in `next.config.ts` — at minimum `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`.
7. **Add server-side pagination** to `/api/documents` — `?page=` and `?limit=` parameters; default to 50 results.
8. **Remove or disable the "Watch Demo" link** until a real public demo workspace exists — it currently routes unauthenticated users to a redirect loop.
9. **Align the landing page feature claims with reality** — remove or caveat PDF editing, eSign, multi-bank support, reconciliation, and AI Assistant until they are built.
10. **Add batch notification marking** — single PATCH endpoint for `ids[]` to replace the sequential loop.

### P2 — Medium Priority / Next Quarter

11. **Implement Document Folders and Trash** — replace PlaceholderPages; these are core document management features.
12. **Wire a transactional email provider** (Resend, SendGrid, or Postmark) for invoice sending — currently a hardcoded TODO.
13. **Add input validation** (Zod schemas) to all API route request bodies — replace unsafe `as SomeType` casts.
14. **Implement virus scanning** — activate the existing `virus_scan` job type using ClamAV or a cloud service; all uploaded documents should be scanned before marking `status = ready`.
15. **Consolidate the two conversion UX flows** — merge UploadCenter's conversion queue and ConversionWorkflow into a single stateful flow to reduce code duplication and user confusion.
16. **Upgrade the Vercel cron** from daily 2am to every 5 minutes (`*/5 * * * *`) as a fallback processor for abandoned browser sessions.

### P3 — Lower Priority / Roadmap

17. **Add ESLint** — at minimum `@typescript-eslint/no-explicit-any` and `jsx-a11y` to catch type casts and accessibility issues.
18. **Add unit tests** for `document-conversion-engine.ts`, the accounting transaction parser, and invoice calculation utilities.
19. **Normalize `fullName` / `full_name`** at the Supabase data boundary — pick one casing and use it everywhere.
20. **Remove `bankDetails` deprecated field** from `InvoiceRecord` type and DB schema after migration.
21. **Implement ABSA/Nedbank/Standard Bank parser stubs** in the accounting worker's `engine/registry.py` — even minimal structural parsers would unlock the bank selector in the UI.
22. **Bound the accounting worker AI cache** (`AI_CLASSIFICATION_CACHE`) with an LRU policy or TTL to prevent unbounded memory growth.
23. **Add dark mode** — the Appearance settings section exists; implement the CSS variables and `prefers-color-scheme` support.
