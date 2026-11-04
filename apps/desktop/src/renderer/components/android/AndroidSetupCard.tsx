import { Check, X } from "@phosphor-icons/react";
import type { AndroidSdkStatus } from "../../../shared/types/androidEmulator";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { androidSdkTool } from "./androidDeviceState";

/**
 * "Set up Android on this machine" (plan §5): what a boot needs, each line
 * found or missing, with its download size when it is missing.
 *
 * Read-only in P0. The guided install, "Review licences & install" and
 * "Use mine…" are P1 and take the foot of this card; until then the card says
 * the one thing that fixes it.
 */

/** Download sizes from the SDK repository (plan §9), shown only for a missing part. */
const MISSING_SIZE = {
  platformTools: "~15 MB",
  emulator: "~480 MB",
  image: "~1.8 GB",
} as const;

type ChecklistRow = {
  id: string;
  label: string;
  ok: boolean;
  /** The found value or the missing part's size. */
  value: string;
  detail: string | null;
};

/** Android Studio's default SDK folder per host OS (the brain looks there too). */
function defaultSdkFolder(platform: string | null): string | null {
  if (platform === "win32") return "%LOCALAPPDATA%\\Android\\Sdk";
  if (platform === "darwin") return "~/Library/Android/sdk";
  if (platform === "linux") return "~/Android/Sdk";
  return null;
}

function androidSetupRows(sdk: AndroidSdkStatus): ChecklistRow[] {
  const platformTools = androidSdkTool(sdk, "platform-tools");
  const emulator = androidSdkTool(sdk, "emulator");
  const image = androidSdkTool(sdk, "system-image");
  const accel = sdk.acceleration;
  return [
    {
      id: "acceleration",
      label: "Acceleration",
      ok: accel.usable,
      value: accel.usable ? `${accel.kind ?? "Hypervisor"} on` : accel.kind ? `${accel.kind} off` : "not available",
      detail: accel.usable ? null : accel.detail,
    },
    {
      id: "sdk",
      label: "Android SDK",
      ok: sdk.found,
      value: sdk.found ? sdk.root ?? "found" : "not found",
      detail: null,
    },
    {
      id: "platform-tools",
      label: "Platform tools",
      ok: platformTools?.available ?? sdk.found,
      value: platformTools?.available ? platformTools.version ?? "found" : MISSING_SIZE.platformTools,
      detail: platformTools?.available ? null : platformTools?.detail ?? null,
    },
    {
      id: "emulator",
      label: "Emulator",
      ok: emulator?.available ?? false,
      value: emulator?.available ? emulator.version ?? "found" : MISSING_SIZE.emulator,
      detail: emulator?.available ? null : emulator?.detail ?? null,
    },
    {
      id: "image",
      label: "Phone image",
      ok: image?.available ?? false,
      value: image?.available ? image.version ?? "found" : `${sdk.hostAbi} · ${MISSING_SIZE.image}`,
      detail: image?.available ? null : image?.detail ?? null,
    },
  ];
}

export function AndroidSetupCard({
  sdk,
  hostPlatform,
  refreshing,
  onRefresh,
}: {
  sdk: AndroidSdkStatus;
  /** The lane's host OS when known, for the default install folder. */
  hostPlatform: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const rows = androidSetupRows(sdk);
  const folder = sdk.root ?? defaultSdkFolder(hostPlatform);
  return (
    <div
      data-android-setup-card=""
      className="ade-tool-picker-static flex size-full items-start justify-center overflow-y-auto px-5 py-8"
    >
      <div className="ade-tool-card ade-tool-card-solid flex w-full min-w-0 max-w-md flex-col gap-3 p-5">
        <p className="min-w-0 font-sans text-sm font-medium leading-5 text-fg">Set up Android on this machine</p>
        <ul className="flex min-w-0 flex-col gap-1.5" aria-label="What the emulator needs">
          {rows.map((row) => (
            <li key={row.id} data-android-setup-row={row.id} data-android-setup-ok={row.ok ? "true" : "false"} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2 font-sans text-xs leading-5">
                {row.ok ? (
                  <Check size={13} weight="bold" aria-label="Found" className="shrink-0 text-success" />
                ) : (
                  <X size={13} weight="bold" aria-label="Missing" className="shrink-0 text-[var(--color-error)]" />
                )}
                <span className="w-28 shrink-0 text-fg">{row.label}</span>
                <span className={cn("min-w-0 flex-1 truncate", row.ok ? "text-muted-fg" : "text-fg/80")} title={row.value}>
                  {row.value}
                </span>
              </span>
              {row.detail ? (
                <span className="min-w-0 break-words pl-[1.3rem] font-sans text-[11px] leading-4 text-muted-fg">{row.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {folder ? (
          <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
            <span className="text-fg/80">{sdk.root ? "SDK folder" : "Looks in"}</span>
            {"  "}
            <span className="font-mono">{folder}</span>
          </p>
        ) : null}
        <p className="min-w-0 break-words font-sans text-xs leading-5 text-fg/85">
          Install Android Studio, or set ANDROID_HOME to your SDK folder, then check again.
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh} data-android-setup-refresh="">
            Check again
          </Button>
        </div>
      </div>
    </div>
  );
}
