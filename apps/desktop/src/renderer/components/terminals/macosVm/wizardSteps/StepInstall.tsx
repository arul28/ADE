import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  SpinnerGap,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  MacosVmBaseRecord,
  MacosVmEventPayload,
  MacosVmIpswHostProbe,
  MacosVmIpswManifestEntry,
} from "../../../../../shared/types";
import { cn } from "../../../ui/cn";

type Props = {
  base: MacosVmBaseRecord | null;
  baseName: string | null;
  onCancel: () => Promise<void> | void;
  onComplete: () => void;
  onRetry?: (ipswOverride?: string | null) => Promise<void> | void;
};

type LiveProvision = {
  message: string | null;
  progress: number | null;
  stage: string | null;
};

type InstallFailureKind =
  | "software-update-pending"
  | "software-update-apple-gap"
  | "unsigned"
  | "generic";

function metadataRecord(base: MacosVmBaseRecord | null): Record<string, unknown> {
  return base?.metadata && typeof base.metadata === "object" ? base.metadata : {};
}

function readMetadataMessage(base: MacosVmBaseRecord | null): LiveProvision {
  const m = metadataRecord(base);
  const message = typeof m.provisionMessage === "string" ? m.provisionMessage : null;
  const progress = typeof m.provisionProgress === "number" ? m.provisionProgress : null;
  const stage = typeof m.provisionStage === "string" ? m.provisionStage : null;
  return { message, progress, stage };
}

function isHostProbe(value: unknown): value is MacosVmIpswHostProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return "pendingBuild" in record || "currentBuild" in record || "model" in record;
}

function readHostProbe(base: MacosVmBaseRecord | null): MacosVmIpswHostProbe | null {
  const value = metadataRecord(base).ipswHostState;
  return isHostProbe(value) ? value : null;
}

function isManifestEntry(value: unknown): value is MacosVmIpswManifestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.build === "string" &&
    typeof record.productVersion === "string" &&
    typeof record.firmwareUrl === "string" &&
    Array.isArray(record.supportedDeviceModels)
  );
}

function readAlternatives(base: MacosVmBaseRecord | null): MacosVmIpswManifestEntry[] {
  const value = metadataRecord(base).ipswAlternatives;
  return Array.isArray(value) ? value.filter(isManifestEntry) : [];
}

function diagnoseFailure(base: MacosVmBaseRecord | null): {
  kind: InstallFailureKind;
  raw: string;
  pendingVersion: string | null;
} {
  const raw = base?.lastError || readMetadataMessage(base).message || "Install failed.";
  const host = readHostProbe(base);
  if (/software update is required/i.test(raw)) {
    return {
      kind: host?.pendingBuild ? "software-update-pending" : "software-update-apple-gap",
      raw,
      pendingVersion: host?.pendingProductVersion ?? host?.pendingBuild ?? null,
    };
  }
  if (/(not signed|signature|signing|stopped signing|personalize)/i.test(raw)) {
    return { kind: "unsigned", raw, pendingVersion: null };
  }
  return { kind: "generic", raw, pendingVersion: null };
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / (1024 ** 3);
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

export function StepInstall({ base, baseName, onCancel, onComplete, onRetry }: Props) {
  const [live, setLive] = useState<LiveProvision>(() => readMetadataMessage(base));
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLive(readMetadataMessage(base));
  }, [base]);

  useEffect(() => {
    setPhaseStartedAt(Date.now());
  }, [baseName, live.stage]);

  useEffect(() => {
    if (typeof live.progress === "number") return;
    const id = window.setInterval(() => setTick(Date.now()), 1_500);
    return () => window.clearInterval(id);
  }, [live.progress]);

  useEffect(() => {
    if (!baseName) return;
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      if (event.type === "operation" && event.operation === "base-create" && event.vmName === baseName) {
        setLive((current) => {
          const hasProgress = Object.prototype.hasOwnProperty.call(event, "progress");
          return {
            message: event.message ?? current.message,
            progress: hasProgress
              ? typeof event.progress === "number"
                ? event.progress
                : null
              : current.progress,
            stage: event.stage ?? current.stage,
          };
        });
      } else if (event.type === "base-updated" && event.base.name === baseName) {
        setLive(readMetadataMessage(event.base));
      }
    });
    return unsubscribe;
  }, [baseName]);

  const completed =
    base?.state === "ready" ||
    base?.state === "stopped" ||
    base?.state === "setup_required" ||
    (live.stage === "completed" && typeof live.progress === "number" && live.progress >= 1);
  const failed = base?.state === "failed";
  const busy = cancelling || retrying;

  const progressPct = useMemo(() => {
    if (typeof live.progress !== "number") return null;
    return Math.max(0, Math.min(1, live.progress));
  }, [live.progress]);

  const fallbackProgress = useMemo(() => {
    if (progressPct !== null || completed || failed) return null;
    if (live.stage !== "download" && live.stage !== "install" && live.stage !== "queued") return null;
    const duration = live.stage === "install" ? 3 * 60_000 : 5 * 60_000;
    void tick;
    return Math.min(0.85, ((Date.now() - phaseStartedAt) / duration) * 0.85);
  }, [completed, failed, live.stage, phaseStartedAt, progressPct, tick]);

  const displayedProgress = completed ? 1 : progressPct ?? fallbackProgress;

  const stageLabel = useMemo(() => {
    if (failed) return "Install failed";
    if (completed) return "Install complete";
    if (live.stage === "resolve") return "Looking for installer";
    if (live.stage === "download") return "Downloading macOS restore image";
    if (live.stage === "configure") return "Creating the VM bundle";
    if (live.stage === "install") return "Installing macOS VM";
    return "Provisioning";
  }, [completed, failed, live.stage]);

  const failure = useMemo(() => diagnoseFailure(base), [base]);
  const alternatives = useMemo(() => readAlternatives(base), [base]);

  const handleCancel = async () => {
    setCancelling(true);
    setActionError(null);
    try {
      await onCancel();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const retry = async (ipswOverride?: string | null) => {
    if (!onRetry) return;
    setRetrying(true);
    setActionError(null);
    try {
      await onRetry(ipswOverride);
      setShowPicker(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  const chooseIpswFile = async (file: File | null) => {
    if (!file) return;
    const path = window.ade.project.getDroppedPath(file);
    if (!path) {
      setActionError("Could not read that .ipsw file path.");
      return;
    }
    await retry(path);
  };

  return (
    <section
      data-testid="wizard-step-install"
      className="flex flex-col gap-5"
    >
      <header className="flex flex-col gap-2">
        <span
          className="uppercase tracking-[0.16em]"
          style={{
            fontSize: 10.5,
            color: "var(--color-accent, #A78BFA)",
            fontWeight: 600,
          }}
        >
          Step 3 of 6
        </span>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
          }}
        >
          Installing macOS VM
        </h2>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
            margin: 0,
          }}
        >
          ADE picks the right restore image from Apple, builds a bundle, and
          runs the install. Total time is usually 10-25 minutes depending on
          your network.
        </p>
      </header>

      <div
        style={{
          padding: 18,
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          background: "rgba(255,255,255,0.025)",
        }}
      >
        <div className="flex items-center gap-3">
          {failed ? (
            <WarningCircle size={18} weight="fill" color="rgb(252, 165, 165)" aria-hidden="true" />
          ) : (
            <SpinnerGap
              size={18}
              weight="bold"
              color="var(--color-accent, #A78BFA)"
              aria-hidden="true"
              style={{
                animation: completed ? "none" : "ade-spin 1.2s linear infinite",
                opacity: completed ? 0.4 : 1,
              }}
            />
          )}
          <div className="flex-1">
            <div style={{ fontSize: 13, fontWeight: 600 }} role="status" aria-live="polite" aria-atomic="true">{stageLabel}</div>
            <div
              style={{
                marginTop: 2,
                fontSize: 12.5,
                color: "var(--color-muted-fg, #B7B6C3)",
                lineHeight: 1.5,
              }}
              data-testid="wizard-install-message"
              aria-live="polite"
              aria-atomic="true"
            >
              {failed
                ? "Review the recovery options below."
                : live.message || "Starting…"}
            </div>
          </div>
          {displayedProgress !== null ? (
            <div
              style={{
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
                color: "var(--color-muted-fg, #B7B6C3)",
              }}
              data-testid="wizard-install-percent"
            >
              {Math.round(displayedProgress * 100)}%
            </div>
          ) : null}
        </div>

        <div
          style={{
            marginTop: 14,
            height: 6,
            borderRadius: 999,
            background: "rgba(255,255,255,0.06)",
            overflow: "hidden",
          }}
          aria-hidden="true"
        >
          <div
            data-testid="wizard-install-progress"
            style={{
              height: "100%",
              width: `${Math.max(0.02, displayedProgress ?? 0.04) * 100}%`,
              background: failed ? "rgb(248, 113, 113)" : "var(--color-accent, #A78BFA)",
              transition: "width 320ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </div>
      </div>

      {failed ? (
        <FailureCard
          failure={failure}
          alternatives={alternatives}
          retrying={retrying}
          showPicker={showPicker}
          onOpenSoftwareUpdate={() => {
            void window.ade.app.openExternal("x-apple.systempreferences:com.apple.Software-Update-Settings.extension");
          }}
          onRetry={() => void retry("latest")}
          onTogglePicker={() => setShowPicker((value) => !value)}
          onPickVersion={(entry) => void retry(entry.firmwareUrl)}
          onPickFile={() => fileInputRef.current?.click()}
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept=".ipsw"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0] ?? null;
          event.currentTarget.value = "";
          void chooseIpswFile(file);
        }}
      />

      {actionError ? (
        <div role="alert" className="rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100/90">
          {actionError}
        </div>
      ) : null}

      <div className="flex items-end justify-between gap-3">
        <button
          type="button"
          data-testid="wizard-install-cancel"
          onClick={() => void handleCancel()}
          disabled={busy}
          className={cn(
            "inline-flex items-start gap-2 rounded-md border border-white/[0.12] bg-transparent px-3 py-2 text-left text-[12.5px] text-fg transition-colors",
            "hover:border-rose-400/60 hover:text-rose-100",
            "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-white/[0.12]",
          )}
        >
          {cancelling ? <SpinnerGap size={13} className="mt-0.5 animate-spin" aria-hidden="true" /> : <Stop size={13} className="mt-0.5" aria-hidden="true" />}
          <span className="flex flex-col gap-0.5">
            <span>{cancelling ? "Cancelling…" : "Cancel install"}</span>
            <span className="text-[11px] leading-4 text-muted-fg/60">Stops the installer, removes the bundle, frees disk.</span>
          </span>
        </button>
        <button
          type="button"
          data-wizard-primary="true"
          data-testid="wizard-install-continue"
          disabled={!completed || failed || busy}
          onClick={onComplete}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            padding: "8px 16px",
            background:
              !completed || failed || busy
                ? "rgba(167, 139, 250, 0.35)"
                : "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            border: "1px solid transparent",
            borderRadius: 8,
            cursor: !completed || failed || busy ? "not-allowed" : "pointer",
            opacity: !completed || failed || busy ? 0.65 : 1,
          }}
        >
          Continue to first boot
          <ArrowRight size={13} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function FailureCard({
  failure,
  alternatives,
  retrying,
  showPicker,
  onOpenSoftwareUpdate,
  onRetry,
  onTogglePicker,
  onPickVersion,
  onPickFile,
}: {
  failure: ReturnType<typeof diagnoseFailure>;
  alternatives: MacosVmIpswManifestEntry[];
  retrying: boolean;
  showPicker: boolean;
  onOpenSoftwareUpdate: () => void;
  onRetry: () => void;
  onTogglePicker: () => void;
  onPickVersion: (entry: MacosVmIpswManifestEntry) => void;
  onPickFile: () => void;
}) {
  const copy = (() => {
    switch (failure.kind) {
      case "software-update-pending":
        return `Your Mac has a macOS update waiting${failure.pendingVersion ? ` (${failure.pendingVersion})` : ""}. Install it from System Settings > Software Update, then click Retry.`;
      case "software-update-apple-gap":
        return "Apple is between releases right now. The current installer does not match your Mac's internal state. Try again in a few hours, or pick a specific macOS version.";
      case "unsigned":
        return "Apple stopped signing this macOS version. ADE will pick a newer one.";
      default:
        return "The install failed before macOS finished writing the VM disk.";
    }
  })();

  return (
    <div data-testid="wizard-install-failure-card" className="rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-3 text-[12px] text-rose-50/90">
      <div className="flex items-start gap-2">
        <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Install needs attention</div>
          <div className="mt-1 leading-5 text-rose-50/80">{copy}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {failure.kind === "software-update-pending" ? (
              <button
                type="button"
                className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
                data-variant="ghost"
                onClick={onOpenSoftwareUpdate}
              >
                Open Software Update
              </button>
            ) : null}
            <button
              type="button"
              className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
              data-variant="ghost"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowClockwise size={11} />}
              {failure.kind === "unsigned" ? "Pick newer installer" : "Retry"}
            </button>
            {failure.kind === "software-update-apple-gap" || failure.kind === "generic" ? (
              <button
                type="button"
                className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
                data-variant="ghost"
                onClick={onTogglePicker}
                disabled={retrying || alternatives.length === 0}
              >
                <CaretDown size={11} />
                Try a different macOS version
              </button>
            ) : null}
          </div>
          {showPicker ? (
            <div className="mt-3 rounded-md border border-white/[0.08] bg-black/20 p-2">
              <div className="max-h-48 overflow-y-auto">
                {alternatives.map((entry) => {
                  const size = formatBytes(entry.sizeBytes);
                  return (
                    <button
                      key={`${entry.build}:${entry.firmwareUrl}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-[11px] text-fg/85 hover:bg-white/[0.06]"
                      onClick={() => onPickVersion(entry)}
                    >
                      <span>macOS {entry.productVersion} ({entry.build})</span>
                      {size ? <span className="shrink-0 text-muted-fg/55">{size}</span> : null}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="mt-2 text-[11px] text-muted-fg/70 underline-offset-2 hover:text-fg hover:underline"
                onClick={onPickFile}
              >
                Have a .ipsw file?
              </button>
            </div>
          ) : null}
          {failure.kind === "generic" ? (
            <details className="mt-3 text-[11px] text-rose-50/70">
              <summary className="cursor-pointer">Error details</summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 font-mono text-[10px] leading-4">
                {failure.raw}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
