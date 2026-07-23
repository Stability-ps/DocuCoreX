import { NextResponse } from "next/server";
import { verifyConversionRuntime, verifyOcrRuntime } from "@/lib/document-conversion-engine";

export async function GET() {
  const ocr = verifyOcrRuntime();
  const conversion = verifyConversionRuntime();
  const ok = ocr.ok && conversion.ok;

  return NextResponse.json(
    {
      status: ok ? "ok" : "configuration_error",
      service: "docucorex-conversion-worker",
      ocr,
      conversion,
      workerMode: process.env.CONVERSION_WORKER_MODE === "true",
    },
    { status: ok ? 200 : 503 },
  );
}
