"use client";

import { useState, useCallback, type DragEvent, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

export function UploadForm() {
  const router = useRouter();
  const [failingFile, setFailingFile] = useState<File | null>(null);
  const [passingFile, setPassingFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!failingFile) return;
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("failing", failingFile);
      if (passingFile) {
        formData.append("passing", passingFile);
      }

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(body.error ?? "Upload failed");
      }

      const { id } = await res.json();
      router.push(`/results/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <DropZone
        label="Failing report"
        sublabel="Required — Playwright JSON report file"
        file={failingFile}
        onFile={setFailingFile}
        required
      />
      <DropZone
        label="Passing report"
        sublabel="Optional — for comparison"
        file={passingFile}
        onFile={setPassingFile}
      />

      {error && (
        <p className="rounded-md bg-red-900/30 px-4 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!failingFile || loading}
        className="rounded-lg bg-emerald-600 px-6 py-3 font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? "Processing..." : "Analyze"}
      </button>
    </div>
  );
}

function DropZone({
  label,
  sublabel,
  file,
  onFile,
  required,
}: {
  label: string;
  sublabel: string;
  file: File | null;
  onFile: (f: File | null) => void;
  required?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const dropped = e.dataTransfer.files[0];
      if (dropped) onFile(dropped);
    },
    [onFile]
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected) onFile(selected);
    },
    [onFile]
  );

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
        dragOver
          ? "border-emerald-500 bg-emerald-500/10"
          : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
      }`}
    >
      <span className="text-base font-medium">
        {label}
        {required && <span className="ml-1 text-red-400">*</span>}
      </span>
      <span className="text-sm text-zinc-500">{sublabel}</span>

      {file ? (
        <span className="mt-2 text-sm text-emerald-400">{file.name}</span>
      ) : (
        <span className="mt-2 text-sm text-zinc-600">
          Drop a file here or click to browse
        </span>
      )}

      <input
        type="file"
        accept=".json"
        onChange={handleChange}
        className="hidden"
      />
    </label>
  );
}
