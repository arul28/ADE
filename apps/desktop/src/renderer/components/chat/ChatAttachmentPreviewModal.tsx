import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { createMonacoModelRegistry } from "../files/monacoModelRegistry";
import { resolveLanguageId } from "../files/filePresentation";
import { createPinnedFilesApi } from "../files/v2/pinnedFilesApi";
import { editorTabId, type EditorTab } from "../files/v2/editorGroupsStore";
import { resolveViewerKind } from "../files/v2/viewerRegistry";
import { ViewerHost } from "../files/v2/ViewerHost";
import {
  resolveAttachmentWorkspaceTarget,
  type AttachmentViewerTarget,
} from "./attachmentViewerTarget";

type ResolveState =
  | { status: "loading" }
  | { status: "ready"; target: AttachmentViewerTarget }
  | { status: "error"; message: string };

/**
 * A staged or sent chat attachment, opened full-size with the Files tab's own
 * viewer platform.
 *
 * Reuse, not a fork: the viewer is chosen by `resolveViewerKind` and rendered
 * by `ViewerHost`, so a PDF, a CSV, a video, an office document and a source
 * file all render here exactly as they do in Files, and a viewer added there
 * shows up here with no change. The only thing this component owns is the
 * dialog chrome and locating the attachment inside a workspace.
 *
 * Editing is deliberately out of scope. `ViewerHost` derives `readOnly` from
 * whether the payload round-trips as text, so a code or markdown attachment
 * would technically be writable; the popup never surfaces a save affordance and
 * an attachment is a snapshot the user handed to an agent, not a project file.
 */
export function ChatAttachmentPreviewModal({
  attachmentPath,
  title,
  pin,
  fallbackImageDataUrl,
  onClose,
}: {
  attachmentPath: string;
  title: string;
  pin: OpenProjectBinding | null;
  /**
   * Preview bytes the chip already holds for an image attachment. Used only
   * when workspace resolution fails — an attachment staged with no project
   * open lands in system temp, outside every workspace, and would otherwise
   * lose a preview that used to work.
   */
  fallbackImageDataUrl?: string | null;
  onClose: () => void;
}) {
  const files = useMemo(() => createPinnedFilesApi(pin), [pin]);
  const registryRef = useRef(createMonacoModelRegistry());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<ResolveState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // `Promise.resolve().then` so a bridge that throws synchronously (no
    // `window.ade.files` at all) becomes the same error state as a rejected
    // read, instead of escaping the effect and taking the transcript down.
    Promise.resolve()
      .then(() => files.listWorkspaces({}))
      .then((workspaces) => {
        if (cancelled) return;
        const target = resolveAttachmentWorkspaceTarget(attachmentPath, workspaces);
        if (!target) {
          setState({
            status: "error",
            message: "This attachment is outside every open workspace, so it can't be previewed here.",
          });
          return;
        }
        setState({ status: "ready", target });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [files, attachmentPath]);

  // Return focus where it came from, pull it into the dialog, and lock body
  // scroll — same contract as the image lightbox this replaces.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  const registry = registryRef.current;
  // The popup owns its Monaco models; nothing else shares this registry, so
  // closing it must free them or every preview leaks one model per file.
  useEffect(() => () => registry.disposeAll(), [registry]);

  const tab: EditorTab | null = useMemo(() => {
    if (state.status !== "ready") return null;
    const { workspaceId, relativePath } = state.target;
    return {
      id: editorTabId(workspaceId, relativePath),
      workspaceId,
      laneId: null,
      path: relativePath,
      title,
      viewerKind: resolveViewerKind({ path: relativePath }),
      languageId: resolveLanguageId(relativePath),
      preview: true,
      pinned: false,
    };
  }, [state, title]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = containerRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.tabIndex >= 0);
    if (focusables.length === 0) {
      event.preventDefault();
      closeButtonRef.current?.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === first || !active || !root.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !active || !root.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="chat-attachment-preview"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative flex h-[min(85vh,900px)] w-[min(92vw,1200px)] flex-col overflow-hidden rounded-md border border-white/10 bg-[color:var(--surface-1,#111)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg/80" title={attachmentPath}>
            {title}
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/10 bg-black/40 text-white/75 transition-colors hover:bg-black hover:text-white"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={13} weight="bold" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {state.status === "loading" ? (
            <Centered>Opening {title}…</Centered>
          ) : state.status === "error" ? (
            fallbackImageDataUrl ? (
              <div className="flex h-full items-center justify-center p-4">
                <img
                  src={fallbackImageDataUrl}
                  alt={title}
                  className="max-h-full max-w-full rounded object-contain"
                />
              </div>
            ) : (
              <Centered tone="danger">{state.message}</Centered>
            )
          ) : tab ? (
            <ViewerHost
              workspaceId={state.target.workspaceId}
              files={files}
              rootPath={state.target.rootPath}
              tab={tab}
              theme="dark"
              registry={registry}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <div
      className={`flex h-full items-center justify-center p-6 text-center text-sm ${
        tone === "danger" ? "text-red-300/80" : "text-fg/55"
      }`}
    >
      {children}
    </div>
  );
}
