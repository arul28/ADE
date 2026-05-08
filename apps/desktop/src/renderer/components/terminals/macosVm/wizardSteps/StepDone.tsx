import { useState } from "react";
import { CheckCircle, Play } from "@phosphor-icons/react";

type Props = {
  baseName: string | null;
  snapshotName: string | null;
  onOpen: () => Promise<void> | void;
};

export function StepDone({ baseName, snapshotName, onOpen }: Props) {
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const handleOpen = async () => {
    if (busy) return;
    setBusy(true);
    setOpenError(null);
    try {
      await onOpen();
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="wizard-step-done"
      className="flex flex-col items-center gap-6 text-center"
    >
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          borderRadius: 999,
          background: "rgba(110, 231, 183, 0.18)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CheckCircle size={36} weight="fill" color="rgb(110, 231, 183)" />
      </div>
      <span
        className="uppercase tracking-[0.16em]"
        style={{
          fontSize: 10.5,
          color: "var(--color-accent, #A78BFA)",
          fontWeight: 600,
        }}
      >
        Step 6 of 6
      </span>
      <h2
        style={{
          fontSize: 24,
          fontWeight: 700,
          margin: 0,
          letterSpacing: "-0.01em",
        }}
      >
        Snapshot saved
      </h2>
      <p
        className="max-w-[460px]"
        style={{
          fontSize: 13.5,
          lineHeight: 1.6,
          color: "var(--color-muted-fg, #B7B6C3)",
          margin: 0,
        }}
      >
        <strong style={{ color: "var(--color-fg, #F0F0F2)" }}>
          {snapshotName || baseName || "Your snapshot"}
        </strong>{" "}
        is ready. New lane VMs clone it via APFS copy-on-write, so they spin up
        almost instantly.
      </p>
      <span style={{ cursor: busy ? "not-allowed" : "pointer" }}>
        <button
          type="button"
          data-wizard-primary="true"
          data-testid="wizard-done-open"
          onClick={() => void handleOpen()}
          disabled={busy}
          aria-busy={busy}
          aria-label={busy ? "Opening VM, please wait" : "Open VM for this lane"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
            padding: "9px 18px",
            background: "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            border: "1px solid transparent",
            borderRadius: 8,
            cursor: "inherit",
            opacity: busy ? 0.7 : 1,
            boxShadow: "0 4px 14px -4px rgba(167, 139, 250, 0.55)",
          }}
        >
          <Play size={14} weight="fill" aria-hidden="true" />
          {busy ? "Opening VM…" : "Open VM for this lane"}
        </button>
      </span>
      {openError ? <div className="text-[11px] text-rose-200/85" role="alert">{openError}</div> : null}
    </section>
  );
}
