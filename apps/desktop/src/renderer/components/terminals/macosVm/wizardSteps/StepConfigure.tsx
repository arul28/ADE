import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CaretDown,
  CaretRight,
  Cpu,
  HardDrives,
  Memory,
} from "@phosphor-icons/react";
import type { MacosVmHostCapabilities } from "../../../../../shared/types";

export type ConfigureValues = {
  name: string;
  cpuCores: number;
  memory: string;
  diskSize: string;
  display: string;
  ipsw: string;
};

type Props = {
  values: ConfigureValues;
  onChange: (values: ConfigureValues) => void;
  onBack: () => void;
  onContinue: (values: ConfigureValues) => void;
};

const MEMORY_OPTIONS = ["4GB", "6GB", "8GB", "16GB"];
const DISPLAY_OPTIONS = ["1280x800", "1440x900", "1680x1050", "1920x1080", "2560x1440"];
const MIN_DISK_GB = 64;
const MAX_DISK_GB = 256;
const MIN_CPU = 2;
const MAX_CPU = 8;

function diskFromGb(gb: number): string {
  return `${gb}GB`;
}

function diskToGb(value: string): number {
  const m = value.trim().match(/^(\d+)\s*GB$/i);
  if (!m) return MIN_DISK_GB;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return MIN_DISK_GB;
  return Math.min(MAX_DISK_GB, Math.max(MIN_DISK_GB, n));
}

function formatGbExact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const gb = bytes / (1024 ** 3);
  if (gb >= 100) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

export function StepConfigure({ values, onChange, onBack, onContinue }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [host, setHost] = useState<MacosVmHostCapabilities | null>(null);
  const appliedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.ade.macosVm.getHostCapabilities();
        if (cancelled) return;
        setHost(result);
        if (!appliedRef.current) {
          appliedRef.current = true;
          onChange({
            ...values,
            cpuCores: result.recommended.cpuCores,
            memory: result.recommended.memory,
            diskSize: result.recommended.diskSize,
          });
        }
      } catch {
        // Sliders fall back to their declarative defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only run on mount; values change should not retrigger autofill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback(
    (patch: Partial<ConfigureValues>) => {
      onChange({ ...values, ...patch });
    },
    [values, onChange],
  );
  const trimmedName = values.name.trim();
  const continueDisabled = trimmedName.length === 0;

  return (
    <section
      data-testid="wizard-step-configure"
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
          Step 2 of 6
        </span>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          Configure your snapshot
        </h2>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
            margin: 0,
          }}
        >
          We pre-fill values that fit your Mac. You can change them per lane later.
        </p>
      </header>

      <HostRecapCard host={host} />

      <FieldRow
        label="Snapshot name"
        hint="A label you'll see when starting future lane VMs."
        htmlFor="wizard-configure-name"
        sublabel="The name of the saved macOS template that future lane VMs will clone from. e.g. “macOS 26.3 base” or “xcode dev”."
      >
        <input
          id="wizard-configure-name"
          type="text"
          data-testid="wizard-configure-name"
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          spellCheck={false}
          autoCapitalize="off"
          style={inputStyle}
        />
      </FieldRow>

      <FieldRow
        label={`CPU cores · ${values.cpuCores}`}
        hint={`Range ${MIN_CPU}–${MAX_CPU} cores.`}
        htmlFor="wizard-configure-cpu"
        sublabel={
          host
            ? `Your Mac has ${host.cpuCount} cores. We recommend ${host.recommended.cpuCores} (leaves ${Math.max(host.cpuCount - host.recommended.cpuCores, 0)} for the host).`
            : "Apple recommends 4 cores for snappy macOS guests; 2 is the floor."
        }
      >
        <RangeWithMarker
          id="wizard-configure-cpu"
          dataTestId="wizard-configure-cpu"
          min={MIN_CPU}
          max={MAX_CPU}
          step={1}
          value={values.cpuCores}
          recommended={host?.recommended.cpuCores}
          ariaLabel="CPU cores"
          onChange={(v) => set({ cpuCores: v })}
        />
      </FieldRow>

      <FieldRow
        label="Memory"
        hint="More memory helps Xcode and large IDEs."
        sublabel={
          host
            ? `Your Mac has ${formatGbExact(host.memoryBytes)}. We recommend ${host.recommended.memory}. The VM is capped at ~40% of host memory so the host stays responsive — picking a higher chip will block start.`
            : "4 GB is Apple's minimum; 8 GB feels comfortable."
        }
      >
        <div className="flex flex-wrap gap-2" data-testid="wizard-configure-memory" role="group" aria-label="Memory options">
          {MEMORY_OPTIONS.map((opt) => {
            const selected = values.memory === opt;
            const isRecommended = host?.recommended.memory === opt;
            return (
              <button
                type="button"
                key={opt}
                onClick={() => set({ memory: opt })}
                data-selected={selected ? "true" : undefined}
                aria-pressed={selected}
                style={{
                  position: "relative",
                  fontSize: 12.5,
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: selected
                    ? "1px solid rgba(167, 139, 250, 0.55)"
                    : "1px solid rgba(255, 255, 255, 0.12)",
                  background: selected
                    ? "rgba(167, 139, 250, 0.18)"
                    : "rgba(255, 255, 255, 0.03)",
                  color: "var(--color-fg, #F0F0F2)",
                  cursor: "pointer",
                  fontWeight: selected ? 600 : 500,
                }}
              >
                {opt}
                {isRecommended ? (
                  <span
                    aria-label="recommended"
                    style={{
                      marginLeft: 6,
                      fontSize: 9,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--color-accent, #A78BFA)",
                      fontWeight: 700,
                    }}
                  >
                    rec
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </FieldRow>

      <FieldRow
        label={`Disk · ${diskToGb(values.diskSize)} GB`}
        hint={`Range ${MIN_DISK_GB}–${MAX_DISK_GB} GB.`}
        htmlFor="wizard-configure-disk"
        sublabel={
          host
            ? `${formatGbExact(host.freeDiskBytes)} free on your Mac. Recommended: ${host.recommended.diskSize}. The disk image grows on demand, so this is the cap, not the floor — and lane VMs share it via APFS copy-on-write.`
            : "macOS install needs ~30 GB. 64 GB is comfortable; the disk image grows on demand and lane VMs share it via APFS copy-on-write."
        }
      >
        <RangeWithMarker
          id="wizard-configure-disk"
          dataTestId="wizard-configure-disk"
          min={MIN_DISK_GB}
          max={MAX_DISK_GB}
          step={4}
          value={diskToGb(values.diskSize)}
          recommended={
            host ? Number(host.recommended.diskSize.replace(/GB$/i, "")) : undefined
          }
          ariaLabel="Disk size in GB"
          onChange={(v) => set({ diskSize: diskFromGb(v) })}
        />
      </FieldRow>

      <FieldRow label="Display" hint="The size of the VM's main display." htmlFor="wizard-configure-display">
        <select
          id="wizard-configure-display"
          data-testid="wizard-configure-display"
          value={values.display}
          onChange={(e) => set({ display: e.target.value })}
          style={{ ...inputStyle, paddingRight: 28 }}
        >
          {DISPLAY_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </FieldRow>

      <div>
        <button
          type="button"
          data-testid="wizard-configure-advanced-toggle"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            background: "transparent",
            border: "none",
            padding: 0,
            color: "var(--color-muted-fg, #B7B6C3)",
            cursor: "pointer",
          }}
        >
          {advancedOpen ? (
            <CaretDown size={12} weight="bold" aria-hidden="true" />
          ) : (
            <CaretRight size={12} weight="bold" aria-hidden="true" />
          )}
          Advanced
        </button>
        {advancedOpen ? (
          <div className="mt-3" data-testid="wizard-configure-advanced">
            <FieldRow
              label="IPSW source"
              hint="Use “latest” to fetch the current macOS, or paste a path / URL to a .ipsw."
              htmlFor="wizard-configure-ipsw"
            >
              <input
                id="wizard-configure-ipsw"
                type="text"
                data-testid="wizard-configure-ipsw"
                value={values.ipsw}
                onChange={(e) => set({ ipsw: e.target.value })}
                spellCheck={false}
                autoCapitalize="off"
                style={inputStyle}
              />
            </FieldRow>
          </div>
        ) : null}
      </div>

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
          data-testid="wizard-configure-continue"
          disabled={continueDisabled}
          onClick={() => onContinue(values)}
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
          Install macOS
          <ArrowRight size={13} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function HostRecapCard({ host }: { host: MacosVmHostCapabilities | null }) {
  return (
    <div
      data-testid="wizard-configure-host-recap"
      style={{
        display: "flex",
        gap: 14,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid rgba(167, 139, 250, 0.22)",
        background:
          "linear-gradient(180deg, rgba(167,139,250,0.07) 0%, rgba(167,139,250,0.02) 100%)",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--color-accent, #A78BFA)",
          fontWeight: 600,
        }}
      >
        Your Mac
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--color-fg, #F0F0F2)",
          fontWeight: 600,
        }}
      >
        {host?.model ?? "Detecting…"}
      </div>
      <div style={{ display: "flex", gap: 16, marginLeft: "auto", flexWrap: "wrap" }}>
        <Stat icon={<Cpu size={13} aria-hidden="true" />} label="cores" value={host ? `${host.cpuCount}` : "—"} />
        <Stat
          icon={<Memory size={13} aria-hidden="true" />}
          label="memory"
          value={host ? formatGbExact(host.memoryBytes) : "—"}
        />
        <Stat
          icon={<HardDrives size={13} aria-hidden="true" />}
          label="free disk"
          value={host ? formatGbExact(host.freeDiskBytes) : "—"}
        />
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--color-muted-fg, #B7B6C3)",
      }}
    >
      <span style={{ color: "var(--color-accent, #A78BFA)" }}>{icon}</span>
      <span style={{ color: "var(--color-fg, #F0F0F2)", fontWeight: 600 }}>{value}</span>
      <span>{label}</span>
    </div>
  );
}

function RangeWithMarker({
  id,
  dataTestId,
  min,
  max,
  step,
  value,
  recommended,
  ariaLabel,
  onChange,
}: {
  id: string;
  dataTestId: string;
  min: number;
  max: number;
  step: number;
  value: number;
  recommended?: number;
  ariaLabel: string;
  onChange: (next: number) => void;
}) {
  const showMarker =
    typeof recommended === "number" &&
    Number.isFinite(recommended) &&
    recommended >= min &&
    recommended <= max;
  const markerLeft = showMarker
    ? `${((recommended! - min) / (max - min)) * 100}%`
    : "0%";

  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        type="range"
        data-testid={dataTestId}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        style={{ width: "100%", display: "block" }}
      />
      {showMarker ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 22,
            left: markerLeft,
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              width: 1,
              height: 6,
              background: "var(--color-accent, #A78BFA)",
              opacity: 0.8,
            }}
          />
          <span
            style={{
              marginTop: 2,
              fontSize: 9.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-accent, #A78BFA)",
              fontWeight: 700,
            }}
          >
            rec
          </span>
        </div>
      ) : null}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "8px 10px",
  background: "rgba(255,255,255,0.04)",
  color: "var(--color-fg, #F0F0F2)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
};

function FieldRow({
  label,
  hint,
  children,
  htmlFor,
  sublabel,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
  sublabel?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--color-fg, #F0F0F2)",
          }}
        >
          {label}
        </label>
        {hint ? (
          <span
            style={{
              fontSize: 11.5,
              color: "var(--color-muted-fg, #908FA0)",
            }}
          >
            {hint}
          </span>
        ) : null}
      </div>
      {sublabel ? (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--color-muted-fg, #908FA0)",
          }}
        >
          {sublabel}
        </p>
      ) : null}
      {children}
    </div>
  );
}
