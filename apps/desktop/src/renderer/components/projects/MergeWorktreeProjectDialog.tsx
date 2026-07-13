import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { CircleNotch, GitMerge, X } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { parseCodedErrorMessage } from "../../../shared/codedError";
import type {
  ProjectPathInspection,
  RecentProjectSummary,
} from "../../../shared/types";
import { fadeScale } from "../../lib/motion";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
} from "../lanes/laneDesignTokens";
import { openWorktreeAsLane } from "./worktreeLaneFlow";

function retiredWorkLine(
  state: { chatCount: number; laneCount: number } | null,
): string | null {
  if (!state) return null;
  const parts: string[] = [];
  if (state.chatCount > 0) {
    parts.push(`${state.chatCount} chat${state.chatCount === 1 ? "" : "s"}`);
  }
  if (state.laneCount > 0) {
    parts.push(`${state.laneCount} lane${state.laneCount === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} created here stay under the retired project — still searchable, but they won't move.`;
}

export function MergeWorktreeProjectDialog({
  recent,
  recentKey,
  onClose,
  onRecentsUpdated,
}: {
  recent: RecentProjectSummary;
  recentKey: string;
  onClose: () => void;
  onRecentsUpdated: (next: RecentProjectSummary[]) => void;
}) {
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const navigate = useNavigate();

  const [inspection, setInspection] = useState<ProjectPathInspection | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    void window.ade.project
      .inspectPath(recent.rootPath, { fresh: true })
      .then((result) => {
        if (cancelledRef.current) return;
        setInspection(result);
      })
      .catch((err) => {
        if (cancelledRef.current) return;
        setError(parseCodedErrorMessage(err).message);
      })
      .finally(() => {
        if (cancelledRef.current) return;
        setLoading(false);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [recent.rootPath]);

  const parent = inspection?.parent ?? recent.worktreeOf;
  const parentName = parent?.displayName ?? "";
  const warningLine = retiredWorkLine(inspection?.standaloneState ?? null);

  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  const confirmMerge = useCallback(async () => {
    if (!inspection?.parent || !inspection.worktreeRoot) return;
    setBusy(true);
    setError(null);
    let switched = false;
    try {
      await openWorktreeAsLane(inspection, {
        switchProjectToPath: async (rootPath, opts) => {
          await switchProjectToPath(rootPath, opts);
          switched = true;
        },
        navigate: async (path) => {
          // The lane exists by the time this runs — retiring the recents row is
          // cleanup, and a failure here must not block landing on the lane or
          // report the merge itself as failed.
          try {
            const next = await window.ade.project.forgetRecent(recentKey);
            onRecentsUpdated(next);
          } catch {
            // Row stays until the next manual remove; merge still succeeded.
          }
          onClose();
          await navigate(path);
        },
      });
    } catch (err) {
      const message = parseCodedErrorMessage(err).message;
      setError(message);
      setBusy(false);
      if (switched) {
        showToast({
          title: "Merge failed",
          message,
          tone: "error",
          durationMs: 0,
        });
      }
    }
  }, [inspection, navigate, onClose, onRecentsUpdated, recentKey, switchProjectToPath]);

  const canConfirm = Boolean(inspection?.parent) && !busy && !loading;

  return (
    <Dialog.Root open onOpenChange={(next) => (next ? undefined : close())}>
      <AnimatePresence>
        <Dialog.Portal forceMount>
          <Dialog.Overlay asChild>
            <motion.div
              className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-2xl"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
          </Dialog.Overlay>
          <Dialog.Content
            asChild
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <motion.div
              className="fixed left-1/2 top-[16%] z-[130] -translate-x-1/2 w-[480px] max-w-[96vw] overflow-hidden rounded-2xl flex flex-col focus:outline-none"
              style={{
                background:
                  "radial-gradient(120% 120% at 0% 0%, rgba(167,139,250,0.10), transparent 55%), " +
                  "radial-gradient(100% 100% at 100% 100%, rgba(82,56,175,0.10), transparent 60%), " +
                  "var(--color-popup-bg)",
                border: "1px solid transparent",
                backgroundClip: "padding-box",
                boxShadow:
                  "0 36px 100px -28px rgba(0,0,0,0.88), 0 0 0 1px rgba(167,139,250,0.22), 0 18px 48px -24px rgba(167,139,250,0.28)",
              }}
              variants={fadeScale}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div
                className="flex items-center justify-between gap-3 border-b px-4 py-3"
                style={{
                  background:
                    "color-mix(in srgb, var(--color-surface-recessed) 92%, rgba(167,139,250,0.08))",
                  borderColor:
                    "color-mix(in srgb, var(--color-accent) 14%, var(--color-border))",
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <GitMerge
                    size={16}
                    weight="bold"
                    className="shrink-0"
                    style={{ color: COLORS.accent }}
                  />
                  <Dialog.Title
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 13,
                      fontWeight: 600,
                      color: COLORS.textPrimary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {parentName
                      ? `Merge ${recent.displayName} into ${parentName}`
                      : `Merge ${recent.displayName}`}
                  </Dialog.Title>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={close}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted-fg)] transition-colors hover:bg-white/10 hover:text-fg"
                  >
                    <X size={14} weight="regular" />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description className="sr-only">
                Re-home this standalone worktree project as a lane in its owning
                project.
              </Dialog.Description>

              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <p
                  style={{
                    margin: 0,
                    fontFamily: SANS_FONT,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: COLORS.textSecondary,
                  }}
                >
                  {parentName ? (
                    <>
                      This project is a worktree of{" "}
                      <span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>
                        {parentName}
                      </span>
                      . Merging re-homes it as a lane there and removes this
                      standalone project entry.
                    </>
                  ) : (
                    "Merging re-homes this worktree as a lane in its owning project and removes this standalone project entry."
                  )}
                </p>

                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    color: COLORS.textMuted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {recent.rootPath}
                </div>

                {loading ? (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      color: COLORS.textMuted,
                    }}
                  >
                    <CircleNotch size={13} className="animate-spin" />
                    Checking the owning project…
                  </div>
                ) : warningLine ? (
                  <div
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      lineHeight: 1.45,
                      color: COLORS.warning,
                      background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--color-warning) 34%, transparent)",
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    {warningLine}
                  </div>
                ) : null}

                {error ? (
                  <div
                    role="alert"
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      lineHeight: 1.45,
                      color: "#FCA5A5",
                      background: "rgba(248,113,113,0.12)",
                      border: "1px solid rgba(248,113,113,0.4)",
                      borderRadius: 8,
                      padding: "8px 10px",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {error}
                  </div>
                ) : null}

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: 8,
                    paddingTop: 4,
                  }}
                >
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    style={outlineButton({
                      opacity: busy ? 0.5 : 1,
                      cursor: busy ? "default" : "pointer",
                    })}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmMerge()}
                    disabled={!canConfirm}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      height: 32,
                      padding: "0 14px",
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--color-accent-fg)",
                      background: COLORS.accent,
                      border: "none",
                      borderRadius: 8,
                      cursor: canConfirm ? "pointer" : "default",
                      opacity: canConfirm ? 1 : 0.55,
                    }}
                  >
                    {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
                    {parentName ? `Merge into ${parentName}` : "Merge"}
                  </button>
                </div>
              </div>
            </motion.div>
          </Dialog.Content>
        </Dialog.Portal>
      </AnimatePresence>
    </Dialog.Root>
  );
}
