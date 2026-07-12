import React, { useEffect, useState } from "react";
import { HardDrive } from "@phosphor-icons/react";
import { isUrgentDiskPressure, type DiskPressureSnapshot } from "../../../shared/types/storage";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";

const STORAGE_PRESSURE_SAMPLE_MS = 30_000;
const WARNING_DESCRIPTION = "Storage is running low — ADE and your active projects may create more files while agents work. Click to review ADE storage.";
const CRITICAL_DESCRIPTION = "Your Mac is almost out of storage — ADE paused new agent work to protect your chats and projects. Click to review ADE storage.";

function useStoragePressure(enabled: boolean): DiskPressureSnapshot | null {
  const [snapshot, setSnapshot] = useState<DiskPressureSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }

    let cancelled = false;
    let requestVersion = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const version = ++requestVersion;
      void window.ade.storage.getPressure().then((next) => {
        if (!cancelled && version === requestVersion) setSnapshot(next);
      }).catch(() => {
        if (!cancelled && version === requestVersion) setSnapshot(null);
      });
    };

    refresh();
    const interval = window.setInterval(refresh, STORAGE_PRESSURE_SAMPLE_MS);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled]);

  return snapshot;
}

export function StoragePressureIndicator({ enabled }: { enabled: boolean }) {
  const snapshot = useStoragePressure(enabled);
  if (!snapshot || snapshot.state === "normal") return null;

  const urgent = isUrgentDiskPressure(snapshot.state);
  const color = urgent ? "#F87171" : "#FBBF24";
  const description = urgent ? CRITICAL_DESCRIPTION : WARNING_DESCRIPTION;

  return (
    <SmartTooltip
      forceEnabled
      side="bottom"
      content={{
        label: urgent ? "Storage is critically low" : "Storage is running low",
        description,
      }}
      wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        role="status"
        aria-label={`ADE storage pressure ${snapshot.state}`}
        title={description}
        data-ade-storage-pressure-state={snapshot.state}
        className={cn(
          "ade-shell-control inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md",
          "border transition-[background-color,color,border-color,box-shadow] duration-150",
        )}
        style={{
          color,
          borderColor: `${color}80`,
          background: `${color}1f`,
          boxShadow: urgent
            ? `0 0 0 1px ${color}44, 0 0 20px -6px ${color}`
            : `0 0 0 1px ${color}22, 0 0 16px -10px ${color}`,
          outline: "none",
        }}
        onClick={() => {
          window.location.hash = "#/settings?tab=storage";
        }}
      >
        <HardDrive size={14} weight="fill" />
      </button>
    </SmartTooltip>
  );
}
