import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MacosVmBaseRecord,
  MacosVmEventPayload,
  MacosVmStatus,
} from "../../../../shared/types";
import { defaultSnapshotName } from "./snapshotNaming";
import { StepWelcome } from "./wizardSteps/StepWelcome";
import { StepSystemCheck } from "./wizardSteps/StepSystemCheck";
import { StepConfigure, type ConfigureValues } from "./wizardSteps/StepConfigure";
import { StepInstall } from "./wizardSteps/StepInstall";
import { StepFirstBoot } from "./wizardSteps/StepFirstBoot";
import { StepSnapshot } from "./wizardSteps/StepSnapshot";
import { StepDone } from "./wizardSteps/StepDone";

export type WizardStepId =
  | "welcome"
  | "systemCheck"
  | "configure"
  | "install"
  | "firstBoot"
  | "snapshot"
  | "done";

export const WIZARD_STEPS: { id: WizardStepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "systemCheck", label: "System check" },
  { id: "configure", label: "Configure" },
  { id: "install", label: "Install" },
  { id: "firstBoot", label: "First boot" },
  { id: "snapshot", label: "Save snapshot" },
  { id: "done", label: "Done" },
];

const DEFAULT_CONFIGURE: ConfigureValues = {
  name: "macOS 26.3",
  cpuCores: 2,
  memory: "4GB",
  diskSize: "64GB",
  display: "1440x900",
  ipsw: "latest",
};

type Props = {
  status: MacosVmStatus;
  laneId: string;
  onStatusChange?: (next: MacosVmStatus) => void;
  initialStep?: WizardStepId;
  initialBaseName?: string | null;
};

function findBaseByName(status: MacosVmStatus, name: string | null): MacosVmBaseRecord | null {
  if (!name) return null;
  return status.bases.find((b) => b.name === name) ?? null;
}

function stepIndexFor(id: WizardStepId | undefined): number {
  if (!id) return 0;
  const idx = WIZARD_STEPS.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : 0;
}

export function MacosVmOnboarding({ status, laneId, onStatusChange, initialStep, initialBaseName }: Props) {
  const [stepIndex, setStepIndex] = useState(() => stepIndexFor(initialStep));
  const [configure, setConfigure] = useState<ConfigureValues>(DEFAULT_CONFIGURE);
  const [activeBaseName, setActiveBaseName] = useState<string | null>(initialBaseName ?? null);
  const [snapshotName, setSnapshotName] = useState<string>(() => defaultSnapshotName(status));
  const [liveStatus, setLiveStatus] = useState<MacosVmStatus>(status);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLiveStatus(status);
  }, [status]);

  useEffect(() => {
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      if (event.type === "status") {
        setLiveStatus(event.status);
        onStatusChange?.(event.status);
      } else if (event.type === "base-updated") {
        setLiveStatus((current) => {
          const exists = current.bases.some((entry) => entry.id === event.base.id);
          const bases = exists
            ? current.bases.map((entry) => (entry.id === event.base.id ? event.base : entry))
            : [...current.bases, event.base];
          return { ...current, bases };
        });
      }
    });
    return unsubscribe;
  }, [onStatusChange]);

  const activeBase = useMemo(
    () => findBaseByName(liveStatus, activeBaseName),
    [liveStatus, activeBaseName],
  );

  const step = WIZARD_STEPS[stepIndex];

  const goNext = useCallback(() => {
    setStepIndex((i) => Math.min(WIZARD_STEPS.length - 1, i + 1));
    setError(null);
  }, []);
  const goBack = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
    setError(null);
  }, []);
  const goTo = useCallback((id: WizardStepId) => {
    const idx = WIZARD_STEPS.findIndex((s) => s.id === id);
    if (idx >= 0) {
      setStepIndex(idx);
      setError(null);
    }
  }, []);

  const handleStartInstall = useCallback(
    async (values: ConfigureValues, options: { force?: boolean; ipswOverride?: string | null } = {}) => {
      setError(null);
      const nextValues = { ...values, ipsw: options.ipswOverride ?? values.ipsw };
      setConfigure(nextValues);
      try {
        const base = await window.ade.macosVm.createBase({
          name: activeBaseName ?? nextValues.name,
          cpuCores: nextValues.cpuCores,
          memory: nextValues.memory,
          diskSize: nextValues.diskSize,
          display: nextValues.display,
          ipsw: nextValues.ipsw || "latest",
          force: options.force ?? undefined,
        });
        setActiveBaseName(base.name);
        goTo("install");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeBaseName, goTo],
  );

  const handleRetryInstall = useCallback(
    async (ipswOverride?: string | null) => {
      await handleStartInstall(configure, { force: true, ipswOverride: ipswOverride ?? "latest" });
    },
    [configure, handleStartInstall],
  );

  const handleCancelInstall = useCallback(async () => {
    if (!activeBaseName) {
      goTo("configure");
      return;
    }
    try {
      await window.ade.macosVm.deleteBase({ name: activeBaseName, force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setActiveBaseName(null);
    goTo("configure");
  }, [activeBaseName, goTo]);

  const handleInstallComplete = useCallback(async () => {
    if (!activeBaseName) return;
    try {
      await window.ade.macosVm.startBase({ name: activeBaseName, openDisplay: true });
      goTo("firstBoot");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeBaseName, goTo]);

  const handleFocusBaseWindow = useCallback(async () => {
    if (!activeBaseName) return;
    try {
      await window.ade.macosVm.focusBaseWindow({ name: activeBaseName });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeBaseName]);

  const handleFinishedSetup = useCallback(() => {
    setSnapshotName((current) => current || defaultSnapshotName(liveStatus));
    goTo("snapshot");
  }, [goTo, liveStatus]);

  const handleSaveSnapshot = useCallback(
    async (chosenName: string) => {
      if (!activeBaseName) return;
      setError(null);
      const targetName = chosenName.trim() || snapshotName || activeBaseName;
      try {
        await window.ade.macosVm.stopBase({ name: activeBaseName });
        let finalName = activeBaseName;
        let renamedName: string | null = null;
        if (targetName !== activeBaseName) {
          const renamed = await window.ade.macosVm.renameBase({
            from: activeBaseName,
            to: targetName,
          });
          finalName = renamed.name;
          renamedName = renamed.name;
        }
        await window.ade.macosVm.markBaseReady({ name: finalName });
        if (renamedName) setActiveBaseName(renamedName);
        setSnapshotName(targetName);
        goTo("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeBaseName, goTo, snapshotName],
  );

  const handleOpenLaneVm = useCallback(async () => {
    if (!activeBaseName) return;
    try {
      await window.ade.macosVm.start({
        laneId,
        fromBase: true,
        baseName: activeBaseName,
        createIfMissing: true,
        openDisplay: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeBaseName, laneId]);

  let body: React.ReactNode = null;
  switch (step.id) {
    case "welcome":
      body = <StepWelcome onContinue={goNext} />;
      break;
    case "systemCheck":
      body = (
        <StepSystemCheck
          status={liveStatus}
          laneId={laneId}
          onBack={goBack}
          onContinue={goNext}
        />
      );
      break;
    case "configure":
      body = (
        <StepConfigure
          values={configure}
          onChange={setConfigure}
          onBack={goBack}
          onContinue={handleStartInstall}
        />
      );
      break;
    case "install":
      body = (
        <StepInstall
          base={activeBase}
          baseName={activeBaseName}
          onCancel={handleCancelInstall}
          onComplete={handleInstallComplete}
          onRetry={handleRetryInstall}
        />
      );
      break;
    case "firstBoot":
      body = (
        <StepFirstBoot
          base={activeBase}
          onFocusWindow={handleFocusBaseWindow}
          onFinished={handleFinishedSetup}
        />
      );
      break;
    case "snapshot":
      body = (
        <StepSnapshot
          defaultName={snapshotName}
          onBack={goBack}
          onSave={handleSaveSnapshot}
        />
      );
      break;
    case "done":
      body = (
        <StepDone
          baseName={activeBaseName}
          snapshotName={snapshotName}
          onOpen={handleOpenLaneVm}
        />
      );
      break;
  }

  return (
    <div
      data-testid="macos-vm-onboarding"
      className="flex h-full w-full flex-col"
      style={{
        background:
          "radial-gradient(120% 140% at 0% 0%, rgba(167, 139, 250, 0.08), transparent 55%), var(--color-popup-bg, #141022)",
        color: "var(--color-fg, #F0F0F2)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <ProgressDots activeIndex={stepIndex} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-10">
          {error ? (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-100/90"
            >
              {error}
            </div>
          ) : null}
          {body}
        </div>
      </div>
    </div>
  );
}

function ProgressDots({ activeIndex }: { activeIndex: number }) {
  return (
    <div
      className="flex items-center justify-center gap-1.5 border-b border-white/[0.06] py-3"
      role="progressbar"
      aria-label="Wizard progress"
      aria-valuenow={activeIndex + 1}
      aria-valuemin={1}
      aria-valuemax={WIZARD_STEPS.length}
    >
      {WIZARD_STEPS.map((step, index) => {
        const completed = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div
            key={step.id}
            data-testid={`wizard-dot-${step.id}`}
            data-active={active ? "true" : undefined}
            data-completed={completed ? "true" : undefined}
            aria-label={step.label}
            style={{
              width: active ? 22 : 8,
              height: 8,
              borderRadius: 999,
              background: active
                ? "var(--color-accent, #A78BFA)"
                : completed
                  ? "rgba(167, 139, 250, 0.5)"
                  : "rgba(255, 255, 255, 0.14)",
              transition: "all 240ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        );
      })}
    </div>
  );
}
