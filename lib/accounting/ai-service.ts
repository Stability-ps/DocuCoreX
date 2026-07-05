// Server-side only — do not import from client components

export type AiCommentaryType =
  | "executive-summary"
  | "audit-notes"
  | "vat-commentary"
  | "risk-explanation"
  | "forecast-commentary";

export type AiCommentaryResult = {
  commentary: string;
  keyPoints: string[];
  recommendations: string[];
  provider: "openai" | "deterministic";
};

export type AiContext = {
  companyName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalCredits: number;
  totalDebits: number;
  netSurplus: number;
  transactionCount: number;
  reviewCount: number;
  confidence: number;
  riskScore?: number;
  riskLevel?: string;
  vatAnomalyCount?: number;
  duplicateCount?: number;
  unusualCount?: number;
  openingBalance?: number | null;
  closingBalance?: number | null;
};

function fmt(value: number): string {
  return `R${value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function deterministicCommentary(
  type: AiCommentaryType,
  ctx: AiContext,
): AiCommentaryResult {
  const company = ctx.companyName || "the business";
  const period =
    ctx.periodStart && ctx.periodEnd
      ? `${ctx.periodStart} to ${ctx.periodEnd}`
      : "the statement period";
  const netDir = ctx.netSurplus >= 0 ? "surplus" : "deficit";
  const reviewNote =
    ctx.reviewCount > 0
      ? `${ctx.reviewCount} transaction${ctx.reviewCount > 1 ? "s require" : " requires"} review.`
      : "All transactions have been processed.";

  if (type === "executive-summary") {
    return {
      commentary: `For ${period}, ${company} recorded ${fmt(ctx.totalCredits)} in total receipts and ${fmt(ctx.totalDebits)} in total payments, resulting in a net cash ${netDir} of ${fmt(Math.abs(ctx.netSurplus))}. ${ctx.transactionCount} transactions were extracted at ${ctx.confidence}% confidence. ${reviewNote} This is a draft cash-basis summary requiring accountant review before use in formal reporting.`,
      keyPoints: [
        `Total receipts: ${fmt(ctx.totalCredits)}`,
        `Total payments: ${fmt(ctx.totalDebits)}`,
        `Net cash ${netDir}: ${fmt(Math.abs(ctx.netSurplus))}`,
        `${ctx.transactionCount} transactions at ${ctx.confidence}% confidence`,
        ctx.reviewCount > 0 ? `${ctx.reviewCount} items pending review` : "All items processed",
      ],
      recommendations: [
        ctx.reviewCount > 0
          ? "Complete the Review Queue before using this data for financial reporting or VAT filing."
          : "Statement is ready for export and accountant review.",
        "Verify all account category assignments before GL posting.",
      ],
      provider: "deterministic",
    };
  }

  if (type === "audit-notes") {
    const issues: string[] = [];
    if (ctx.reviewCount > 0) issues.push(`${ctx.reviewCount} items in the review queue`);
    if (ctx.duplicateCount) issues.push(`${ctx.duplicateCount} potential duplicate payment group${ctx.duplicateCount > 1 ? "s" : ""}`);
    if (ctx.vatAnomalyCount) issues.push(`${ctx.vatAnomalyCount} VAT anomal${ctx.vatAnomalyCount > 1 ? "ies" : "y"}`);
    const issueText = issues.length
      ? `Key findings: ${issues.join("; ")}.`
      : "No significant issues detected.";
    return {
      commentary: `Audit notes for ${company} — ${period}. Statement extracted at ${ctx.confidence}% confidence from ${ctx.transactionCount} transactions. ${issueText} This is a draft working note for accountant review only — not a formal audit report.`,
      keyPoints: [
        `Extraction confidence: ${ctx.confidence}%`,
        `Transactions: ${ctx.transactionCount}`,
        ctx.reviewCount > 0 ? `Review queue: ${ctx.reviewCount} items` : "Review queue: clear",
        ctx.duplicateCount ? `Duplicate groups: ${ctx.duplicateCount}` : "Duplicates: none detected",
        ctx.vatAnomalyCount ? `VAT anomalies: ${ctx.vatAnomalyCount}` : "VAT: no anomalies",
      ],
      recommendations: [
        "Obtain supporting documentation for all payments over R5,000.",
        "Confirm all account category assignments before GL posting.",
        ctx.reviewCount > 0 ? "Resolve all review queue items before filing." : "",
      ].filter(Boolean),
      provider: "deterministic",
    };
  }

  if (type === "vat-commentary") {
    const anomalyText = ctx.vatAnomalyCount
      ? `${ctx.vatAnomalyCount} VAT anomal${ctx.vatAnomalyCount > 1 ? "ies were" : "y was"} detected and require resolution.`
      : "No VAT anomalies were detected in this statement.";
    return {
      commentary: `VAT analysis for ${company} — ${period}. ${anomalyText} Verify all standard-rated transactions against valid SARS tax invoices before completing the VAT201 return. This is an internal review summary — not a SARS-approved VAT return or tax advice.`,
      keyPoints: [
        ctx.vatAnomalyCount ? `${ctx.vatAnomalyCount} VAT anomalies detected` : "No VAT anomalies",
        "Standard-rated transactions require valid tax invoices",
        "Input VAT claims require SARS-compliant tax invoices (s20 of the VAT Act)",
        "Output VAT on receipts must be declared on VAT201",
      ],
      recommendations: [
        "Obtain compliant tax invoices for all standard-rated expenses before input VAT claims.",
        "Verify output VAT on all receipts from VAT-registered customers.",
        ctx.vatAnomalyCount ? "Resolve all VAT anomalies before submitting the VAT201 return." : "",
      ].filter(Boolean),
      provider: "deterministic",
    };
  }

  if (type === "risk-explanation") {
    const score = ctx.riskScore ?? 0;
    const level = ctx.riskLevel ?? "unknown";
    return {
      commentary: `Internal SARS risk assessment for ${company} — ${period}. Risk score: ${score}/100 (${level}). This is an internal advisory estimate only and does not constitute a SARS assessment, tax advice, or guarantee of compliance. Engage a registered tax practitioner for formal advice.`,
      keyPoints: [
        `Risk score: ${score}/100 (${level})`,
        ctx.vatAnomalyCount ? `VAT anomalies: ${ctx.vatAnomalyCount}` : "No VAT anomalies",
        ctx.duplicateCount ? `Duplicate payments: ${ctx.duplicateCount}` : "No duplicates",
        ctx.reviewCount > 0 ? `Items pending review: ${ctx.reviewCount}` : "All items reviewed",
      ],
      recommendations: [
        score > 50 ? "Engage a registered tax practitioner before SARS submission." : "Review any open items before filing.",
        "Internal advisory score only — not tax advice.",
      ],
      provider: "deterministic",
    };
  }

  // forecast-commentary
  return {
    commentary: `Cash flow forecast for ${company} based on ${period} averages (${ctx.transactionCount} transactions). Projections assume consistent income and expense patterns. Seasonality, one-off transactions and business changes are not modelled. Process additional statement periods to improve forecast accuracy.`,
    keyPoints: [
      `Average receipts used for projection: ${fmt(ctx.totalCredits)}`,
      `Average payments used for projection: ${fmt(ctx.totalDebits)}`,
      `Projected net monthly cash flow: ${fmt(ctx.netSurplus)}`,
    ],
    recommendations: [
      "Process 3+ statement periods to build a reliable forecast baseline.",
      "Exclude large one-off transactions from the forecast base.",
      "Review the forecast monthly against actual statements.",
    ],
    provider: "deterministic",
  };
}

export async function generateCommentary(
  type: AiCommentaryType,
  ctx: AiContext,
): Promise<AiCommentaryResult> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return deterministicCommentary(type, ctx);

  const typePrompts: Record<AiCommentaryType, string> = {
    "executive-summary": "Write a concise executive summary for the bank statement period. Include key financial figures and any items requiring attention.",
    "audit-notes": "Generate professional audit notes highlighting key findings, extraction quality and items requiring attention.",
    "vat-commentary": "Write a VAT commentary summarising VAT exposure, anomalies and filing considerations under South African VAT law.",
    "risk-explanation": "Explain the SARS risk factors identified and their implications for the business. Be specific and actionable.",
    "forecast-commentary": "Write a brief cash flow forecast commentary including caveats about single-period projections.",
  };

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_ACCOUNTING_MODEL ?? "gpt-4o-mini",
        max_tokens: 500,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a professional South African chartered accountant writing concise factual commentary from bank statement data. Never invent financial figures — only use data explicitly provided. Use South African terminology (SARS, VAT201, rand amounts with R prefix, IFRS). Always note that outputs are draft and require accountant review. Respond only with JSON matching the schema: { commentary: string, keyPoints: string[], recommendations: string[] }.",
          },
          {
            role: "user",
            content: `${typePrompts[type]}\n\nContext data:\n${JSON.stringify(ctx, null, 2)}`,
          },
        ],
      }),
    });

    if (!response.ok) return deterministicCommentary(type, ctx);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return deterministicCommentary(type, ctx);

    const parsed = JSON.parse(raw) as {
      commentary?: string;
      keyPoints?: string[];
      recommendations?: string[];
    };
    return {
      commentary: parsed.commentary ?? deterministicCommentary(type, ctx).commentary,
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      provider: "openai",
    };
  } catch {
    return deterministicCommentary(type, ctx);
  }
}
