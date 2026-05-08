import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  WarningCircle,
  XCircle,
  ArrowSquareOut,
  ArrowRight,
  ArrowLeft,
} from "@phosphor-icons/react";
import type {
  MacosVmHostCapabilities,
  MacosVmScreenRecordingProbeResult,
  MacosVmStatus,
} from "../../../../../shared/types";
import { openExternalUrl } from "../../../../lib/openExternal";

type CheckTone = "ok" | "warn" | "fail" | "pending";

type CheckRow = {
  id: string;
  label: string;
  detail: string;
  tone: CheckTone;
  required: boolean;
  link?: { label: string; href: string };
  body?: React.ReactNode;
};

type Props = {
  status: MacosVmStatus;
  laneId: string;
  onBack: () => void;
  onContinue: () => void;
};

function compareMacOsAtLeast(version: string, atLeast: { major: number }): boolean | null {
  const m = version.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  if (Number.isNaN(major)) return null;
  return major >= atLeast.major;
}

function detectVirtioFsBuggyHost(version: string): boolean {
  return /^14\.2(\.|$)/.test(version);
}

function formatGb(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const gb = bytes / (1024 ** 3);
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 10) return `${gb.toFixed(0)} GB`;
  return `${gb.toFixed(1)} GB`;
}

// IPSW download for macOS 14–26 typically lands between ~5 and ~16 GB. We pick a
// conservative midpoint for the "expected total" calculation so the warning
// thresholds are honest rather than alarming.
const EXPECTED_IPSW_GB = 12;
const EXPECTED_INSTALLED_GB = 30;
const EXPECTED_TOTAL_GB = EXPECTED_IPSW_GB + EXPECTED_INSTALLED_GB;

export function StepSystemCheck({ status, onBack, onContinue }: Props) {
  const [screenRecording, setScreenRecording] =
    useState<MacosVmScreenRecordingProbeResult>({
      status: "unknown",
      detail: "Checking Screen Recording permission…",
    });
  const [host, setHost] = useState<MacosVmHostCapabilities | null>(null);
  const [overrideWarnings, setOverrideWarnings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.ade.macosVm.getScreenRecordingStatus();
        if (cancelled) return;
        setScreenRecording(result);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setScreenRecording({ status: "unknown", detail: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.ade.macosVm.getHostCapabilities();
        if (cancelled) return;
        setHost(result);
      } catch {
        // Disk-space row gracefully degrades to a static estimate.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo<CheckRow[]>(() => {
    const out: CheckRow[] = [];

    const isAppleSilicon = status.arch === "arm64" && status.platform === "darwin";
    out.push({
      id: "arch",
      label: "Apple silicon Mac",
      detail: isAppleSilicon
        ? `Detected ${status.platform}/${status.arch}.`
        : `Detected ${status.platform}/${status.arch}. Apple's Virtualization framework only runs macOS guests on Apple silicon.`,
      tone: isAppleSilicon ? "ok" : "fail",
      required: true,
    });

    const providerVersion = status.activeProvider.version ?? "";
    const macOk = compareMacOsAtLeast(providerVersion, { major: 13 });
    out.push({
      id: "host-os",
      label: "macOS 13 Ventura or later",
      detail:
        macOk === null
          ? "Could not determine host macOS version. Check the helper detail below."
          : macOk
            ? `Host reports ${providerVersion || "macOS 13+"}. VirtioFS shared folders are supported.`
            : `Host reports ${providerVersion}. macOS 13 is required for VirtioFS auto-mount.`,
      tone: macOk === null ? "warn" : macOk ? "ok" : "fail",
      required: macOk !== true && macOk !== null,
      link: {
        label: "Apple docs",
        href: status.docs.appleVirtualization,
      },
    });

    const providerOk = status.supported && status.activeProvider.available;
    out.push({
      id: "provider",
      label: "Virtualization helper installed",
      detail: providerOk
        ? "Apple Virtualization helper is available."
        : status.activeProvider.detail || "Helper is not available.",
      tone: providerOk ? "ok" : "fail",
      required: true,
      link: {
        label: "Setup docs",
        href: status.activeProvider.docsUrl || status.docs.appleVirtualization,
      },
    });

    if (providerVersion && detectVirtioFsBuggyHost(providerVersion)) {
      out.push({
        id: "virtiofs-bug",
        label: "VirtioFS share quirk on macOS 14.2.x",
        detail:
          "On macOS 14.2 / 14.2.1 hosts, the guest shared folder can disappear after wake. Workaround: re-mount inside the VM, or upgrade the host.",
        tone: "warn",
        required: false,
      });
    }

    const sr = screenRecording.status;
    const srTone: CheckTone =
      sr === "granted"
        ? "ok"
        : sr === "denied" || sr === "restricted"
          ? "fail"
          : sr === "not-determined"
            ? "warn"
            : "pending";
    out.push({
      id: "screen-recording",
      label: "Screen Recording permission",
      detail: screenRecording.detail,
      tone: srTone,
      required: srTone === "fail",
      link:
        srTone === "fail"
          ? {
              label: "Open System Settings",
              href: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            }
          : undefined,
    });

    const freeGb =
      host && host.freeDiskBytes > 0 ? host.freeDiskBytes / (1024 ** 3) : null;
    const diskTone: CheckTone =
      freeGb == null
        ? "warn"
        : freeGb < EXPECTED_TOTAL_GB
          ? "fail"
          : freeGb < EXPECTED_TOTAL_GB + 30
            ? "warn"
            : "ok";

    const diskDetail = (() => {
      if (freeGb == null) {
        return "We couldn't read your free disk space. Make sure you have at least ~45 GB free for the IPSW download and the installed macOS.";
      }
      const head =
        diskTone === "ok"
          ? `${formatGb(host?.freeDiskBytes ?? null)} free — plenty of room.`
          : diskTone === "warn"
            ? `${formatGb(host?.freeDiskBytes ?? null)} free — should be enough, but it'll be tight.`
            : `${formatGb(host?.freeDiskBytes ?? null)} free — not enough for a clean install. Free up at least ${Math.ceil(EXPECTED_TOTAL_GB - freeGb)} GB.`;
      return head;
    })();

    out.push({
      id: "free-disk",
      label: "Free disk space",
      detail: diskDetail,
      tone: diskTone,
      required: diskTone === "fail",
      body: (
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "120px 1fr",
            rowGap: 4,
            columnGap: 12,
            fontSize: 11.5,
            color: "var(--color-muted-fg, #908FA0)",
          }}
        >
          <span>macOS installer</span>
          <span>~5–16 GB to download (cached after first install)</span>
          <span>Installed macOS</span>
          <span>~25–30 GB on disk</span>
          <span>Disk size cap</span>
          <span>You set 64–256 GB next; only used as the guest writes</span>
          <span>Each lane VM</span>
          <span>Near-zero extra space (APFS clones share data with the snapshot)</span>
        </div>
      ),
    });

    return out;
  }, [status, screenRecording, host]);

  const failingRequired = rows.some(
    (row) => row.required && (row.tone === "fail" || row.tone === "pending"),
  );
  const hasWarnings = rows.some((row) => row.tone === "warn");
  const continueDisabled =
    failingRequired || (hasWarnings && !overrideWarnings);

  return (
    <section
      data-testid="wizard-step-systemCheck"
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
          Step 1 of 6
        </span>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          Make sure your Mac can run a macOS VM
        </h2>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
            margin: 0,
          }}
        >
          A few quick checks. Required items must pass before you continue.
        </p>
      </header>

      <ul
        className="flex flex-col gap-2"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        {rows.map((row) => (
          <CheckRowItem key={row.id} row={row} />
        ))}
      </ul>

      {hasWarnings ? (
        <label
          className="flex items-center gap-2 select-none"
          style={{
            fontSize: 12.5,
            color: "var(--color-muted-fg, #B7B6C3)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            data-testid="wizard-systemCheck-override"
            checked={overrideWarnings}
            onChange={(e) => setOverrideWarnings(e.target.checked)}
          />
          I&rsquo;ve read the warnings, continue anyway.
        </label>
      ) : null}

      <Footer
        onBack={onBack}
        onContinue={onContinue}
        continueDisabled={continueDisabled}
      />
    </section>
  );
}

function CheckRowItem({ row }: { row: CheckRow }) {
  const Icon =
    row.tone === "ok"
      ? CheckCircle
      : row.tone === "warn"
        ? WarningCircle
        : row.tone === "fail"
          ? XCircle
          : WarningCircle;
  const color =
    row.tone === "ok"
      ? "rgb(110, 231, 183)"
      : row.tone === "warn"
        ? "rgb(252, 211, 77)"
        : row.tone === "fail"
          ? "rgb(252, 165, 165)"
          : "rgb(180, 180, 200)";
  return (
    <li
      data-testid={`wizard-check-${row.id}`}
      data-tone={row.tone}
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 12px",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        background: "rgba(255,255,255,0.025)",
      }}
    >
      <Icon size={18} weight="fill" color={color} aria-hidden="true" />
      <div className="flex-1">
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-fg, #F0F0F2)" }}>
          {row.label}
          {row.required ? (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 600,
                color: "var(--color-muted-fg, #908FA0)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              required
            </span>
          ) : null}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
          }}
        >
          {row.detail}
        </div>
        {row.body ? row.body : null}
        {row.link ? (
          <button
            type="button"
            onClick={() => openExternalUrl(row.link!.href)}
            className="ade-stt-doc"
            style={{
              marginTop: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              color: "var(--color-accent, #A78BFA)",
            }}
          >
            {row.link.label}
            <ArrowSquareOut size={11} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

function Footer({
  onBack,
  onContinue,
  continueDisabled,
}: {
  onBack: () => void;
  onContinue: () => void;
  continueDisabled: boolean;
}) {
  return (
    <div className="mt-2 flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          padding: "8px 12px",
          background: "transparent",
          color: "var(--color-fg, #F0F0F2)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Back
      </button>
      <button
        type="button"
        data-wizard-primary="true"
        data-testid="wizard-systemCheck-continue"
        disabled={continueDisabled}
        onClick={onContinue}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          fontWeight: 600,
          padding: "8px 16px",
          background: continueDisabled
            ? "rgba(167, 139, 250, 0.35)"
            : "var(--color-accent, #A78BFA)",
          color: "var(--color-accent-fg, #0B0620)",
          border: "1px solid transparent",
          borderRadius: 8,
          cursor: continueDisabled ? "not-allowed" : "pointer",
          opacity: continueDisabled ? 0.65 : 1,
        }}
      >
        Continue
        <ArrowRight size={13} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
