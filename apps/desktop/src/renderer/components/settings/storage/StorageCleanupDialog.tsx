import React from "react";
import { CircleNotch, Trash, WarningCircle } from "@phosphor-icons/react";
import type {
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
} from "../../../../shared/types/storage";
import {
  COLORS,
  SANS_FONT,
  outlineButton,
  dangerButton,
} from "../../lanes/laneDesignTokens";
import { formatBytes } from "./storageView";

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
  onClose,
  onCleaned,
}: {
  open: boolean;
  title: string;
  intro?: string;
  targets: StorageCleanupTarget[];
  onClose: () => void;
  onCleaned: (result: StorageCleanupResult) => void;
}) {
  const [stage, setStage] = React.useState<Stage>("loading");
  const [preview, setPreview] = React.useState<StorageCleanupPreview | null>(null);
  const [result, setResult] = React.useState<StorageCleanupResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setStage("loading");
    setPreview(null);
    setResult(null);
    setError(null);
    void window.ade.storage
      .cleanupPreview(targets)
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
  }, [open, targets]);

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
    if (!preview || preview.items.length === 0) return;
    setStage("removing");
    setError(null);
    try {
      const next = await window.ade.storage.cleanup(targets, { preview });
      setResult(next);
      setStage("done");
      onCleaned(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, [preview, targets, onCleaned]);

  if (!open) return null;

  const removableCount = preview?.items.length ?? 0;

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

          {(stage === "review" || stage === "removing") && preview ? (
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
                    <Row key={entry.path} label={baseNameOf(entry.path)} path={entry.path} tone="blocked" reason={entry.reason} />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {stage === "done" && result ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontFamily: SANS_FONT, fontSize: 14, fontWeight: 650, color: COLORS.success }}>
                Freed {formatBytes(result.freedBytes)}.
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
                    <Row key={entry.path} label={baseNameOf(entry.path)} path={entry.path} tone="blocked" reason={entry.reason} />
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
                  ...dangerButton({ height: 34 }),
                  opacity: removableCount === 0 || stage === "removing" || stage === "loading" ? 0.5 : 1,
                  cursor: removableCount === 0 || stage === "removing" || stage === "loading" ? "not-allowed" : "pointer",
                }}
                onClick={() => void confirm()}
                disabled={removableCount === 0 || stage === "removing" || stage === "loading"}
              >
                {stage === "removing" ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <Trash size={14} />
                )}
                {stage === "removing"
                  ? "Removing…"
                  : removableCount > 0
                    ? `Remove ${removableCount === 1 ? "1 item" : `${removableCount} items`}`
                    : "Remove"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function baseNameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
