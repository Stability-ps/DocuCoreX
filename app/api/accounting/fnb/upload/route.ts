import { NextResponse } from "next/server";
import { createFnbAccountingRun } from "@/lib/accounting/server";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose an FNB bank statement PDF to upload." }, { status: 400 });
    }

    const run = await createFnbAccountingRun(file);
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload FNB statement.";
    const status = message === "Unauthorized" || message.includes("Sign in") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
