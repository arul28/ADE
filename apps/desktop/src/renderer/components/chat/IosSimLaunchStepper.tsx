import { CheckCircle, Circle, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { IosSimulatorLaunchProgress } from "../../../shared/types";
import { cn } from "../ui/cn";
import { formatElapsed, pathTail } from "./iosSimContracts";

export const IOS_SIM_LAUNCH_STEP_ORDER: IosSimulatorLaunchProgress["step"][] = [
  "resolve-device",
  "boot-simulator",
  "open-simulator",
  "resolve-target",
  "build-app",
  "install-app",
  "launch-app",
  "ready",
];

const STEP_LABEL: Record<string, string> = {
  "resolve-device": "Device",
  "boot-simulator": "Boot",
  "open-simulator": "Open Simulator",
  "resolve-target": "Target",
  "build-app": "Build",
  "install-app": "Install",
  "launch-app": "Launch",
  ready: "Ready",
};

/**
 * The build root is only authoritative once the launch resolves, but the whole
 * point of showing it is to catch a wrong-checkout build *while it runs*. The
 * host already names the root in the build step's own copy, so fall back to
 * that mid-flight. Fail-soft: no match just means no chip.
 */
function buildRootLabel(step: IosSimulatorLaunchProgress, buildRoot: string | null): string | null {
  if (buildRoot) return pathTail(buildRoot);
  const running = /Building iOS app in (.+?)\.\.\.\s*$/u.exec(step.message);
  if (running?.[1]) return running[1];
  const complete = /root (.+)$/u.exec(step.detail ?? "");
  return complete?.[1] ?? null;
}

/** Newest progress row per step for the most recent launch, in canonical order. */
export function selectLaunchSteps(progress: IosSimulatorLaunchProgress[]): IosSimulatorLaunchProgress[] {
  const latestLaunchId = progress.length ? progress[progress.length - 1]?.launchId ?? null : null;
  if (!latestLaunchId) return [];
  return IOS_SIM_LAUNCH_STEP_ORDER
    .map((step) => progress.find((item) => item.launchId === latestLaunchId && item.step === step))
    .filter((item): item is IosSimulatorLaunchProgress => Boolean(item));
}

type IosSimLaunchStepperProps = {
  steps: IosSimulatorLaunchProgress[];
  /** Absolute build output root, so a wrong-worktree build is visible at a glance. */
  buildRoot: string | null;
  /** True when the launch reused an already-installed app instead of building. */
  usedInstalledBinary: boolean;
  now: number;
};

/**
 * Slim stepper. The running step carries elapsed time; the build step also
 * carries the tail of its output root because "built the wrong checkout" is the
 * failure mode that otherwise looks identical to a slow build.
 */
export function IosSimLaunchStepper({ steps, buildRoot, usedInstalledBinary, now }: IosSimLaunchStepperProps) {
  return (
    <div className="flex h-full min-h-[300px] flex-col justify-center gap-2 px-5 py-4">
      <div className="flex items-center gap-2">
        <div className="font-sans text-[11px] font-medium uppercase tracking-wider text-muted-fg/60">Launching</div>
        {usedInstalledBinary ? (
          <span className="inline-flex h-5 items-center rounded-full border border-amber-300/24 bg-amber-400/[0.09] px-2 font-sans text-[10px] font-medium text-amber-50/85">
            prebuilt — changes not included
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">
        {steps.map((step, index) => {
          const running = step.status === "running";
          const failed = step.status === "failed";
          const done = step.status === "complete" || step.status === "skipped";
          const startedAt = Date.parse(step.updatedAt);
          const elapsed = running && Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : null;
          const buildRootTail = step.step === "build-app" ? buildRootLabel(step, buildRoot) : null;
          return (
            <div key={`${step.launchId}:${step.step}`} className="flex items-start gap-2">
              <div className="flex flex-col items-center self-stretch">
                {done ? (
                  <CheckCircle size={13} weight="fill" className="mt-1 shrink-0 text-emerald-300/85" />
                ) : failed ? (
                  <WarningCircle size={13} weight="fill" className="mt-1 shrink-0 text-rose-300/85" />
                ) : running ? (
                  <SpinnerGap size={13} className="mt-1 shrink-0 animate-spin text-cyan-200/90" />
                ) : (
                  <Circle size={13} className="mt-1 shrink-0 text-muted-fg/30" />
                )}
                {index < steps.length - 1 ? (
                  <div className={cn("w-px flex-1", done ? "bg-emerald-300/25" : "bg-white/[0.07]")} />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 pb-2">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "font-sans text-[11px]",
                      failed ? "font-medium text-rose-100/90" : running ? "font-medium text-fg/88" : done ? "text-fg/62" : "text-muted-fg/45",
                    )}
                    title={step.message}
                  >
                    {STEP_LABEL[step.step] ?? step.message}
                  </span>
                  {elapsed ? (
                    <span className="font-sans text-[10px] tabular-nums text-cyan-100/70">{elapsed}</span>
                  ) : null}
                  {buildRootTail ? (
                    <code
                      className="min-w-0 truncate font-mono text-[10px] text-muted-fg/55"
                      title={buildRoot ?? step.message}
                    >
                      {buildRootTail}
                    </code>
                  ) : null}
                </div>
                {failed && step.detail ? (
                  <div className="mt-0.5 line-clamp-2 font-sans text-[10px] leading-4 text-rose-100/60">{step.detail}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
