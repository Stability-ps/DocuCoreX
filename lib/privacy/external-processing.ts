// Whether a workspace's documents may be sent to external AI providers
// (migration 051, docs/EXTERNAL_DATA_FLOWS.md).
//
// "External" means a third party outside DocuCoreX's own infrastructure: Azure
// Document Intelligence, Mistral OCR and OpenAI. The conversion worker's
// Tesseract/OCRmyPDF and the pdfplumber service are DocuCoreX's own and are
// never affected.
//
// Read once per job by whoever starts the work, then passed down explicitly:
// runExtractionPipeline, extractDocument and createWorkflowAdapters all take
// the decision as a required argument, so a new call site cannot forget it.

export type ExternalProcessingSource =
  // The workspace owner chose.
  | "setting"
  // No choice recorded: the behaviour every workspace has always had.
  | "default"
  // Migration 051 is not applied, so no workspace can have chosen yet.
  | "not_migrated"
  // The setting could not be read. Fails closed.
  | "error"
  // No Supabase backend at all (local demo): there is no customer data.
  | "demo";

export type ExternalProcessing = { allowed: boolean; source: ExternalProcessingSource };

export const EXTERNAL_PROCESSING_DEMO: ExternalProcessing = { allowed: true, source: "demo" };

type QueryError = { code?: string; message?: string } | null;

type SettingsReader = {
  from: (table: "workspace_privacy_settings") => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{ data: { external_ai_processing?: unknown } | null; error: QueryError }>;
      };
    };
  };
};

// PostgREST reports a missing table as PGRST205 (schema cache) and Postgres as 42P01.
const TABLE_MISSING = new Set(["PGRST205", "42P01"]);

// Accepts any Supabase client: matching the full generated client type against
// SettingsReader structurally is "excessively deep" for the compiler.
export async function getExternalProcessing(supabase: { from: (table: never) => unknown }, workspaceId: string): Promise<ExternalProcessing> {
  const db = supabase as unknown as SettingsReader;
  try {
    const { data, error } = await db
      .from("workspace_privacy_settings")
      .select("external_ai_processing")
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (error) {
      if (error.code && TABLE_MISSING.has(error.code)) return { allowed: true, source: "not_migrated" };
      console.error("docucorex.privacy.external_processing_unreadable", { workspaceId, code: error.code ?? null });
      return { allowed: false, source: "error" };
    }
    if (!data) return { allowed: true, source: "default" };
    if (data.external_ai_processing === "blocked") return { allowed: false, source: "setting" };
    if (data.external_ai_processing === "allowed") return { allowed: true, source: "setting" };
    // A value the check constraint should have made impossible: fail closed.
    return { allowed: false, source: "error" };
  } catch (error) {
    console.error("docucorex.privacy.external_processing_unreadable", { workspaceId, code: error instanceof Error ? error.name : "unknown" });
    return { allowed: false, source: "error" };
  }
}

/** The reason recorded in diagnostics when an external engine is skipped for privacy. */
export const BLOCKED_BY_WORKSPACE = "blocked by the workspace's external AI processing setting";
