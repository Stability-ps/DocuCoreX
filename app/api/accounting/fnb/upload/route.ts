import { NextResponse } from "next/server";
import { createFnbAccountingRun } from "@/lib/accounting/server";
import { routeErrorResponse } from "@/lib/api-errors";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a bank statement PDF to upload." }, { status: 400 });
    }

    const run = await createFnbAccountingRun(file);
    return NextResponse.json({ run });
  } catch (error) {
    // The file checks and the sign-in requirement are UserFacingErrors and keep
    // their message and status; a Storage or database failure is logged only.
    return routeErrorResponse("docucorex.accounting.upload_failed", error, { message: "Unable to upload the statement. Please try again.", code: "UPLOAD_FAILED" });
  }
}
