import { NextResponse } from "next/server";
import { listDocuments } from "@/lib/server-documents";

export async function GET() {
  try {
    return NextResponse.json({ documents: await listDocuments() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load documents" }, { status: 500 });
  }
}
