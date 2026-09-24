import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { Dialog } from "../ui/dialog";

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

  // Escape closes — but a viewer that answers Escape itself (Monaco's find
  // widget) stops it at its own node, so the close listens where the viewer
  // can stop it: on the way back up through this dialog's React tree. The
  // shared Dialog's document-level Escape only closes when the key did not
  // start inside the viewer area.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };

  // Scroll lock, focus trap and focus return are the Dialog's.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      hideHeader
      testId="chat-attachment-preview"
      // Mounted inside the attachment chip: clicks in the viewer never reach it.
      stopClickPropagation
      width="min(92vw, 1200px)"
      height="min(85vh, 900px)"
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      // Viewers render for this dark surface in every theme.
      panelStyle={{ background: "var(--surface-1, #111)", borderRadius: 6 }}
      initialFocusRef={closeButtonRef}
      onEscapeKeyDown={(event) => {
        if (containerRef.current?.contains(event.target as Node)) {
          // Let it reach the viewer first; `handleKeyDown` closes after.
          event.preventDefault();
          return;
        }
        event.stopPropagation();
      }}
    >
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
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
    </Dialog>
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
