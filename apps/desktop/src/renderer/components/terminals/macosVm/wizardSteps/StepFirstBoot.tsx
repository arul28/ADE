import { ArrowRight, ArrowSquareOut, CheckCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { MacosVmBaseRecord } from "../../../../../shared/types";

type Props = {
  base: MacosVmBaseRecord | null;
  onFocusWindow: () => void;
  onFinished: () => void;
};

export function StepFirstBoot({ base, onFocusWindow, onFinished }: Props) {
  const running = base?.state === "running";
  const finishedDisabled = !running;

  return (
    <section
      data-testid="wizard-step-firstBoot"
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
          Step 4 of 6
        </span>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          Finish macOS Setup Assistant
        </h2>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--color-muted-fg, #B7B6C3)",
            margin: 0,
          }}
        >
          The VM opened in its own window. Click through Setup Assistant once,
          then come back here to save it as a snapshot.
        </p>
      </header>

      <ol
        className="flex flex-col gap-3"
        role="list"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 16,
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          background: "rgba(255,255,255,0.025)",
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--color-muted-fg, #B7B6C3)",
        }}
      >
        <Tip number={1}>
          <strong style={{ color: "var(--color-fg, #F0F0F2)" }}>Skip Apple ID and iCloud</strong>
          {" "}— this VM is for development; signing in slows clones.
        </Tip>
        <Tip number={2}>
          <strong style={{ color: "var(--color-fg, #F0F0F2)" }}>Skip Touch ID</strong>
          {" "}— virtual machines can&rsquo;t use it.
        </Tip>
        <Tip number={3}>
          <strong style={{ color: "var(--color-fg, #F0F0F2)" }}>Skip FileVault</strong>
          {" "}— keep snapshot clones lean.
        </Tip>
        <Tip number={4}>
          Create a local user (any name and password). Pick a fast colour scheme; you&rsquo;ll
          re-use this image for every lane.
        </Tip>
      </ol>

      <div
        style={{
          padding: 12,
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 10,
          background: "rgba(167, 139, 250, 0.04)",
          fontSize: 12.5,
          color: "var(--color-muted-fg, #B7B6C3)",
        }}
        data-testid="wizard-firstBoot-state"
      >
        {running ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "rgb(110, 231, 183)",
            }}
          >
            <CheckCircle size={13} weight="fill" aria-hidden="true" />
            VM is running. Finish Setup Assistant in the VM window, then click
            “I finished setup” below.
          </span>
        ) : (
          <span>
            VM state: <code>{base?.state ?? "starting"}</code>. Waiting for the
            guest to reach the desktop. If the window didn&rsquo;t appear, click
            “Reopen VM window”.
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          data-testid="wizard-firstBoot-focus"
          onClick={onFocusWindow}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            padding: "8px 12px",
            background: "rgba(255,255,255,0.04)",
            color: "var(--color-fg, #F0F0F2)",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Reopen VM window
          <ArrowSquareOut size={12} weight="bold" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-wizard-primary="true"
          data-testid="wizard-firstBoot-finished"
          disabled={finishedDisabled}
          onClick={onFinished}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            padding: "8px 16px",
            background: finishedDisabled
              ? "rgba(167, 139, 250, 0.35)"
              : "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            border: "1px solid transparent",
            borderRadius: 8,
            cursor: finishedDisabled ? "not-allowed" : "pointer",
            opacity: finishedDisabled ? 0.65 : 1,
          }}
        >
          I finished setup
          <ArrowRight size={13} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function Tip({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        style={{
          flex: "0 0 auto",
          width: 22,
          height: 22,
          borderRadius: 999,
          background: "rgba(167, 139, 250, 0.18)",
          color: "var(--color-accent, #A78BFA)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {number}
      </span>
      <span style={{ flex: 1 }}>{children}</span>
    </li>
  );
}
