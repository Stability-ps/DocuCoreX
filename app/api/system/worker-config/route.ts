import { NextResponse } from "next/server";
import { getWorkerConfig, getWorkerReachability, logWorkerStartupCheck } from "@/lib/system-worker-config";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET() {
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await logWorkerStartupCheck();
  const config = getWorkerConfig();
  const reachability = await getWorkerReachability();

  return NextResponse.json({
    environment: config.environment,
    workerConfiguration: {
      accountingWorkerUrl: config.accountingWorkerUrl,
      conversionWorkerUrl: config.conversionWorkerUrl,
      pdfPlumberUrl: config.pdfPlumberUrl,
    },
    reachability: {
      accountingWorker: reachability.accountingWorker,
      conversionWorker: reachability.conversionWorker,
      pdfPlumber: reachability.pdfPlumber,
    },
  });
}
