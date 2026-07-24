"use client";

import { useRef, useState, type DragEvent } from "react";
import { CheckCircle2, Loader2, UploadCloud, X } from "lucide-react";

const SUPPORTED_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".rtf",
  ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif", ".heic", ".zip",
];

type UploadItem = {
  key: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "failed";
  error?: string;
};

function isSupported(file: File): boolean {
  const lower = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The single upload area at the top of the documents workspace. Uploads each
 * file to the existing POST /api/uploads endpoint, then triggers the job
 * processor. Calls onUploaded() after each successful upload so the parent can
 * refresh the document list.
 */
export function DocumentUploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const [dragActive, setDragActive] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function uploadFile(file: File) {
    const key = `${Date.now()}-${file.name}-${Math.round(file.size)}`;

    if (!isSupported(file)) {
      setUploads((current) => [
        { key, name: file.name, progress: 100, status: "failed", error: "Unsupported file type" },
        ...current,
      ]);
      return;
    }

    setUploads((current) => [{ key, name: file.name, progress: 0, status: "uploading" }, ...current]);

    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file, file.name);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      setUploads((current) => current.map((item) => (item.key === key ? { ...item, progress } : item)));
    };

    xhr.onload = () => {
      let ok = xhr.status >= 200 && xhr.status < 300;
      let errorMessage = "Upload failed";
      let acceptedIds: string[] = [];
      try {
        const data = JSON.parse(xhr.responseText || "{}") as { accepted?: Array<{ id?: string }>; error?: string };
        if (!data.accepted?.length) {
          ok = false;
          errorMessage = data.error ?? errorMessage;
        } else {
          acceptedIds = data.accepted.map((entry) => entry.id).filter((id): id is string => Boolean(id));
        }
      } catch {
        ok = false;
      }

      setUploads((current) =>
        current.map((item) =>
          item.key === key
            ? { ...item, progress: 100, status: ok ? "done" : "failed", error: ok ? undefined : errorMessage }
            : item,
        ),
      );

      if (!ok) return;

      // Start processing for each concrete document so the worker can resolve its
      // workspace (via service role) for THAT document. We never fire a
      // context-less "process everything" call. If processing can't be started,
      // surface it on the upload row instead of leaving the document queued.
      const failRow = (message: string) => {
        setUploads((current) =>
          current.map((item) => (item.key === key ? { ...item, status: "failed", error: message } : item)),
        );
        onUploaded();
      };

      void (async () => {
        try {
          const responses = await Promise.all(
            acceptedIds.map((documentId) =>
              fetch("/api/jobs/process", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ documentId }),
              }),
            ),
          );
          const failed = responses.find((response) => !response.ok);
          if (failed) {
            const data = (await failed.json().catch(() => null)) as { error?: string } | null;
            failRow(data?.error ?? "Processing could not be started.");
            return;
          }
        } catch {
          failRow("Processing could not be started.");
          return;
        }

        onUploaded();
        // Clear the completed row after a short delay.
        window.setTimeout(() => {
          setUploads((current) => current.filter((item) => item.key !== key));
        }, 2500);
      })();
    };

    xhr.onerror = () => {
      setUploads((current) =>
        current.map((item) =>
          item.key === key ? { ...item, status: "failed", progress: 100, error: "Network error" } : item,
        ),
      );
    };

    xhr.open("POST", "/api/uploads");
    xhr.send(formData);
  }

  function addFiles(files: FileList | File[]) {
    Array.from(files).forEach(uploadFile);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click();
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition sm:py-10 ${
          dragActive ? "border-royal-400 bg-royal-50" : "border-slate-300 bg-slate-50/60 hover:border-royal-300 hover:bg-royal-50/40"
        }`}
      >
        <span className="rounded-full bg-royal-100 p-3 text-royal-600">
          <UploadCloud className="h-6 w-6" />
        </span>
        <p className="text-sm font-bold text-navy-950">
          Drop files here or <span className="text-royal-700">browse</span>
        </p>
        <p className="text-xs font-semibold text-slate-500">
          PDF, Word, Excel, PowerPoint, images and ZIP · up to 200&nbsp;MB each
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={SUPPORTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {uploads.length ? (
        <ul className="mt-3 space-y-2">
          {uploads.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2"
            >
              <span className="shrink-0">
                {item.status === "uploading" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-royal-600" />
                ) : item.status === "done" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <X className="h-4 w-4 text-rose-600" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-navy-950">{item.name}</p>
                {item.status === "uploading" ? (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-royal-500 transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                ) : (
                  <p className={`text-[11px] font-semibold ${item.status === "done" ? "text-emerald-600" : "text-rose-600"}`}>
                    {item.status === "done" ? "Uploaded" : item.error ?? "Failed"}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
