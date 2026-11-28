import { BRAND } from "../../../../shared/brand";
import React, { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, FileText, X } from "@phosphor-icons/react";
import type { CtoLinearDocument, OpenProjectBinding } from "../../../../shared/types";
import { isAdeCloudBinding } from "../../../../shared/adeCloud/binding";
import { isUnsupportedAdeActionError } from "../../../../shared/codedError";
import { openExternalUrl } from "../../../lib/openExternal";
import { IssueMarkdown } from "../../issues/issueMarkdown";
import { resolveLinearProjectIcon } from "../../lanes/linearProjectIcon";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/notice";

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
  /** An ADE Cloud project: the account answers Linear reads and has no documents read. */
  | { status: "cloud" }
  | { status: "offline" }
  | { status: "error"; message: string }
  | { status: "unsupported" };

/**
 * An older machine answers a read it does not have with "not callable" / "not
 * exposed" (a runtime action), or with no IPC handler (an older desktop main).
 */
function isMissingDocumentRead(error: unknown): boolean {
  if (isUnsupportedAdeActionError(error)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no handler registered/i.test(message);
}

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
      setState({ status: "offline" });
      return;
    }
    setState({ status: "loading" });
    void Promise.resolve()
      .then(() => read({ documentId }, readPin))
      .then((document) => {
        if (requestRef.current !== request) return;
        if (document) setState({ status: "ready", document });
        else setState({ status: isAdeCloudBinding(readPin) ? "cloud" : "missing" });
      })
      .catch((error: unknown) => {
        if (requestRef.current !== request) return;
        if (isMissingDocumentRead(error)) {
          setState({ status: "unsupported" });
          return;
        }
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
            <p className="text-[13px] text-fg/85">Documents need a newer {BRAND.NAME}</p>
            <p className="mt-1 text-[12px] text-muted-fg/60">Update {BRAND.NAME} on the computer that reads Linear for this project.</p>
          </div>
        ) : null}
        {state.status === "cloud" ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] text-fg/85">Documents do not open in {BRAND.CLOUD_NAME} projects yet</p>
            <p className="mt-1 text-[12px] text-muted-fg/60">Open this document in Linear, or open the project on one of your computers.</p>
          </div>
        ) : null}
        {state.status === "offline" ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] text-fg/85">No computer that reads Linear is online</p>
            <p className="mt-1 text-[12px] text-muted-fg/60">The document opens once the computer that reads Linear for this project reconnects.</p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="px-5 py-5">
            <Banner
              layout="inline"
              model={{
                id: `linear-document-error:${documentId}`,
                tone: "error",
                title: "Could not load this document",
                report: {
                  surface: "linear_document",
                  code: "linear_document_read_failed",
                  technicalDetail: state.message,
                },
                actions: [{ label: "Try again", onClick: () => setAttempt((value) => value + 1) }],
              }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
