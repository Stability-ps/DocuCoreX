import { randomUUID } from "node:crypto";
import { isAuthRequired, isDemoAllowed } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createDocumentVersionRecord, createWorkspaceBucketPath } from "@/lib/supabase-server-adapter";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";
import {
  createProcessingJob,
  deleteDocumentRecord,
  documentVersions,
  documentRecords,
  extractionResults,
  getDocument,
  getDocumentVersions,
  ocrResults,
  processingJobs,
  updateDocument,
  usageSummary,
} from "@/lib/mock-repository";
import type { DocumentRecord, DocumentStatus, DocumentType } from "@/lib/types";

type SupabaseServer = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

type WorkspaceContext = {
  supabase: SupabaseServer;
  userId: string;
  workspaceId: string;
};

type DocumentRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  folder_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  status: DocumentStatus;
  detected_type: DocumentType;
  storage_path: string;
  tags: string[] | null;
  starred: boolean | null;
  shared: boolean | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type UploadFileInput = {
  name: string;
  size: number;
  type: string;
  storagePath?: string;
};

type DocumentPatch = Partial<Pick<DocumentRecord, "starred" | "shared" | "tags" | "status" | "deletedAt" | "folderId">>;

function mapDocumentRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    folderId: row.folder_id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    status: row.status,
    detectedType: row.detected_type,
    storagePath: row.storage_path,
    tags: row.tags ?? [],
    starred: Boolean(row.starred),
    shared: Boolean(row.shared),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPatchRow(patch: DocumentPatch) {
  return {
    ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
    ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.deletedAt !== undefined ? { deleted_at: patch.deletedAt } : {}),
    ...(patch.folderId !== undefined ? { folder_id: patch.folderId } : {}),
    updated_at: new Date().toISOString(),
  };
}

function getStoragePath(workspaceId: string, fileName: string) {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${workspaceId}/documents/${randomUUID()}-${safeFileName}`;
}

function getMimeType(file: UploadFileInput) {
  if (file.type) {
    return file.type;
  }

  if (file.name.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }

  return "application/octet-stream";
}

const maxUploadBytes = 100 * 1024 * 1024;
const allowedExtensions = /\.(pdf|doc|docx|xls|xlsx|csv|png|jpe?g|webp|zip)$/i;
const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/zip",
  "application/x-zip-compressed",
]);

function validateUploadFiles(files: UploadFileInput[]) {
  if (!files.length) {
    throw new Error("At least one file is required.");
  }

  for (const file of files) {
    const mimeType = getMimeType(file);

    if (!file.name || !allowedExtensions.test(file.name)) {
      throw new Error(`${file.name || "File"} is not a supported file type.`);
    }

    if (file.size <= 0) {
      throw new Error(`${file.name} is empty.`);
    }

    if (file.size > maxUploadBytes) {
      throw new Error(`${file.name} is larger than the 100 MB upload limit.`);
    }

    if (mimeType !== "application/octet-stream" && !allowedMimeTypes.has(mimeType)) {
      throw new Error(`${file.name} has an unsupported MIME type.`);
    }
  }
}

function detectDocumentType(fileName: string, mimeType: string): DocumentType {
  const normalized = `${fileName} ${mimeType}`.toLowerCase();

  if (normalized.includes("statement")) return "bank_statement";
  if (normalized.includes("invoice")) return "invoice";
  if (normalized.includes("receipt")) return "receipt";
  if (normalized.includes("financial")) return "financial_statement";
  if (normalized.includes("contract")) return "contract";
  if (normalized.includes("payslip")) return "payslip";
  if (normalized.includes("tax")) return "tax_document";
  if (normalized.includes("purchase") || normalized.includes("po-")) return "purchase_order";

  return "unknown";
}

function estimatePageCount(fileName: string, mimeType: string) {
  const normalized = `${fileName} ${mimeType}`.toLowerCase();

  if (normalized.includes("zip")) return 0;
  if (normalized.includes("image") || /\.(png|jpe?g|webp)$/i.test(fileName)) return 1;
  if (normalized.includes("spreadsheet") || /\.(xls|xlsx|csv)$/i.test(fileName)) return 1;
  if (normalized.includes("word") || /\.(doc|docx)$/i.test(fileName)) return 3;

  return 1;
}

export async function getWorkspaceContext(): Promise<WorkspaceContext | null> {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    if (isDemoAllowed) {
      return null;
    }

    throw new Error("Supabase is not configured");
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    if (isAuthRequired || !isDemoAllowed) {
      throw new Error("Unauthorized");
    }

    return null;
  }

  let { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("workspace_id")
    .eq("id", user.id)
    .single();

  if (profileError || !profile?.workspace_id) {
    const bootstrapped = await ensureUserWorkspace(user);

    if (bootstrapped?.profile.workspace_id) {
      profile = { workspace_id: bootstrapped.profile.workspace_id };
      profileError = null;
    }
  }

  if (profileError || !profile?.workspace_id) {
    if (isDemoAllowed) {
      return null;
    }

    throw new Error("Your workspace is not ready yet. Please refresh or contact support if this continues.");
  }

  return {
    supabase,
    userId: user.id,
    workspaceId: profile.workspace_id,
  };
}

export async function listDocuments() {
  const context = await getWorkspaceContext();

  if (!context) {
    return documentRecords;
  }

  const { data, error } = await context.supabase
    .from("documents")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data as DocumentRow[]).map(mapDocumentRow);
}

export async function getDocumentWithJobs(id: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    const document = getDocument(id);
    return document ? { document, jobs: processingJobs.filter((job) => job.documentId === id) } : null;
  }

  const { data: documentData, error: documentError } = await context.supabase
    .from("documents")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .single();

  if (documentError || !documentData) {
    return null;
  }

  const { data: jobsData, error: jobsError } = await context.supabase
    .from("processing_jobs")
    .select("id, document_id, type, status, progress, message, created_at, updated_at")
    .eq("document_id", id)
    .order("created_at", { ascending: false });

  if (jobsError) {
    throw new Error(jobsError.message);
  }

  return {
    document: mapDocumentRow(documentData as DocumentRow),
    jobs: (jobsData ?? []).map((job) => ({
      id: job.id,
      documentId: job.document_id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      message: job.message,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })),
  };
}

export async function patchDocument(id: string, patch: DocumentPatch) {
  const context = await getWorkspaceContext();

  if (!context) {
    return updateDocument(id, patch);
  }

  const { data, error } = await context.supabase
    .from("documents")
    .update(toPatchRow(patch))
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !data) {
    return null;
  }

  return mapDocumentRow(data as DocumentRow);
}

export async function deleteDocument(id: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    return deleteDocumentRecord(id);
  }

  const { error } = await context.supabase
    .from("documents")
    .delete()
    .eq("workspace_id", context.workspaceId)
    .eq("id", id);

  return !error;
}

export async function registerUploads(files: UploadFileInput[]) {
  validateUploadFiles(files);

  const context = await getWorkspaceContext();
  const uploadSessionId = `upload_${Date.now()}`;

  if (!context) {
    const uploadedAt = new Date().toISOString();
    const accepted = files.map((file, index) => {
      const mimeType = getMimeType(file);
      const documentId = `${uploadSessionId}_${index}`;
      const storagePath = file.storagePath ?? getStoragePath("workspace_demo", file.name);
      const document: DocumentRecord = {
        id: documentId,
        workspaceId: "workspace_demo",
        ownerId: "user_demo",
        folderId: null,
        name: file.name,
        mimeType,
        sizeBytes: file.size,
        pageCount: estimatePageCount(file.name, mimeType),
        status: "uploaded",
        detectedType: detectDocumentType(file.name, mimeType),
        storagePath,
        tags: ["Uploaded"],
        starred: false,
        shared: false,
        deletedAt: null,
        createdAt: uploadedAt,
        updatedAt: uploadedAt,
      };
      const job = {
        ...createProcessingJob(documentId, "upload", "Upload registered"),
        status: "queued" as const,
        progress: 0,
        updatedAt: uploadedAt,
      };

      documentRecords.unshift(document);
      processingJobs.unshift(job);
      documentVersions.unshift({
        id: `version_${documentId}_1`,
        documentId,
        versionNumber: 1,
        storagePath,
        changeNote: "Original upload",
        createdBy: "Patric",
        createdAt: uploadedAt,
      });

      usageSummary.documentsUploaded += 1;
      usageSummary.pagesProcessed += document.pageCount;
      usageSummary.storageBytes += document.sizeBytes;
      usageSummary.ocrCreditsUsed += document.pageCount;
      usageSummary.ocrCreditsRemaining = Math.max(0, usageSummary.ocrCreditsRemaining - document.pageCount);

      return {
        id: document.id,
        name: document.name,
        size: document.sizeBytes,
        mimeType: document.mimeType,
        status: document.status,
        storagePath: document.storagePath,
        job,
        index,
      };
    });

    return {
      uploadSessionId,
      accepted,
    };
  }

  const documentsToInsert = files.map((file) => ({
    workspace_id: context.workspaceId,
    owner_id: context.userId,
    name: file.name,
    mime_type: getMimeType(file),
    size_bytes: file.size,
    page_count: 0,
    status: "uploaded" as const,
    detected_type: "unknown" as const,
    storage_path: file.storagePath ?? getStoragePath(context.workspaceId, file.name),
    tags: [],
  }));

  const { data: insertedDocuments, error: documentError } = await context.supabase
    .from("documents")
    .insert(documentsToInsert)
    .select("*");

  if (documentError) {
    throw new Error(documentError.message);
  }

  const jobsToInsert = (insertedDocuments as DocumentRow[]).map((document) => ({
    document_id: document.id,
    type: "upload" as const,
    status: "queued" as const,
    progress: 0,
    message: "Upload queued",
  }));

  const { data: insertedJobs, error: jobsError } = await context.supabase
    .from("processing_jobs")
    .insert(jobsToInsert)
    .select("id, document_id, type, status, progress, message, created_at, updated_at");

  if (jobsError) {
    throw new Error(jobsError.message);
  }

  await context.supabase.from("uploads").insert(
    (insertedDocuments as DocumentRow[]).map((document) => ({
      workspace_id: context.workspaceId,
      document_id: document.id,
      file_name: document.name,
      mime_type: document.mime_type,
      size_bytes: document.size_bytes,
      storage_path: document.storage_path,
      status: "completed",
      created_by: context.userId,
    })),
  );

  await Promise.all(
    (insertedDocuments as DocumentRow[]).map((document) =>
      createDocumentVersionRecord(document.id, document.storage_path, "Original upload created"),
    ),
  );

  return {
    uploadSessionId,
    accepted: (insertedDocuments as DocumentRow[]).map((document, index) => {
      const job = insertedJobs?.find((item) => item.document_id === document.id);

      return {
        id: document.id,
        name: document.name,
        size: document.size_bytes,
        mimeType: document.mime_type,
        status: document.status,
        storagePath: document.storage_path,
        job: job
          ? {
              id: job.id,
              documentId: job.document_id,
              type: job.type,
              status: job.status,
              progress: job.progress,
              message: job.message,
              createdAt: job.created_at,
              updatedAt: job.updated_at,
            }
          : createProcessingJob(document.id, "upload", "Upload queued"),
        index,
      };
    }),
  };
}

export async function getDocumentVersionsForWorkspace(documentId: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    return getDocumentVersions(documentId);
  }

  const { data, error } = await context.supabase
    .from("document_versions")
    .select("id, document_id, version_number, storage_path, change_note, created_by, created_at")
    .eq("document_id", documentId)
    .order("version_number", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((version) => ({
    id: version.id,
    documentId: version.document_id,
    versionNumber: version.version_number,
    storagePath: version.storage_path,
    changeNote: version.change_note ?? "Document version saved",
    createdBy: version.created_by ?? "System",
    createdAt: version.created_at,
  }));
}

export async function getOcrForWorkspace(documentId: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    return ocrResults.find((ocr) => ocr.documentId === documentId) ?? null;
  }

  const { data, error } = await context.supabase
    .from("ocr_results")
    .select("id, document_id, language, confidence, text, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data
    ? {
        id: data.id,
        documentId: data.document_id,
        language: data.language,
        confidence: Number(data.confidence),
        text: data.text,
        layoutStatus: "complete" as const,
        createdAt: data.created_at,
      }
    : null;
}

export async function getExtractionForWorkspace(documentId: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    return extractionResults.find((extraction) => extraction.documentId === documentId) ?? null;
  }

  const { data, error } = await context.supabase
    .from("extraction_results")
    .select("id, document_id, detected_type, confidence, fields, line_items, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data
    ? {
        id: data.id,
        documentId: data.document_id,
        detectedType: data.detected_type,
        confidence: Number(data.confidence),
        fields: data.fields ?? {},
        lineItems: data.line_items ?? [],
        createdAt: data.created_at,
      }
    : null;
}
