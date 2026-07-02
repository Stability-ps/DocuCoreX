import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

type CombineBody = {
  runIds?: string[];
  combineDifferentAccounts?: boolean;
};

function getWorkerOrigin(workerUrl: string) {
  try {
    return new URL(workerUrl).origin;
  } catch {
    return "invalid-worker-url";
  }
}

function sameAccountKey(detail: NonNullable<Awaited<ReturnType<typeof getAccountingRunDetail>>>) {
  return [
    detail.run.companyName?.trim().toLowerCase() ?? "",
    detail.run.bank.trim().toLowerCase(),
    detail.run.accountNumber?.trim().toLowerCase() ?? "",
  ].join("|");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CombineBody;
  const runIds = Array.from(new Set(body.runIds ?? [])).filter(Boolean);

  if (runIds.length < 2) {
    return NextResponse.json({ error: "Select at least two completed statements to combine." }, { status: 400 });
  }

  const workerUrl = process.env.ACCOUNTING_WORKER_URL;
  if (!workerUrl) {
    return NextResponse.json(
      { error: "Accounting worker is not configured. Set ACCOUNTING_WORKER_URL to generate combined workbooks." },
      { status: 503 },
    );
  }

  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const details = await Promise.all(runIds.map((runId) => getAccountingRunDetail(runId)));
  if (details.some((detail) => !detail)) {
    return NextResponse.json({ error: "One or more selected statements could not be found." }, { status: 404 });
  }

  const validDetails = details.filter(Boolean) as Array<NonNullable<(typeof details)[number]>>;
  const invalidStatus = validDetails.find((detail) => !["completed", "review"].includes(detail.run.status));
  if (invalidStatus) {
    return NextResponse.json({ error: "Only completed or review-ready statements can be combined." }, { status: 422 });
  }

  if (!body.combineDifferentAccounts) {
    const keys = new Set(validDetails.map(sameAccountKey));
    if (keys.size > 1) {
      return NextResponse.json(
        { error: "Selected statements are not the same company, bank and account number." },
        { status: 422 },
      );
    }
  }

  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/combine-fnb-statements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      workspace_id: context.workspaceId,
      run_ids: runIds,
      combine_different_accounts: Boolean(body.combineDifferentAccounts),
    }),
  });

  const responseBuffer = await response.arrayBuffer();
  if (!response.ok) {
    const text = new TextDecoder().decode(responseBuffer);
    let error = text || "Combined workbook generation failed.";
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; error?: string };
      error = typeof parsed.detail === "string" ? parsed.detail : parsed.error ?? JSON.stringify(parsed.detail ?? parsed);
    } catch {
      // keep text body
    }
    return NextResponse.json(
      {
        error,
        workerStatus: response.status,
        workerOrigin: getWorkerOrigin(workerUrl),
      },
      { status: response.status },
    );
  }

  const first = validDetails
    .slice()
    .sort((a, b) => String(a.run.statementPeriodStart ?? "").localeCompare(String(b.run.statementPeriodStart ?? "")))[0]?.run;
  const account = first?.accountNumber ?? "statement";
  return new NextResponse(responseBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="FNB-combined-accounting-pack-${account}.xlsx"`,
      "X-DocuCoreX-Combined-Summary": response.headers.get("X-DocuCoreX-Combined-Summary") ?? "",
    },
  });
}
