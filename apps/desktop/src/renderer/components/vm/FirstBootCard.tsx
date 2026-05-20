import { CaretDown, CaretUp, CheckCircle, Copy, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

export type FirstBootStep = {
  /** 1..6 */
  number: number;
  title: string;
  instruction: string;
  /** Optional inline shell commands the user should run. Rendered with [copy] buttons. */
  shellCommands?: string[];
  /** Optional follow-up recovery note for step 6 (FDA). */
  recovery?: string;
};

export const FIRST_BOOT_STEPS: FirstBootStep[] = [
  {
    number: 1,
    title: "Region",
    instruction: "Choose your region.",
  },
  {
    number: 2,
    title: "Transfer Your Data",
    instruction: 'Click "Set up as new".',
  },
  {
    number: 3,
    title: "Sign In to Apple Account",
    instruction: 'Click "Set Up Later" → "Skip".',
  },
  {
    number: 4,
    title: "Create Mac account",
    instruction: 'Full name "ADE", account "ade", set a local password.',
  },
  {
    number: 5,
    title: "Reach desktop",
    instruction: "Should auto-advance once the account is created.",
  },
  {
    number: 6,
    title: "Enable Remote Login",
    instruction:
      "Open Terminal in the VM and run the command below. If macOS reports Full Disk Access is required, follow the recovery steps.",
    shellCommands: ["sudo systemsetup -setremotelogin on"],
    recovery:
      'If you see "Turning Remote Login on or off requires Full Disk Access privileges": open System Settings → Privacy & Security → Full Disk Access → enable Terminal → reopen Terminal → rerun the command.',
  },
];

const POSITION_STORAGE_KEY = "ade.vm.firstBootCardPosition.v1";

type CardPosition = { right: number; bottom: number };

function loadStoredPosition(): CardPosition | null {
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CardPosition;
    if (typeof parsed?.right !== "number" || typeof parsed?.bottom !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore — fallback could prompt the user, but tests run in jsdom.
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label="Copy command"
      title={copied ? "Copied" : "Copy command"}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-white/10"
      style={{ color: copied ? "var(--color-success, #34d399)" : "#A1A1AA" }}
    >
      {copied ? <CheckCircle size={13} weight="fill" /> : <Copy size={12} weight="regular" />}
    </button>
  );
}

export function FirstBootCard({
  steps,
  currentStepIndex,
  onAdvance,
  onSelectStep,
  onClose,
}: {
  steps: FirstBootStep[];
  /** Zero-based index of the active step in `steps`. */
  currentStepIndex: number;
  onAdvance?: () => void;
  onSelectStep?: (index: number) => void;
  onClose?: () => void;
}) {
  const [position] = useState<CardPosition>(() => loadStoredPosition() ?? { right: 24, bottom: 24 });
  const [showAllSteps, setShowAllSteps] = useState(false);
  const safeIndex = Math.min(Math.max(currentStepIndex, 0), steps.length - 1);
  const currentStep = steps[safeIndex];
  const canAdvance = safeIndex < steps.length - 1;

  return (
    <div
      role="dialog"
      aria-label="macOS first-boot setup steps"
      className="absolute z-30 flex w-[320px] flex-col overflow-hidden rounded-lg text-left shadow-2xl"
      style={{
        right: position.right,
        bottom: position.bottom,
        background: "rgba(12, 10, 16, 0.96)",
        border: "1px solid #2A2535",
        backdropFilter: "blur(6px)",
      }}
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
        <span
          className="font-mono text-[10px] font-bold uppercase tracking-[1px]"
          style={{ color: "#A78BFA" }}
        >
          Step {currentStep.number} of {steps.length}
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide first-boot card"
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/10"
            style={{ color: "#71717A" }}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="px-3 py-3">
        <div className="text-[13px] font-semibold" style={{ color: "#FAFAFA" }}>
          {currentStep.title}
        </div>
        <p className="mt-1 text-[12px] leading-5" style={{ color: "#D4D4D8" }}>
          {currentStep.instruction}
        </p>

        {currentStep.shellCommands?.length ? (
          <div className="mt-3 flex flex-col gap-1.5">
            {currentStep.shellCommands.map((cmd) => (
              <div
                key={cmd}
                className="flex items-center gap-2 rounded-md px-2 py-1.5"
                style={{ background: "#1A1622", border: "1px solid #2A2535" }}
              >
                <code className="flex-1 truncate font-mono text-[11px]" style={{ color: "#E4E4E7" }}>
                  {cmd}
                </code>
                <CopyButton value={cmd} />
              </div>
            ))}
          </div>
        ) : null}

        {currentStep.recovery ? (
          <p className="mt-2 text-[11px] leading-5" style={{ color: "#A1A1AA" }}>
            {currentStep.recovery}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2">
        <button
          type="button"
          onClick={() => setShowAllSteps((value) => !value)}
          aria-expanded={showAllSteps}
          className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[1px]"
          style={{ color: "#A1A1AA" }}
        >
          All {steps.length} steps
          {showAllSteps ? <CaretUp size={10} /> : <CaretDown size={10} />}
        </button>
        <button
          type="button"
          disabled={!canAdvance}
          onClick={onAdvance}
          className="inline-flex h-7 items-center gap-1 rounded-md px-3 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-colors disabled:opacity-40"
          style={{ background: "#A78BFA", color: "#0F0D14" }}
        >
          Next
        </button>
      </div>

      {showAllSteps ? (
        <ol
          className="flex max-h-[180px] flex-col gap-1 overflow-y-auto border-t border-white/[0.06] px-3 py-2"
          style={{ background: "#0A0810" }}
        >
          {steps.map((step, index) => {
            const isDone = index < safeIndex;
            const isCurrent = index === safeIndex;
            return (
              <li key={step.number}>
                <button
                  type="button"
                  onClick={() => onSelectStep?.(index)}
                  className="flex w-full items-start gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-white/5"
                >
                  <span
                    className="mt-[2px] inline-block w-3 shrink-0 text-center font-mono text-[10px] font-bold"
                    style={{ color: isDone ? "var(--color-success, #34d399)" : isCurrent ? "#A78BFA" : "#52525B" }}
                  >
                    {isDone ? "✓" : step.number}
                  </span>
                  <span
                    className="text-[11px] leading-4"
                    style={{ color: isCurrent ? "#FAFAFA" : isDone ? "#A1A1AA" : "#71717A" }}
                  >
                    {step.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
