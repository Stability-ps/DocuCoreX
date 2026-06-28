import { NextResponse } from "next/server";
import { answerAiPrompt, getAiInsights } from "@/lib/mock-repository";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ insights: getAiInsights(documentId), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("ai_insights")
    .select("id, document_id, prompt, answer, confidence, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    insights: (data ?? []).map((insight) => ({
      id: insight.id,
      documentId: insight.document_id,
      prompt: insight.prompt,
      answer: insight.answer,
      confidence: Number(insight.confidence),
      createdAt: insight.created_at,
    })),
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const body = (await request.json().catch(() => ({}))) as { prompt?: string };

  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ insight: answerAiPrompt(documentId, body.prompt.trim()), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("ai_insights")
    .insert({ document_id: documentId, prompt: body.prompt.trim(), answer: "Temporary AI adapter response. Connect a production model to replace this placeholder.", confidence: 87.5 })
    .select("id, document_id, prompt, answer, confidence, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    insight: {
      id: data.id,
      documentId: data.document_id,
      prompt: data.prompt,
      answer: data.answer,
      confidence: Number(data.confidence),
      createdAt: data.created_at,
    },
  });
}
