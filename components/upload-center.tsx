"use client";

import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { CheckCircle2, File, Pause, RefreshCcw, Trash2, UploadCloud, XCircle } from "lucide-react";
import { uploadTypes } from "@/lib/product-data";
import { supabase } from "@/lib/supabase";

type UploadItem = {
  id: string;
  name: string;
  type: string;
  size: string;
  progress: number;
  status: "Uploading" | "Processing" | "Complete" | "Paused" | "Failed";
  file?: File;
};

type PreparedUpload = {
  file: File;
  storagePath?: string;
  mode?: string;
};

const seedUploads: UploadItem[] = [];

export function UploadCenter({ workflow }: { workflow?: string }) {
  const [uploads, setUploads] = useState(seedUploads);
  const [sessionLabel, setSessionLabel] = useState("Ready to upload");
  const [signedUploadLabel, setSignedUploadLabel] = useState("Signed upload ready");
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const totalProgress = useMemo(
    () => (uploads.length ? Math.round(uploads.reduce((sum, upload) => sum + upload.progress, 0) / uploads.length) : 0),
    [uploads],
  );

  function formatBytes(bytes: number) {
    if (!bytes) return "0 MB";
    const mb = bytes / 1024 / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  function addUploadItems(files: FileList | File[]) {
    const items = Array.from(files);
    if (!items.length) return;

    const pendingUploads = items.map((file, index) => ({
      id: `${Date.now()}_${index}`,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: formatBytes(file.size),
      progress: 12,
      status: "Uploading" as const,
      file,
    }));

    setUploads((current) => [...pendingUploads, ...current]);

    void (async () => {
      const preparedUploads: PreparedUpload[] = [];

      for (const [index, file] of items.entries()) {
        const signedUrlResponse = await fetch("/api/uploads/signed-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream" }),
        }).catch(() => null);

        if (!signedUrlResponse?.ok) {
          setUploads((current) => current.map((item) => (item.id === pendingUploads[index].id ? { ...item, progress: 100, status: "Failed" } : item)));
          continue;
        }

        const signedData = (await signedUrlResponse.json().catch(() => null)) as {
          bucket?: string;
          path?: string;
          token?: string;
          mode?: string;
        } | null;

        if (signedData?.path) {
          setSignedUploadLabel(`${signedData.mode === "demo" ? "Demo" : "Signed"} path: ${signedData.path.split("/").pop()}`);
        }

        if (signedData?.mode !== "demo" && signedData?.bucket && signedData.path && signedData.token && supabase) {
          const { error } = await supabase.storage.from(signedData.bucket).uploadToSignedUrl(signedData.path, signedData.token, file, {
            contentType: file.type || "application/octet-stream",
            upsert: true,
          });

          if (error) {
            setUploads((current) => current.map((item) => (item.id === pendingUploads[index].id ? { ...item, progress: 100, status: "Failed" } : item)));
            continue;
          }
        }

        setUploads((current) => current.map((item) => (item.id === pendingUploads[index].id ? { ...item, progress: 70, status: "Processing" } : item)));
        preparedUploads.push({ file, storagePath: signedData?.path, mode: signedData?.mode });
      }

      if (!preparedUploads.length) {
        setSessionLabel("No files could be uploaded");
        return;
      }

      const response = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: preparedUploads.map(({ file, storagePath }) => ({
            name: file.name,
            size: file.size,
            type: file.type || "application/octet-stream",
            storagePath,
          })),
        }),
      }).catch(() => null);

      if (!response?.ok) {
        setSessionLabel("Upload registration failed");
        setUploads((current) =>
          current.map((item) => (pendingUploads.some((upload) => upload.id === item.id) ? { ...item, progress: 100, status: "Failed" } : item)),
        );
        return;
      }

      const data = (await response.json().catch(() => null)) as {
        uploadSessionId?: string;
        accepted?: Array<{ id: string; name: string; size: number; mimeType: string; storagePath?: string }>;
      } | null;

      setSessionLabel(data?.uploadSessionId ?? "Upload queued");

      setUploads((current) =>
        current.map((item) => {
          const acceptedIndex = pendingUploads.findIndex((upload) => upload.id === item.id);
          const accepted = data?.accepted?.[acceptedIndex];

          if (acceptedIndex === -1) {
            return item;
          }

          return {
            ...item,
            id: accepted?.id ?? item.id,
            progress: 100,
            status: "Complete",
            file: undefined,
          };
        }),
      );
    })();
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files?.length) {
      addUploadItems(event.target.files);
      event.target.value = "";
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files?.length) {
      addUploadItems(event.dataTransfer.files);
    }
  }

  function cancelUpload(id: string) {
    setUploads((current) => current.filter((upload) => upload.id !== id));
  }

  function retryUpload(id: string) {
    const upload = uploads.find((item) => item.id === id);
    if (!upload?.file) {
      setUploads((current) => current.map((item) => (item.id === id ? { ...item, status: "Failed" } : item)));
      setSessionLabel("Choose the file again to retry this completed upload");
      return;
    }
    setUploads((current) => current.filter((item) => item.id !== id));
    addUploadItems([upload.file]);
  }

  return (
    <div className="space-y-6">
      <section
        className={`rounded-[2rem] border-2 border-dashed p-6 shadow-sm sm:p-10 ${dragActive ? "border-royal-600 bg-royal-50" : "border-royal-200 bg-white"}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-royal-50 text-royal-600">
            <UploadCloud className="h-8 w-8" />
          </div>
          <h2 className="mt-5 text-2xl font-black text-navy-950">Drag and drop files to upload</h2>
          {workflow ? <p className="mt-2 text-sm font-black text-royal-700">Selected workflow: {workflow.replace(/_/g, " ")}</p> : null}
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Multi-file uploads support PDF, Word, Excel, images and ZIP files. Uploads continue in the background with progress,
            retry and cancel controls.
          </p>
          <input
            ref={inputRef}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.zip"
            className="hidden"
            type="file"
            multiple
            onChange={handleInputChange}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-label="Choose files to upload"
            className="mt-6 rounded-full bg-royal-600 px-6 py-3 text-sm font-black text-white shadow-glow transition hover:-translate-y-0.5 hover:bg-royal-700"
          >
            Choose Files
          </button>
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-5">
          {uploadTypes.map((type) => (
            <div key={type.label} className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm font-black text-slate-600">
              <type.icon className="h-4 w-4 text-royal-600" />
              {type.label}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-black text-navy-950">Upload Queue</h2>
            <p className="mt-1 text-sm text-slate-500">Chunked uploads, background processing and resumable retries. {signedUploadLabel}</p>
          </div>
          <div className="rounded-full bg-slate-100 px-4 py-2 text-sm font-black text-slate-600">
            {totalProgress}% overall • {sessionLabel}
          </div>
        </div>
        <div className="space-y-3">
          {!uploads.length ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
              <p className="font-black text-navy-950">No files in the queue</p>
              <p className="mt-1 text-sm text-slate-500">Choose files or drag them into the upload area to start processing.</p>
            </div>
          ) : null}
          {uploads.map((upload) => (
            <div key={upload.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div className="rounded-2xl bg-white p-3 text-royal-600 shadow-sm">
                    <File className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-black text-navy-950">{upload.name}</p>
                    <p className="text-sm text-slate-500">
                      {upload.type} • {upload.size} • {upload.status}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => retryUpload(upload.id)}
                    disabled={upload.status !== "Failed" || !upload.file}
                    aria-label={`Retry upload for ${upload.name}`}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-royal-700 disabled:cursor-not-allowed disabled:opacity-40"
                    title={upload.file ? "Retry upload" : "Choose the file again to retry"}
                  >
                    <RefreshCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled
                    aria-label={`Pause upload for ${upload.name}`}
                    className="rounded-xl bg-white p-2 text-slate-500 opacity-40 shadow-sm"
                    title="Pause and resume are coming soon"
                  >
                    <Pause className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => cancelUpload(upload.id)}
                    aria-label={`Cancel upload for ${upload.name}`}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-rose-600"
                    title="Cancel upload"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-royal-600" style={{ width: `${upload.progress}%` }} />
                </div>
                <div className="flex w-24 items-center justify-end gap-1 text-xs font-black text-slate-500">
                  {upload.status === "Complete" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-amber-500" />}
                  {upload.progress}%
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
