import { useCallback, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  ArrowRight,
  CircleNotch,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { ProjectPathInspection } from "../../../shared/types";
import { extractError } from "../../lib/format";
import { fadeScale } from "../../lib/motion";
import { useAppStore } from "../../state/appStore";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
} from "../lanes/laneDesignTokens";
import { LaneAccentDot } from "../lanes/LaneAccentDot";

const DOCS_URL = "https://www.ade-app.dev/docs/lanes/repos-and-worktrees";

function basename(input: string): string {
  const parts = input.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? input;
}

// Abbreviate the user's home directory to `~` for compact local paths.
function abbreviateHome(input: string): string {
  const home = typeof process !== "undefined" ? (process.env?.HOME ?? "") : "";
  if (home && (input === home || input.startsWith(`${home}/`))) {
    return `~${input.slice(home.length)}`;
  }
  return input;
}

function deriveLaneName(inspection: ProjectPathInspection): string {
  const fromBranch = inspection.branchRef?.trim();
  if (fromBranch) return fromBranch;
  return inspection.worktreeRoot ? basename(inspection.worktreeRoot) : "worktree";
}

type BusyKind = "lane" | "standalone" | null;

export function WorktreeOpenDialog() {
  const prompt = useAppStore((s) => s.worktreeOpenPrompt);
  const dismiss = useAppStore((s) => s.dismissWorktreeOpenPrompt);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const navigate = useNavigate();

  const [busy, setBusy] = useState<BusyKind>(null);
  const [error, setError] = useState<string | null>(null);

  const inspection = prompt?.inspection ?? null;
  const parent = inspection?.parent ?? null;
  const open = Boolean(inspection && parent);

  const derivedLaneName = useMemo(
    () => (inspection ? deriveLaneName(inspection) : ""),
    [inspection],
  );

  const close = useCallback(() => {
    if (busy) return;
    setError(null);
    dismiss();
  }, [busy, dismiss]);

  const goToLane = useCallback(
    (laneId: string) => {
      setBusy(null);
      setError(null);
      dismiss();
      navigate(`/lanes?laneId=${laneId}&focus=single`);
    },
    [dismiss, navigate],
  );

  const openAsLane = useCallback(async () => {
    if (!inspection || !parent || !inspection.worktreeRoot) return;
    setBusy("lane");
    setError(null);
    try {
      await switchProjectToPath(parent.rootPath, { skipWorktreeGate: true });
      if (parent.existingLane) {
        goToLane(parent.existingLane.id);
        return;
      }
      try {
        const lane = await window.ade.lanes.attach({
          name: derivedLaneName,
          attachedPath: inspection.worktreeRoot,
        });
        goToLane(lane.id);
      } catch (attachErr) {
        const message = extractError(attachErr);
        // The worktree/branch may already be linked as a lane (attach errors
        // carry only the lane NAME, not its id). Re-inspect to resolve the id
        // and jump to the existing lane instead of surfacing a hard error.
        if (/already linked/i.test(message)) {
          try {
            const fresh = await window.ade.project.inspectPath(
              inspection.worktreeRoot,
            );
            const laneId = fresh.parent?.existingLane?.id ?? null;
            if (laneId) {
              goToLane(laneId);
              return;
            }
          } catch {
            // Fall through to the inline error below.
          }
        }
        setError(message);
        setBusy(null);
      }
    } catch (switchErr) {
      setError(extractError(switchErr));
      setBusy(null);
    }
  }, [derivedLaneName, goToLane, inspection, parent, switchProjectToPath]);

  const openStandalone = useCallback(async () => {
    if (!inspection?.worktreeRoot) return;
    setBusy("standalone");
    setError(null);
    try {
      await switchProjectToPath(inspection.worktreeRoot, {
        skipWorktreeGate: true,
      });
      setBusy(null);
      dismiss();
    } catch (err) {
      setError(extractError(err));
      setBusy(null);
    }
  }, [dismiss, inspection, switchProjectToPath]);

  const openExternalDocs = useCallback(() => {
    void window.ade.app.openExternal(DOCS_URL);
  }, []);

  if (!inspection || !parent) return null;

  const existingLane = parent.existingLane;
  const laneBusy = busy === "lane";
  const standaloneBusy = busy === "standalone";
  const subtitlePath = inspection.worktreeRoot
    ? abbreviateHome(inspection.worktreeRoot)
    : inspection.inputPath;

  const headerTitle = existingLane
    ? `Already open in ${parent.displayName}`
    : `This folder is a worktree of ${parent.displayName}`;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <AnimatePresence>
        {open && (
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
                className="fixed left-1/2 top-[14%] z-[130] -translate-x-1/2 w-[520px] max-w-[96vw] overflow-hidden rounded-2xl flex flex-col focus:outline-none"
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
                    <TreeStructure
                      size={16}
                      weight="duotone"
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
                      {headerTitle}
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
                  Choose whether to open this worktree as a lane in its owning
                  project or as a separate project.
                </Dialog.Description>

                <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                      {subtitlePath}
                      {inspection.branchRef ? (
                        <span style={{ color: COLORS.textDim }}>
                          {" · branch "}
                          {inspection.branchRef}
                        </span>
                      ) : null}
                    </div>
                    <p
                      style={{
                        margin: 0,
                        fontFamily: SANS_FONT,
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        color: COLORS.textSecondary,
                      }}
                    >
                      {existingLane
                        ? "This folder is the lane below — no need to add it again."
                        : "In ADE, a repo is one project and each worktree is a lane inside it."}
                    </p>
                  </div>

                  {existingLane ? (
                    <ExistingLaneCard
                      laneName={existingLane.name}
                      laneColor={existingLane.color}
                      branchRef={existingLane.branchRef}
                      parentName={parent.displayName}
                      busy={laneBusy}
                      disabled={Boolean(busy)}
                      onOpen={() => void openAsLane()}
                    />
                  ) : (
                    <RecommendedCard
                      title={
                        parent.isKnownAdeProject
                          ? `Open as a lane in ${parent.displayName}`
                          : `Add ${parent.displayName} as the project`
                      }
                      subtitle={
                        parent.isKnownAdeProject
                          ? `Attaches this worktree as lane "${derivedLaneName}" and jumps to it`
                          : `Opens ${parent.displayName} in ADE and attaches this worktree as a lane`
                      }
                      busy={laneBusy}
                      disabled={Boolean(busy)}
                      onClick={() => void openAsLane()}
                    />
                  )}

                  <button
                    type="button"
                    onClick={() => void openStandalone()}
                    disabled={Boolean(busy)}
                    style={{
                      alignSelf: "flex-start",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "none",
                      border: "none",
                      padding: 0,
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      color: COLORS.textMuted,
                      cursor: busy ? "default" : "pointer",
                      opacity: busy && !standaloneBusy ? 0.5 : 1,
                    }}
                  >
                    {standaloneBusy ? (
                      <CircleNotch size={13} className="animate-spin" />
                    ) : null}
                    Open as a separate project instead ›
                  </button>

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
                      justifyContent: "space-between",
                      gap: 12,
                      paddingTop: 4,
                      borderTop: `1px solid ${COLORS.borderMuted}`,
                      marginTop: 2,
                    }}
                  >
                    <button
                      type="button"
                      onClick={openExternalDocs}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        background: "none",
                        border: "none",
                        padding: "8px 0 0",
                        fontFamily: SANS_FONT,
                        fontSize: 11.5,
                        color: COLORS.textMuted,
                        cursor: "pointer",
                      }}
                    >
                      How ADE thinks about repos &amp; worktrees
                      <ArrowSquareOut size={12} weight="regular" />
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      disabled={Boolean(busy)}
                      style={outlineButton({
                        marginTop: 8,
                        opacity: busy ? 0.5 : 1,
                        cursor: busy ? "default" : "pointer",
                      })}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function ExistingLaneCard({
  laneName,
  laneColor,
  branchRef,
  parentName,
  busy,
  disabled,
  onOpen,
}: {
  laneName: string;
  laneColor: string | null;
  branchRef: string;
  parentName: string;
  busy: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: 12,
        background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
        border: `1px solid ${COLORS.accentBorder}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <LaneAccentDot color={laneColor} size={10} />
        <span
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
          {laneName}
        </span>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.accent,
            background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
            border: `1px solid ${COLORS.accentBorder}`,
            borderRadius: 8,
            padding: "2px 6px",
            flexShrink: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 180,
          }}
        >
          {branchRef}
        </span>
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          height: 34,
          padding: "0 14px",
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--color-accent-fg)",
          background: COLORS.accent,
          border: "none",
          borderRadius: 8,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled && !busy ? 0.6 : 1,
        }}
      >
        {busy ? <CircleNotch size={14} className="animate-spin" /> : null}
        Open this lane in {parentName}
      </button>
    </div>
  );
}

function RecommendedCard({
  title,
  subtitle,
  busy,
  disabled,
  onClick,
}: {
  title: string;
  subtitle: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        textAlign: "left",
        padding: 16,
        borderRadius: 14,
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 14%, transparent), color-mix(in srgb, var(--color-accent) 4%, transparent))",
        border: `1px solid ${hover ? COLORS.accent : COLORS.accentBorder}`,
        cursor: disabled ? "default" : "pointer",
        transform: hover && !disabled ? "translateY(-1px)" : "none",
        transition: "transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
        boxShadow:
          hover && !disabled
            ? "0 12px 32px -18px rgba(167,139,250,0.7)"
            : "none",
        opacity: disabled && !busy ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 40,
          height: 40,
          borderRadius: 12,
          flexShrink: 0,
          background: "color-mix(in srgb, var(--color-accent) 22%, transparent)",
          color: COLORS.accent,
          boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent) inset",
        }}
      >
        {busy ? (
          <CircleNotch size={18} className="animate-spin" />
        ) : (
          <TreeStructure size={18} weight="duotone" />
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 13.5,
              fontWeight: 600,
              color: COLORS.textPrimary,
            }}
          >
            {title}
          </span>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: COLORS.accent,
              background: "color-mix(in srgb, var(--color-accent) 16%, transparent)",
              border: `1px solid ${COLORS.accentBorder}`,
              borderRadius: 6,
              padding: "2px 6px",
              flexShrink: 0,
            }}
          >
            Recommended
          </span>
        </span>
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            lineHeight: 1.45,
            color: COLORS.textMuted,
          }}
        >
          {subtitle}
        </span>
      </span>
      <ArrowRight
        size={16}
        weight="bold"
        style={{ color: COLORS.accent, flexShrink: 0, opacity: hover ? 1 : 0.6 }}
      />
    </button>
  );
}
