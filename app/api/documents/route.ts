import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-auth";
import { listDocuments } from "@/lib/server-documents";

export async function GET() {
  try {
    return NextResponse.json({ documents: await listDocuments() });
  } catch (error) {
    return errorResponse(error, "Unable to load documents");
  }
}
