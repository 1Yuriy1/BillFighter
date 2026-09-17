"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SubmitState = "idle" | "working" | "done" | "error";

interface UploadResult {
  findingsRecorded?: number;
  draftsCreated?: number;
}

const MESSAGES: Record<Exclude<SubmitState, "idle" | "working">, string> = {
  done: "Document received — extraction and analysis are running.",
  error: "The upload failed — try again, or email the document to your intake address.",
};

/**
 * The family-side document upload: picks a file and posts it to
 * POST /api/documents. With `caseId` it files into that case (the common
 * "more paperwork for the same fight" upload); with `newCase` it starts a
 * fresh case from the document. The result text reports what the analysis
 * pass actually recorded — findings and drafts render from the refreshed
 * server components, never from optimistic local state.
 */
export function UploadDocumentForm({
  caseId,
  newCase = false,
  label = "Add a document",
}: {
  caseId?: string;
  newCase?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SubmitState>("idle");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  async function upload() {
    const input = inputRef.current;
    const file = input?.files?.[0];
    if (input === null || file === undefined || state === "working") {
      return;
    }
    setState("working");
    setErrorDetail(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (caseId !== undefined) {
        form.set("caseId", caseId);
      }
      if (newCase) {
        form.set("newCase", "1");
      }
      const response = await fetch("/api/documents", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { code?: string } | null;
        setErrorDetail(body?.code ?? null);
        setState("error");
        return;
      }
      const body = (await response.json()) as { analysis?: UploadResult | null };
      setResult({
        findingsRecorded: body.analysis?.findingsRecorded ?? undefined,
        draftsCreated: body.analysis?.draftsCreated ?? undefined,
      });
      input.value = "";
      setState("done");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void upload();
      }}
    >
      <label className="text-sm font-medium text-slate-700" htmlFor={`upload-${caseId ?? "new"}`}>
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={`upload-${caseId ?? "new"}`}
          type="file"
          data-testid="upload-input"
          className="text-sm text-slate-700"
          disabled={state === "working"}
        />
        <button
          type="submit"
          disabled={state === "working"}
          data-testid="upload-submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {state === "working" ? "Uploading…" : "Upload"}
        </button>
      </div>
      {state === "done" ? (
        <p className="text-sm font-medium text-green-700" role="status" data-testid="upload-result">
          {result?.findingsRecorded !== undefined && result.findingsRecorded > 0
            ? `Document received — ${result.findingsRecorded} finding${
                result.findingsRecorded === 1 ? "" : "s"
              } recorded${
                result?.draftsCreated
                  ? `, ${result.draftsCreated} letter draft${
                      result.draftsCreated === 1 ? "" : "s"
                    } queued for review below`
                  : ""
              }.`
            : MESSAGES.done}
        </p>
      ) : null}
      {state === "error" ? (
        <p className="text-sm text-red-700" role="alert" data-testid="upload-error">
          {MESSAGES.error}
          {errorDetail !== null ? ` (${errorDetail})` : ""}
        </p>
      ) : null}
    </form>
  );
}
