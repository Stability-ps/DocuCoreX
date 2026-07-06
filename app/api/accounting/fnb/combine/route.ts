import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { buildWorkerEndpoint, createWorkerRequestId, getWorkerConfig, logWorkerStartupCheck } from "@/lib/system-worker-config";

type CombineBody = {
  runIds?: string[];
  combineDifferentAccounts?: boolean;
  overrideContinuity?: boolean;
  confirmationText?: string;
};

function sameAccountKey(detail: NonNullable<Awaited<ReturnType<typeof getAccountingRunDetail>>>) {
  return [
    detail.run.companyName?.trim().toLowerCase() ?? "",
    detail.run.bank.trim().toLowerCase(),
    detail.run.accountNumber?.trim().toLowerCase() ?? "",
  ].join("|");
}

function sanitizeFileNamePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}

function periodToken(value: string | null | undefined) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

export async function POST(request: Request) {
  await logWorkerStartupCheck();
  const body = (await request.json().catch(() => ({}))) as CombineBody;
  const runIds = Array.from(new Set(body.runIds ?? [])).filter(Boolean);
  const wantsOverride = Boolean(body.combineDifferentAccounts || body.overrideContinuity);
  const hasConfirmation = String(body.confirmationText ?? "").trim().toUpperCase() === "COMBINE";

  if (runIds.length < 2) {
    return NextResponse.json({ error: "Select at least two completed statements to combine." }, { status: 400 });
  }

  if (wantsOverride && !hasConfirmation) {
    return NextResponse.json(
      {
        error: "Typed confirmation is required. Enter COMBINE to continue with override.",
        status: "confirmation_required",
      },
      { status: 422 },
    );
  }

  const workerUrl = getWorkerConfig().accountingWorkerUrl;
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
  const emptyStatements = validDetails.filter((detail) => (detail.transactions?.length ?? 0) === 0);
  if (emptyStatements.length) {
    return NextResponse.json(
      {
        error: "Combined export is blocked when one or more selected statements have zero extracted transactions.",
        status: "empty_statement",
      },
      { status: 409 },
    );
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const requestId = createWorkerRequestId("acct_combine");
  const workerEndpoint = buildWorkerEndpoint(workerUrl, "/combine-fnb-statements");

  let response: Response;
  try {
    console.info("docucorex.accounting.worker.request", {
      requestId,
      resolvedAccountingWorkerUrl: workerUrl,
      endpoint: workerEndpoint,
      runIdsCount: runIds.length,
      combineDifferentAccounts: Boolean(body.combineDifferentAccounts),
      overrideContinuity: Boolean(body.overrideContinuity),
    });

    response = await fetch(workerEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        workspace_id: context.workspaceId,
        run_ids: runIds,
        combine_different_accounts: Boolean(body.combineDifferentAccounts),
        override_continuity: Boolean(body.overrideContinuity),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const known = error as Error & { cause?: { code?: string } };
    const code = known.cause?.code;
    const isTimeout = known.name === "AbortError";
    const isDns = code === "ENOTFOUND" || code === "EAI_AGAIN";
    const isRefused = code === "ECONNREFUSED" || code === "ECONNRESET";
    const status = "worker_unavailable";
    const message = isTimeout
      ? "Accounting worker timed out while generating the combined workbook."
      : isDns
      ? "Accounting worker DNS lookup failed."
      : isRefused
      ? "Accounting worker is offline or refused the connection."
      : "Accounting worker is temporarily unavailable.";

    return NextResponse.json(
      {
        status,
        message,
        workerUrl,
        workerEndpoint,
        requestId,
      },
      { status: 503 },
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseBuffer = await response.arrayBuffer();
  console.info("docucorex.accounting.worker.response", {
    requestId,
    endpoint: workerEndpoint,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
  });
  if (!response.ok) {
    const text = new TextDecoder().decode(responseBuffer);
    let error = text || "Combined workbook generation failed.";
    let status = "combine_failed";
    let allowOverride = false;
    let continuity: unknown;
    try {
      const parsed = JSON.parse(text) as {
        detail?: unknown;
        error?: string;
        status?: string;
        message?: string;
        allow_override?: boolean;
        continuity?: unknown;
      };
      const detailObj = typeof parsed.detail === "object" && parsed.detail ? (parsed.detail as Record<string, unknown>) : null;
      const detailMessage = typeof parsed.detail === "string" ? parsed.detail : null;
      error =
        (typeof detailObj?.message === "string" ? detailObj.message : null) ??
        detailMessage ??
        parsed.message ??
        parsed.error ??
        JSON.stringify(parsed.detail ?? parsed);
      status =
        (typeof detailObj?.status === "string" ? detailObj.status : null) ??
        parsed.status ??
        status;
      allowOverride =
        (typeof detailObj?.allow_override === "boolean" ? detailObj.allow_override : null) ??
        Boolean(parsed.allow_override);
      continuity = detailObj?.continuity ?? parsed.continuity;
    } catch {
      // keep text body
    }
    return NextResponse.json(
      {
        error,
        status,
        allowOverride,
        continuity,
        workerStatus: response.status,
        workerUrl,
        workerEndpoint,
        requestId,
      },
      { status: response.status },
    );
  }

  const first = validDetails
    .slice()
    .sort((a, b) => String(a.run.statementPeriodStart ?? "").localeCompare(String(b.run.statementPeriodStart ?? "")))[0]?.run;
  const last = validDetails
    .slice()
    .sort((a, b) => String(a.run.statementPeriodEnd ?? "").localeCompare(String(b.run.statementPeriodEnd ?? "")))[validDetails.length - 1]?.run;
  const company = sanitizeFileNamePart(first?.companyName ?? "Unknown Company");
  const bank = sanitizeFileNamePart(first?.bank ?? "FNB");
  const startToken = periodToken(first?.statementPeriodStart);
  const endToken = periodToken(last?.statementPeriodEnd);
  const fileName = `${company} ${bank} Combined Statement ${startToken}_to_${endToken}.xlsx`;
  return new NextResponse(responseBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "X-DocuCoreX-Combined-Summary": response.headers.get("X-DocuCoreX-Combined-Summary") ?? "",
    },
  });
}
