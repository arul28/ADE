import React from "react";
import { Broom, CircleNotch, Trash, WarningCircle } from "@phosphor-icons/react";
import type {
  MaintenanceRunReport,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
} from "../../../../shared/types/storage";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { Dialog, type DialogAction } from "../../ui/dialog";
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

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * A storage dialog whose content draws its own header (the reclaim confirm).
 * The shared `Dialog` supplies the scrim, panel, focus trap, Escape and focus
 * return; stacked frames close top-first through Radix's layer stack.
 */
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
  const contentRef = React.useRef<HTMLDivElement>(null);
  // The frame has always opened on its first control (a frame after the
  // content's own autoFocus), not on a text field further down.
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && canClose) onClose();
      }}
      title={title}
      hideHeader
      dismissible={canClose}
      width={520}
      maxHeight="min(680px, calc(100vh - 32px))"
      bodyPadding={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      panelStyle={panelStyleOverride}
    >
      <div ref={contentRef} style={{ display: "contents" }}>
        {children}
      </div>
    </Dialog>
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
  // Which half of the job failed. "Something went wrong" told people nothing;
  // whether ADE failed to *look* or failed to *remove* changes both what is
  // true about their disk and what they should do next.
  const [errorPhase, setErrorPhase] = React.useState<"checking" | "removing">("checking");

  const maintenanceMode = Boolean(plan);

  // The preview is initialized once per open. We deliberately do NOT re-run when
  // `targets` changes identity: a successful cleanup reloads the parent snapshot,
  // which recomputes the (derived) safe-cleanup targets — re-running here would
  // reset a "done" dialog back to "review". Read the latest values via a ref.
  const initRef = React.useRef({ targets });
  initRef.current = { targets };

  // Which read the dialog is currently showing. A close/reopen (or a Try again
  // pressed twice) leaves the earlier `cleanupPreview` in flight, and those can
  // land out of order — the stale one must not overwrite the fresh preview, nor
  // drag a settled dialog back to "error".
  const requestRef = React.useRef(0);

  const loadPreview = React.useCallback((): Promise<void> => {
    const { targets: openTargets } = initRef.current;
    const requestId = ++requestRef.current;
    setResult(null);
    setReport(null);
    setError(null);
    setStage("loading");
    setPreview(null);
    return window.ade.storage
      .cleanupPreview(openTargets)
      .then((next) => {
        if (requestRef.current !== requestId) return;
        setPreview(next);
        setStage("review");
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : String(err));
        setErrorPhase("checking");
        setStage("error");
      });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    void loadPreview();
    return () => {
      // A dialog closed mid-read has nothing to show; retire the request so a
      // late answer cannot paint over whatever the next open reads.
      requestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirm = React.useCallback(async () => {
    // Same generation guard the preview uses, for the same reason: a removal
    // (and the maintenance run after it) outlives a close, and a completion
    // that lands after the dialog reopened would push the fresh dialog to
    // "done" and hand the parent a result for a job it is no longer showing.
    const requestId = requestRef.current;
    setStage("removing");
    setError(null);
    try {
      if (!preview) {
        if (requestRef.current === requestId) setStage("review");
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
      if (requestRef.current !== requestId) return;
      setReport(nextReport);
      setResult(next);
      setStage("done");
      onCleaned(next);
      if (nextReport) plan?.onMaintenanceDone?.(nextReport);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
      setErrorPhase("removing");
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

  const footerActions: DialogAction[] =
    stage === "done"
      ? [{ label: "Done", onClick: onClose, variant: "secondary" }]
      : stage === "error"
        ? [
            { label: "Close", onClick: onClose, variant: "secondary" },
            {
              label: "Try again",
              onClick: () => {
                if (errorPhase === "removing" && preview) void confirm();
                else void loadPreview();
              },
              variant: "solid",
            },
          ]
        : [
            { label: "Cancel", onClick: onClose, disabled: stage === "removing", variant: "secondary" },
            {
              label: stage === "removing"
                ? maintenanceMode
                  ? "Cleaning up…"
                  : "Removing…"
                : confirmLabel,
              icon: maintenanceMode ? <Broom size={13} /> : <Trash size={13} />,
              busy: stage === "removing",
              disabled: confirmDisabled,
              onClick: () => void confirm(),
              variant: "solid",
            },
          ];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && stage !== "removing") onClose();
      }}
      title={title}
      description={intro}
      hideClose
      dismissible={stage !== "removing"}
      tone={maintenanceMode || stage === "error" || stage === "done" ? "accent" : "error"}
      width={520}
      maxHeight="min(680px, calc(100vh - 32px))"
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 16 }}
      actions={footerActions}
    >
      {stage === "loading" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
          <CircleNotch size={15} className="animate-spin" />
          Checking what can be safely removed.
        </div>
      ) : null}

      {stage === "error" ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontFamily: SANS_FONT,
            fontSize: 12,
            lineHeight: 1.5,
            color: COLORS.textSecondary,
            background: "color-mix(in srgb, var(--color-error) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-error) 26%, transparent)",
            borderRadius: 9,
            padding: "10px 12px",
          }}
        >
          <span style={{ fontWeight: 600, color: COLORS.danger }}>
            {errorPhase === "checking"
              ? "ADE couldn't check what's safe to remove."
              : "The cleanup didn't finish."}
          </span>
          <span>
            {errorPhase === "checking"
              ? "Nothing was removed. Try again — if it keeps failing, close and reopen ADE, then come back here."
              : "Some items may still be on disk. Nothing outside this list was touched, and you can run it again."}
          </span>
          {error ? (
            <details>
              <summary style={{ cursor: "pointer", userSelect: "none", color: COLORS.textMuted }}>
                Show technical details
              </summary>
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: COLORS.textMuted }}>
                {error}
              </div>
            </details>
          ) : null}
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
    </Dialog>
  );
}
