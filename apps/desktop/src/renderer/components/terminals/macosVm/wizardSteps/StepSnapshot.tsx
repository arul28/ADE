import { useState } from "react";
import { ArrowLeft, FloppyDisk } from "@phosphor-icons/react";

type Props = {
  defaultName: string;
  onBack: () => void;
  onSave: (name: string) => Promise<void> | void;
};

export function StepSnapshot({ defaultName, onBack, onSave }: Props) {
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const trimmed = name.trim();
  const disabled = trimmed.length === 0 || saving;

  const handleSave = async () => {
    if (disabled) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      data-testid="wizard-step-snapshot"
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
          Step 5 of 6
        </span>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          Save this macOS as a snapshot
        </h2>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
            margin: 0,
          }}
        >
          We&rsquo;ll stop the VM and freeze its disk. Future lane VMs clone
          this snapshot in seconds via APFS copy-on-write.
        </p>
      </header>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="wizard-snapshot-name"
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--color-fg, #F0F0F2)",
          }}
        >
          Snapshot name
        </label>
        <input
          id="wizard-snapshot-name"
          data-testid="wizard-snapshot-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#A78BFA)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-popup-bg,#141022)]"
          style={{
            width: "100%",
            fontSize: 13,
            padding: "8px 10px",
            background: "rgba(255,255,255,0.04)",
            color: "var(--color-fg, #F0F0F2)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
          }}
        />
        <span
          style={{
            fontSize: 11.5,
            color: "var(--color-muted-fg, #908FA0)",
          }}
        >
          A short label like &ldquo;clean macOS 26.3&rdquo;.
        </span>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#A78BFA)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-popup-bg,#141022)]"
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
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back
        </button>
        <button
          type="button"
          data-wizard-primary="true"
          data-testid="wizard-snapshot-save"
          disabled={disabled}
          aria-busy={saving}
          onClick={() => void handleSave()}
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#A78BFA)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-popup-bg,#141022)]"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            padding: "8px 16px",
            background: disabled
              ? "rgba(167, 139, 250, 0.35)"
              : "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            border: "1px solid transparent",
            borderRadius: 8,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.65 : 1,
          }}
        >
          <FloppyDisk size={13} weight="fill" aria-hidden="true" />
          {saving ? "Saving snapshot…" : "Save snapshot"}
        </button>
      </div>
      {saveError ? <div className="text-[11px] text-rose-200/85" role="alert">{saveError}</div> : null}
    </section>
  );
}
