import { NextResponse } from "next/server";
import { deleteAccountingRuns, getAccountingRunDetail, getRunTransactionTags, getWorkspaceTagVocabulary } from "@/lib/accounting/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const detail = await getAccountingRunDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    // Tags travel with the run so the workspace renders in one round trip.
    // They are a separate concern from the transactions themselves — a tag read
    // that fails (migration 031 not applied) returns {} and the statement still
    // loads, rather than a tagging feature being able to blank a ledger.
    const [tags, tagVocabulary] = await Promise.all([getRunTransactionTags(id), getWorkspaceTagVocabulary()]);
    return NextResponse.json({ ...detail, tags, tagVocabulary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load accounting run.";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const result = await deleteAccountingRuns([id]);
    if (!result.deletedIds.length) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete accounting run.";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}
