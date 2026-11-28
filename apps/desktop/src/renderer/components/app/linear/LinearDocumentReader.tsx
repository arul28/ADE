import React, { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, FileText, X } from "@phosphor-icons/react";
import type { CtoLinearDocument, OpenProjectBinding } from "../../../../shared/types";
import { IssueMarkdown } from "../../issues/issueMarkdown";
import { resolveLinearProjectIcon } from "../../lanes/linearProjectIcon";
import { cn } from "../../ui/cn";
import { openExternalUrl } from "./adeStatus";

/**
 * A Linear document in the right pane: its title, project and last change,
 * the markdown body, and a way out to Linear. Read through the Linear
 * machine's pin; a response for a document the pane has already moved past
 * is dropped.
 */

type ReaderState =
  | { status: "loading" }
  | { status: "ready"; document: CtoLinearDocument }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "unsupported" };

function formatUpdated(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Updated ${new Intl.DateTimeFormat(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

function DocumentGlyph({ document, size = 18 }: { document: CtoLinearDocument | null; size?: number }) {
  const glyph = resolveLinearProjectIcon(document?.icon ?? null);
  if (glyph) return <span className="leading-none" style={{ fontSize: size - 2 }} aria-hidden>{glyph}</span>;
  return <FileText size={size} aria-hidden style={document?.color ? { color: document.color } : undefined} className="text-muted-fg/70" />;
}

function Skeleton() {
  return (
    <div className="space-y-3 px-6 py-5" aria-busy="true" aria-label="Loading document">
      <div className="h-5 w-2/3 rounded bg-fg/[0.06] motion-safe:animate-pulse" />
      <div className="h-3 w-1/3 rounded bg-fg/[0.05] motion-safe:animate-pulse" />
      <div className="pt-3" />
      {[92, 88, 95, 60, 84, 72].map((width, index) => (
        <div key={index} className="h-3 rounded bg-fg/[0.045] motion-safe:animate-pulse" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function LinearDocumentReader({
  pin,
  documentId,
  onClose,
}: {
  pin: OpenProjectBinding | null;
  documentId: string;
  onClose: () => void;
}): JSX.Element {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [state, setState] = useState<ReaderState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const read = window.ade?.cto?.getLinearDocument;
    const readPin = pinRef.current;
    if (typeof read !== "function") {
      setState({ status: "unsupported" });
      return;
    }
    if (!readPin) {
      setState({ status: "error", message: "No computer that reads Linear for this project is online." });
      return;
    }
    setState({ status: "loading" });
    void Promise.resolve()
      .then(() => read({ documentId }, readPin))
      .then((document) => {
        if (requestRef.current !== request) return;
        setState(document ? { status: "ready", document } : { status: "missing" });
      })
      .catch((error: unknown) => {
        if (requestRef.current !== request) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "Linear did not answer." });
      });
  }, [attempt, documentId, pinKey]);

  const document = state.status === "ready" ? state.document : null;
  const meta = document ? [document.projectName, formatUpdated(document.updatedAt)].filter(Boolean) : [];

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" aria-label={document?.title ?? "Linear document"} data-linear-document={documentId}>
      <header className="flex shrink-0 items-start gap-3 border-b border-fg/[0.06] px-5 py-3.5">
        <span className="mt-[3px] grid h-[22px] w-[22px] shrink-0 place-items-center">
          <DocumentGlyph document={document} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={cn("truncate text-[15px] font-semibold leading-snug text-fg", !document && "text-muted-fg/60")}>
            {document ? document.title || "Untitled document" : state.status === "loading" ? "Loading document" : "Document"}
          </h2>
          {meta.length ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-muted-fg/60">
              {meta.map((part, index) => (
                <span key={index} className={cn("truncate", index > 0 && "shrink-0")}>{part}</span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {document?.url ? (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-fg/75 transition-colors hover:bg-fg/[0.05] hover:text-fg"
              onClick={() => openExternalUrl(document.url!)}
            >
              <ArrowSquareOut size={13} aria-hidden />
              Open in Linear
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close document"
            title="Close document"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-fg/60 transition-colors hover:bg-fg/[0.05] hover:text-fg"
            onClick={onClose}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {state.status === "loading" ? <Skeleton /> : null}
        {state.status === "ready" ? (
          <div className="mx-auto max-w-[72ch] px-6 py-5">
            {document?.content?.trim() ? (
              <IssueMarkdown>{document.content}</IssueMarkdown>
            ) : (
              <p className="text-[12.5px] text-muted-fg/55">This document is empty.</p>
            )}
          </div>
        ) : null}
        {state.status === "missing" ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] text-fg/85">This document is not available</p>
            <p className="mt-1 text-[12px] text-muted-fg/60">It may have been deleted, or your Linear account cannot see it.</p>
          </div>
        ) : null}
        {state.status === "unsupported" ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] text-fg/85">Documents need a newer ADE</p>
            <p className="mt-1 text-[12px] text-muted-fg/60">Update ADE on the computer that reads Linear for this project.</p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] text-fg/85">Could not load this document</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-[12px] text-muted-fg/60">{state.message}</p>
            <button
              type="button"
              className="mt-3 inline-flex h-7 items-center rounded-md border border-fg/[0.10] px-3 text-[12px] text-fg/85 transition-colors hover:bg-fg/[0.05]"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
