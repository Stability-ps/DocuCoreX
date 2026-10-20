import { NextResponse } from "next/server";
import { getExtractionConfig, getWorkerReachability, logWorkerStartupCheck, toPublicWorkerStatus } from "@/lib/system-worker-config";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET() {
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await logWorkerStartupCheck();
  const reachability = await getWorkerReachability();

  return NextResponse.json({
    // Configured/reachable booleans only — any signed-in user can call this,
    // and sign-up is open, so worker hostnames stay in the server log.
    ...toPublicWorkerStatus(reachability),
    // Booleans only — no keys, no endpoints. Answers "is this provider usable
    // from THIS runtime", which is what was missing when Azure sat inert in
    // production with only half its configuration deployed.
    extraction: getExtractionConfig(),
  });
}
