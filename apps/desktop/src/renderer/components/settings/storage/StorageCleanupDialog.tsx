import React from "react";
import { Broom, CircleNotch, Trash, WarningCircle } from "@phosphor-icons/react";
import type {
  MaintenanceRunReport,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
} from "../../../../shared/types/storage";
import {
  COLORS,
  SANS_FONT,
  outlineButton,
  dangerButton,
  primaryButton,
} from "../../lanes/laneDesignTokens";
import { baseName, formatBytes, type SafeCleanupGroup } from "./storageView";

/**
 * Optional "safe cleanup" plan. When present the dialog shows a grouped,
 * plain-language review and a single primary confirmation. Filesystem targets
 * are still previewed and removed through the preview-bound cleanup contract;
 * `runMaintenance`, when available, handles the separate compression and
 * database work after that removal.
 */
export type SafeCleanupPlanConfig = {
  groups: SafeCleanupGroup[];
  whatHappens: string[];
  estimatedBytes: number;
  confirmLabel: string;
  runMaintenance?: () => Promise<MaintenanceRunReport>;
  onMaintenanceDone?: (report: MaintenanceRunReport) => void;
};

type Stage = "loading" | "review" | "removing" | "done" | "error";

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.62)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  padding: 16,
};

const panelStyle: React.CSSProperties = {
  width: 520,
  maxWidth: "100%",
  maxHeight: "min(680px, calc(100vh - 32px))",
  display: "flex",
  flexDirection: "column",
  background: COLORS.cardBgSolid,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 14,
  boxShadow: "0 28px 80px -32px rgba(0,0,0,0.82)",
  overflow: "hidden",
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const mountedDialogFrames: HTMLElement[] = [];

export function StorageDialogFrame({
  title,
  canClose = true,
  onClose,
  panelStyleOverride,
  children,
}: {
  title: string;
  canClose?: boolean;
  onClose: () => void;
  panelStyleOverride?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const dialogRef = React.useRef<HTMLElement>(null);
  const returnFocusRef = React.useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const closeRef = React.useRef(onClose);
  const canCloseRef = React.useRef(canClose);
  closeRef.current = onClose;
  canCloseRef.current = canClose;

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) mountedDialogFrames.push(dialog);
    const frame = window.requestAnimationFrame(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? dialogRef.current)?.focus();
    });
    const handler = (event: KeyboardEvent) => {
      if (mountedDialogFrames.at(-1) !== dialogRef.current) return;
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const focusIsOutside = !dialogRef.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handler, true);
      const index = dialog ? mountedDialogFrames.lastIndexOf(dialog) : -1;
      if (index >= 0) mountedDialogFrames.splice(index, 1);
      returnFocusRef.current?.focus();
    };
  }, []);

  return (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && canClose) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ ...panelStyle, ...panelStyleOverride }}
      >
        {children}
      </section>
    </div>
  );
}

function Row({
  label,
  path,
  size,
  tone,
  reason,
}: {
  label: string;
  path: string;
  size?: string;
  tone: "remove" | "blocked";
  reason?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        padding: "9px 11px",
        borderRadius: 9,
        border: `1px solid ${tone === "blocked" ? "color-mix(in srgb, var(--color-warning) 26%, transparent)" : COLORS.borderMuted}`,
        background:
          tone === "blocked"
            ? "color-mix(in srgb, var(--color-warning) 8%, transparent)"
            : "color-mix(in srgb, var(--color-fg) 3%, transparent)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 550, color: COLORS.textPrimary }}>
          {label}
        </div>
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 10.5,
            color: COLORS.textMuted,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={path}
        >
          {path}
        </div>
        {reason ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.warning, marginTop: 4 }}>
            {reason}
          </div>
        ) : null}
      </div>
      {size ? (
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.textSecondary,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {size}
        </div>
      ) : null}
    </div>
  );
}

export function StorageCleanupDialog({
  open,
  title,
  intro,
  targets,
  plan,
  onClose,
  onCleaned,
}: {
  open: boolean;
  title: string;
  intro?: string;
  targets: StorageCleanupTarget[];
  plan?: SafeCleanupPlanConfig;
  onClose: () => void;
  onCleaned: (result: StorageCleanupResult) => void;
}) {
  const [stage, setStage] = React.useState<Stage>("loading");
  const [preview, setPreview] = React.useState<StorageCleanupPreview | null>(null);
  const [result, setResult] = React.useState<StorageCleanupResult | null>(null);
  const [report, setReport] = React.useState<MaintenanceRunReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const maintenanceMode = Boolean(plan);

  // The preview is initialized once per open. We deliberately do NOT re-run when
  // `targets` changes identity: a successful cleanup reloads the parent snapshot,
  // which recomputes the (derived) safe-cleanup targets — re-running here would
  // reset a "done" dialog back to "review". Read the latest values via a ref.
  const initRef = React.useRef({ targets });
  initRef.current = { targets };

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    const { targets: openTargets } = initRef.current;
    setResult(null);
    setReport(null);
    setError(null);
    setStage("loading");
    setPreview(null);
    void window.ade.storage
      .cleanupPreview(openTargets)
      .then((next) => {
        if (!active) return;
        setPreview(next);
        setStage("review");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setStage("error");
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirm = React.useCallback(async () => {
    setStage("removing");
    setError(null);
    try {
      if (!preview) {
        setStage("review");
        return;
      }
      const filesystemResult = preview.items.length > 0
        ? await window.ade.storage.cleanup(targets, { preview })
        : { removed: [], failed: [], freedBytes: 0 };
      const nextReport = plan?.runMaintenance ? await plan.runMaintenance() : null;
      const maintenanceBytes = typeof nextReport?.reclaimedBytes === "number" && Number.isFinite(nextReport.reclaimedBytes)
        ? Math.max(0, nextReport.reclaimedBytes)
        : 0;
      const next: StorageCleanupResult = {
        ...filesystemResult,
        freedBytes: filesystemResult.freedBytes + maintenanceBytes,
      };
      setReport(nextReport);
      setResult(next);
      setStage("done");
      onCleaned(next);
      if (nextReport) plan?.onMaintenanceDone?.(nextReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, [plan, preview, targets, onCleaned]);

  if (!open) return null;

  const removableCount = preview?.items.length ?? 0;
  const confirmDisabled = stage === "removing" || stage === "loading" ||
    (removableCount === 0 && !plan?.runMaintenance);
  const confirmLabel = plan?.confirmLabel
    ?? (removableCount > 0 ? `Remove ${removableCount === 1 ? "1 item" : `${removableCount} items`}` : "Remove");
  const cleanupFailed = Boolean(result?.failed.length)
    || Boolean(report?.actions.some((action) => Boolean(action.error)));

  return (
    <StorageDialogFrame title={title} canClose={stage !== "removing"} onClose={onClose}>
        <header
          style={{
            padding: "16px 18px",
            borderBottom: `1px solid ${COLORS.borderMuted}`,
          }}
        >
          <h2 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 15, fontWeight: 650, color: COLORS.textPrimary }}>
            {title}
          </h2>
          {intro ? (
            <p style={{ margin: "6px 0 0", fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5, color: COLORS.textMuted }}>
              {intro}
            </p>
          ) : null}
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          {stage === "loading" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
              <CircleNotch size={15} className="animate-spin" />
              Checking what can be safely removed.
            </div>
          ) : null}

          {stage === "error" ? (
            <div
              style={{
                fontFamily: SANS_FONT,
                fontSize: 12,
                lineHeight: 1.5,
                color: COLORS.danger,
                background: "color-mix(in srgb, var(--color-error) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-error) 26%, transparent)",
                borderRadius: 9,
                padding: "10px 12px",
              }}
            >
              {error ?? "Something went wrong."}
            </div>
          ) : null}

          {maintenanceMode && plan && (stage === "review" || stage === "removing") ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {plan.groups.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {plan.groups.map((group) => (
                    <div key={group.heading} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div
                        style={{
                          fontFamily: SANS_FONT,
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: 0.7,
                          textTransform: "uppercase",
                          color: COLORS.textMuted,
                        }}
                      >
                        {group.heading}
                      </div>
                      {group.rows.map((row, index) => (
                        <div
                          key={`${group.heading}-${row.label}-${index}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: "8px 11px",
                            borderRadius: 9,
                            border: `1px solid ${COLORS.borderMuted}`,
                            background: "color-mix(in srgb, var(--color-fg) 3%, transparent)",
                          }}
                        >
                          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>{row.label}</span>
                          <span
                            style={{
                              fontFamily: SANS_FONT,
                              fontSize: 12,
                              fontWeight: 600,
                              color: COLORS.textSecondary,
                              fontVariantNumeric: "tabular-nums",
                              flexShrink: 0,
                            }}
                          >
                            {row.size}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}

              {plan.whatHappens.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)",
                    border: `1px solid ${COLORS.borderMuted}`,
                  }}
                >
                  <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 650, color: COLORS.textSecondary }}>
                    What happens
                  </div>
                  {plan.whatHappens.map((line, index) => (
                    <div
                      key={index}
                      style={{ display: "flex", gap: 8, fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.5, color: COLORS.textMuted }}
                    >
                      <span aria-hidden style={{ color: COLORS.textDim }}>·</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                This will free about {formatBytes(plan.estimatedBytes)}.
              </div>
              {preview && preview.blocked.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    <WarningCircle size={13} weight="fill" style={{ color: COLORS.warning }} />
                    {preview.blocked.length === 1 ? "1 item will be kept" : `${preview.blocked.length} items will be kept`}
                  </div>
                  {preview.blocked.map((entry) => (
                    <Row key={entry.path} label={baseName(entry.path)} path={entry.path} tone="blocked" reason={entry.reason} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!maintenanceMode && (stage === "review" || stage === "removing") && preview ? (
            <>
              {preview.items.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {preview.items.map((entry) => (
                    <Row
                      key={entry.path}
                      label={entry.label}
                      path={entry.path}
                      size={formatBytes(entry.bytes)}
                      tone="remove"
                    />
                  ))}
                  <div
                    style={{
                      marginTop: 2,
                      fontFamily: SANS_FONT,
                      fontSize: 13,
                      fontWeight: 600,
                      color: COLORS.textPrimary,
                    }}
                  >
                    This will free about {formatBytes(preview.totalBytes)}.
                  </div>
                </div>
              ) : (
                <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  Nothing here can be removed right now.
                </div>
              )}

              {preview.blocked.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    <WarningCircle size={13} weight="fill" style={{ color: COLORS.warning }} />
                    {preview.blocked.length === 1 ? "1 item was kept" : `${preview.blocked.length} items were kept`}
                  </div>
                  {preview.blocked.map((entry) => (
                    <Row key={entry.path} label={baseName(entry.path)} path={entry.path} tone="blocked" reason={entry.reason} />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {stage === "done" && result ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 14,
                  fontWeight: 650,
                  color: cleanupFailed ? COLORS.danger : COLORS.success,
                }}
              >
                {cleanupFailed
                  ? result.freedBytes > 0
                    ? `Freed ${formatBytes(result.freedBytes)}, but some cleanup steps couldn't finish.`
                    : "Some cleanup steps couldn't finish."
                  : result.freedBytes > 0
                    ? `Freed ${formatBytes(result.freedBytes)}.`
                    : "Nothing needed removing."}
              </div>
              {result.removed.length > 0 ? (
                <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  Removed {result.removed.length === 1 ? "1 item" : `${result.removed.length} items`}.
                </div>
              ) : null}
              {result.failed.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    Some items could not be removed:
                  </div>
                  {result.failed.map((entry) => (
                    <Row key={entry.path} label={baseName(entry.path)} path={entry.path} tone="blocked" reason={entry.reason} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: `1px solid ${COLORS.borderMuted}`,
          }}
        >
          {stage === "done" ? (
            <button type="button" style={outlineButton({ height: 34 })} onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                style={outlineButton({ height: 34 })}
                onClick={onClose}
                disabled={stage === "removing"}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{
                  ...(maintenanceMode ? primaryButton({ height: 34 }) : dangerButton({ height: 34 })),
                  opacity: confirmDisabled ? 0.5 : 1,
                  cursor: confirmDisabled ? "not-allowed" : "pointer",
                }}
                onClick={() => void confirm()}
                disabled={confirmDisabled}
              >
                {stage === "removing" ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : maintenanceMode ? (
                  <Broom size={14} />
                ) : (
                  <Trash size={14} />
                )}
                {stage === "removing"
                  ? maintenanceMode
                    ? "Cleaning up…"
                    : "Removing…"
                  : confirmLabel}
              </button>
            </>
          )}
        </footer>
    </StorageDialogFrame>
  );
}
