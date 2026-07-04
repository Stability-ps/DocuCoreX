import { NextResponse } from "next/server";
import { verifyOcrRuntime } from "@/lib/document-conversion-engine";

export async function GET() {
  const ocr = verifyOcrRuntime();

  return NextResponse.json(
    {
      status: ocr.ok ? "ok" : "configuration_error",
      service: "docucorex-conversion-worker",
      ocr,
      workerMode: process.env.CONVERSION_WORKER_MODE === "true",
    },
    { status: ocr.ok ? 200 : 503 },
  );
}
