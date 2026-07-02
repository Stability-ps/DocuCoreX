import { NextResponse } from "next/server";
import { listRegisteredParsers } from "@/lib/accounting/engine/registry";

export async function GET() {
  return NextResponse.json({ parsers: listRegisteredParsers() });
}
