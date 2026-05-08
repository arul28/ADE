import { useCallback, useEffect, useState } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import type {
  MacosVmContextItem,
  MacosVmEventPayload,
  MacosVmStatus,
} from "../../../shared/types";
import { MacosVmCockpit } from "./macosVm/MacosVmCockpit";
import { MacosVmCrossLaneBanner } from "./macosVm/MacosVmCrossLaneBanner";
import { MacosVmEmpty } from "./macosVm/MacosVmEmpty";
import { MacosVmFailed } from "./macosVm/MacosVmFailed";
import { MacosVmOnboarding } from "./macosVm/MacosVmOnboarding";
import { MacosVmProvisioning } from "./macosVm/MacosVmProvisioning";
import { MacosVmRunningBar } from "./macosVm/MacosVmRunningBar";
import { MacosVmSetupRequired } from "./macosVm/MacosVmSetupRequired";
import { MacosVmTransient } from "./macosVm/MacosVmTransient";
import { ProviderUnavailable } from "./macosVm/ProviderUnavailable";
import { UnsupportedHost } from "./macosVm/UnsupportedHost";

type Props = {
  laneId: string;
  laneRoot: string | null;
  onAddContext?: (item: MacosVmContextItem) => void;
};

export function MacosVmPanel({ laneId, laneRoot, onAddContext }: Props) {
  void laneRoot;
  const [status, setStatus] = useState<MacosVmStatus | null>(null);
  const [resumeWizardAt, setResumeWizardAt] = useState<{ baseName: string | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.ade.macosVm.getStatus({ laneId });
      setStatus(next);
    } catch {
      // Surfaced through individual screens (e.g. ProviderUnavailable's re-check button).
    }
  }, [laneId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      if (event.type === "status") {
        setStatus(event.status);
      } else if (event.type === "vm-updated" && event.vm.laneId === laneId) {
        setStatus((current) =>
          current
            ? {
                ...current,
                laneVm: event.vm,
                vms: current.vms.map((entry) => (entry.laneId === event.vm.laneId ? event.vm : entry)),
              }
            : current,
        );
      } else if (event.type === "base-updated") {
        setStatus((current) => {
          if (!current) return current;
          const exists = current.bases.some((entry) => entry.id === event.base.id);
          const bases = exists
            ? current.bases.map((entry) => (entry.id === event.base.id ? event.base : entry))
            : [...current.bases, event.base];
          const defaultBase = current.defaultBase?.id === event.base.id
            ? event.base
            : current.defaultBase ?? bases.find((entry) => entry.name === "default") ?? bases[0] ?? null;
          return { ...current, bases, defaultBase };
        });
      }
    });
    return unsubscribe;
  }, [laneId, refresh]);

  if (!status) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center text-[12px] text-muted-fg/60">
        <SpinnerGap size={16} className="mr-2 animate-spin" />
        Loading macOS VM status…
      </div>
    );
  }

  if (!status.supported) {
    return <UnsupportedHost status={status} />;
  }

  if (!status.activeProvider.available) {
    return <ProviderUnavailable status={status} onRecheck={refresh} />;
  }

  const readyBases = status.bases.filter((base) => base.state === "ready");
  const baseInSetup = status.bases.find((base) => base.state === "setup_required") ?? null;

  // Mid-flow re-entry: no ready snapshots yet but a base is sitting at Setup Assistant.
  // Drop the user back into the wizard at firstBoot with that base adopted.
  if (readyBases.length === 0 && baseInSetup) {
    return (
      <MacosVmOnboarding
        status={status}
        laneId={laneId}
        onStatusChange={setStatus}
        initialStep="firstBoot"
        initialBaseName={baseInSetup.name}
      />
    );
  }

  const baseInProgress = status.bases.find((base) => base.state === "creating" || base.state === "installing") ?? null;
  if (readyBases.length === 0 && baseInProgress) {
    return (
      <MacosVmOnboarding
        status={status}
        laneId={laneId}
        onStatusChange={setStatus}
        initialStep="install"
        initialBaseName={baseInProgress.name}
      />
    );
  }

  if (readyBases.length === 0) {
    return <MacosVmOnboarding status={status} laneId={laneId} onStatusChange={setStatus} />;
  }

  // Explicit Resume-in-wizard from MacosVmSetupRequired (covers the case where
  // ready snapshots exist but this lane's VM is at Setup Assistant).
  if (resumeWizardAt) {
    return (
      <MacosVmOnboarding
        status={status}
        laneId={laneId}
        onStatusChange={setStatus}
        initialStep="firstBoot"
        initialBaseName={resumeWizardAt.baseName}
      />
    );
  }

  const vm = status.laneVm;
  const laneName = vm?.laneName ?? laneId;

  const overlays = (
    <>
      <MacosVmRunningBar status={status} activeLaneId={laneId} />
      <MacosVmCrossLaneBanner status={status} activeLaneId={laneId} />
    </>
  );

  if (!vm) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        {overlays}
        <MacosVmEmpty status={status} laneId={laneId} laneName={laneName} bases={readyBases} />
      </div>
    );
  }

  let body: JSX.Element;
  switch (vm.state) {
    case "creating":
    case "installing":
      body = (
        <MacosVmProvisioning
          vm={vm}
          onCancel={async () => {
            await window.ade.macosVm.delete({ laneId, force: true });
          }}
        />
      );
      break;
    case "starting":
      body = (
        <MacosVmTransient
          variant="starting"
          laneId={laneId}
          onCancel={async () => {
            await window.ade.macosVm.stop({ laneId, force: true });
          }}
        />
      );
      break;
    case "stopping":
      body = (
        <MacosVmTransient
          variant="stopping"
          laneId={laneId}
        />
      );
      break;
    case "failed":
      body = (
        <MacosVmFailed
          vm={vm}
          onRetryStart={async () => {
            await window.ade.macosVm.start({ laneId, createIfMissing: false, openDisplay: true });
          }}
          onResetToSnapshot={async () => {
            await window.ade.macosVm.delete({ laneId, force: true });
            const baseName = status.defaultBase?.name ?? readyBases[0]?.name;
            if (baseName) {
              await window.ade.macosVm.start({
                laneId,
                fromBase: true,
                baseName,
                createIfMissing: true,
                openDisplay: true,
              });
            }
          }}
          onDelete={async () => {
            await window.ade.macosVm.delete({ laneId, force: true });
          }}
        />
      );
      break;
    case "setup_required":
      body = (
        <MacosVmSetupRequired
          laneId={laneId}
          onResumeWizard={() => setResumeWizardAt({ baseName: vm.name ?? null })}
        />
      );
      break;
    case "stopped":
    case "paused":
    case "running":
      body = (
        <MacosVmCockpit
          status={status}
          vm={vm}
          laneId={laneId}
          bases={status.bases}
          onAddContext={onAddContext}
        />
      );
      break;
    default:
      body = (
        <MacosVmEmpty status={status} laneId={laneId} laneName={laneName} bases={readyBases} />
      );
      break;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {overlays}
      {body}
    </div>
  );
}
