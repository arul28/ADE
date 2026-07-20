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
import { baseName, formatBytes, maintenanceOutcome, type SafeCleanupGroup } from "./storageView";

/**
 * Optional "safe cleanup" plan. When present the dialog runs the broad
 * maintenance flow (grouped preview + plain-language "what happens" + a single
 * primary confirm) instead of the per-target removal flow. When `runMaintenance`
 * is available it drives the daemon doctor; otherwise the dialog falls back to
 * the per-target `cleanup` over `targets` (legacy runtimes).
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

  // When the maintenance doctor is available we skip the filesystem preview and
  // go straight to the itemized plan; the doctor is comprehensive on its own.
  const maintenanceMode = Boolean(plan);
  const skipPreview = Boolean(plan?.runMaintenance);

  // The preview is initialized once per open. We deliberately do NOT re-run when
  // `targets` changes identity: a successful cleanup reloads the parent snapshot,
  // which recomputes the (derived) safe-cleanup targets — re-running here would
  // reset a "done" dialog back to "review". Read the latest values via a ref.
  const initRef = React.useRef({ targets, skipPreview });
  initRef.current = { targets, skipPreview };

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    const { targets: openTargets, skipPreview: openSkip } = initRef.current;
    setResult(null);
    setReport(null);
    setError(null);
    if (openSkip) {
      setPreview(null);
      setStage("review");
      return;
    }
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

  React.useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stage !== "removing") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, stage, onClose]);

  const confirm = React.useCallback(async () => {
    setStage("removing");
    setError(null);
    try {
      // Maintenance path: run the daemon doctor and report what it reclaimed.
      if (plan?.runMaintenance) {
        const nextReport = await plan.runMaintenance();
        const freedBytes = typeof nextReport?.reclaimedBytes === "number" && Number.isFinite(nextReport.reclaimedBytes)
          ? nextReport.reclaimedBytes
          : 0;
        const synthesized: StorageCleanupResult = { removed: [], failed: [], freedBytes };
        setReport(nextReport ?? null);
        setResult(synthesized);
        setStage("done");
        onCleaned(synthesized);
        plan.onMaintenanceDone?.(nextReport);
        return;
      }
      // Fallback / per-target path: remove exactly what was previewed.
      if (!preview || preview.items.length === 0) {
        setStage("review");
        return;
      }
      const next = await window.ade.storage.cleanup(targets, { preview });
      setResult(next);
      setStage("done");
      onCleaned(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, [plan, preview, targets, onCleaned]);

  if (!open) return null;

  const removableCount = preview?.items.length ?? 0;
  // In maintenance mode with the doctor available we always allow confirming
  // (the estimate is daemon-provided and the primary action is gated upstream).
  const confirmDisabled = stage === "removing" || stage === "loading" ||
    (skipPreview ? false : removableCount === 0);
  const confirmLabel = plan?.confirmLabel
    ?? (removableCount > 0 ? `Remove ${removableCount === 1 ? "1 item" : `${removableCount} items`}` : "Remove");
  const reportOutcome = report ? maintenanceOutcome(report) : null;

  return (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && stage !== "removing") onClose();
      }}
    >
      <section role="dialog" aria-modal="true" aria-label={title} style={panelStyle}>
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
                  color: reportOutcome?.failed ? COLORS.danger : COLORS.success,
                }}
              >
                {maintenanceMode && reportOutcome
                  ? `${reportOutcome.message}.`
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
      </section>
    </div>
  );
}
