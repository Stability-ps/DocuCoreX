import { NextResponse } from "next/server";
import { documentRecords, extractionResults, ocrResults } from "@/lib/mock-repository";
import { getWorkspaceContext } from "@/lib/server-documents";

type SearchResult = {
  id: string;
  name: string;
  type: string;
  detail: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";

  if (!query) {
    return NextResponse.json({ results: [] });
  }

  const context = await getWorkspaceContext();

  if (!context) {
    const results = documentRecords
      .filter((document) => {
        const ocr = ocrResults.find((item) => item.documentId === document.id)?.text ?? "";
        const extraction = extractionResults.find((item) => item.documentId === document.id);
        const extractedText = extraction ? JSON.stringify({ fields: extraction.fields, lineItems: extraction.lineItems }) : "";
        return [document.name, document.detectedType, document.status, ...document.tags, ocr, extractedText].join(" ").toLowerCase().includes(query);
      })
      .slice(0, 8)
      .map<SearchResult>((document) => ({
        id: document.id,
        name: document.name,
        type: document.detectedType,
        detail: document.tags.join(", ") || document.status,
      }));

    return NextResponse.json({ results, mode: "demo" });
  }

  const { data: documents, error } = await context.supabase
    .from("documents")
    .select("id, name, detected_type, status, tags")
    .eq("workspace_id", context.workspaceId)
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const documentIds = (documents ?? []).map((document) => document.id);
  if (!documentIds.length) {
    return NextResponse.json({ results: [] });
  }

  const [{ data: ocrRows }, { data: extractionRows }] = await Promise.all([
    context.supabase.from("ocr_results").select("document_id, text").in("document_id", documentIds),
    context.supabase.from("extraction_results").select("document_id, fields, line_items").in("document_id", documentIds),
  ]);

  return NextResponse.json({
    results: (documents ?? [])
      .filter((document) => {
        const ocr = ocrRows?.find((item) => item.document_id === document.id)?.text ?? "";
        const extraction = extractionRows?.find((item) => item.document_id === document.id);
        const extractedText = extraction ? JSON.stringify({ fields: extraction.fields, lineItems: extraction.line_items }) : "";

        return [document.name, document.detected_type, document.status, ...(document.tags ?? []), ocr, extractedText]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 8)
      .map((document) => ({
        id: document.id,
        name: document.name,
        type: document.detected_type,
        detail: document.tags?.join(", ") || document.status,
      })),
  });
}
