import React, { useEffect, useRef, useState } from "react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import type { PinnedFilesApi } from "../pinnedFilesApi";
import { streamFileBytes } from "../streamBytes";
import { DocumentSurface } from "./DocumentSurface";
import { formatBytes } from "../../../../../shared/formatting";
import { ooxmlFailureMessage } from "./office/ooxmlError";

type ShellState<T> =
  | { status: "loading" }
  /** `retryable` is false for a refusal that re-running cannot change (size). */
  | { status: "error"; message: string; retryable: boolean }
  | { status: "ready"; value: T };

/**
 * The shared shell for an OOXML preview: size pre-check, capped byte stream,
 * parse, cancellation, and the one failure card.
 *
 * Both viewers need exactly this and nothing more — the spreadsheet's ready
 * branch renders a grid and the presentation's renders a deck, but the path to
 * "we have a parsed model, or an honest reason why not" is identical. Keeping
 * it in one place is what makes the caps and the copy true for both: a change
 * to the byte ceiling or the retry affordance lands once.
 *
 * `load` is what keeps the parser lazy: each viewer passes a closure that does
 * its own `await import("./office/…")`, so the reader still lands in its own
 * chunk. It is held in a ref, not a dependency — a caller passing an inline
 * arrow must not restart the read on every render.
 */
export function OoxmlPreviewShell<T>({
  files,
  workspaceId,
  path,
  byteCap,
  declaredSize,
  loadingLabel,
  fallback,
  load,
  children,
}: {
  files: PinnedFilesApi;
  workspaceId: string;
  path: string;
  /** Largest file this preview will stream. */
  byteCap: number;
  /** The file's full size from its `readFile` payload, for the pre-check. */
  declaredSize: number;
  loadingLabel: string;
  /** What the failure card names, when there is nothing to draw. */
  fallback: { rootPath: string; title: string; mimeType: string | null; size: number };
  /** Streams nothing; receives the bytes and returns the parsed model. */
  load: (bytes: Uint8Array) => Promise<T>;
  children: (value: T) => React.ReactNode;
}) {
  const [state, setState] = useState<ShellState<T>>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    // Refuse before reading a byte: streaming a 40 MB file only to reject it
    // wastes the read and the user's time.
    if (declaredSize > byteCap) {
      setState({
        status: "error",
        retryable: false,
        message: `This file is ${formatBytes(declaredSize)} — larger than the ${formatBytes(byteCap)} a preview reads. Open it externally.`,
      });
      return;
    }
    setState({ status: "loading" });
    (async () => {
      try {
        const bytes = await streamFileBytes(files, workspaceId, path, {
          isCancelled: () => cancelled,
          maxBytes: byteCap,
        });
        if (cancelled) return;
        const value = await loadRef.current(bytes);
        if (cancelled) return;
        setState({ status: "ready", value });
      } catch (err) {
        if (!cancelled) setState({ status: "error", retryable: true, message: ooxmlFailureMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, workspaceId, path, byteCap, declaredSize, reloadKey]);

  if (state.status === "loading") {
    return <ViewerCenteredMessage>{loadingLabel}</ViewerCenteredMessage>;
  }

  if (state.status === "error") {
    return (
      <DocumentSurface
        rootPath={fallback.rootPath}
        relativePath={path}
        title={fallback.title}
        mimeType={fallback.mimeType}
        size={fallback.size}
        notice={state.message}
        extraActions={state.retryable ? (
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
            style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          >
            Try again
          </button>
        ) : null}
      />
    );
  }

  return <>{children(state.value)}</>;
}

/** The quiet centered line every viewer uses for "nothing to draw yet". */
export function ViewerCenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm" style={{ color: COLORS.textDim }}>
      {children}
    </div>
  );
}
