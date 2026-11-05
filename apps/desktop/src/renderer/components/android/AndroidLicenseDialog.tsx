import { useState } from "react";
import type { AndroidSdkLicense, AndroidSdkSetupPart } from "../../../shared/types/androidEmulator";
import { Dialog } from "../ui/dialog";
import { formatAndroidBytes } from "./androidSdkFormat";

/**
 * "Review licences & install" (plan §1: ADE never accepts a licence by
 * itself). Every licence the install needs is shown in full with its own
 * box; the install starts only when each box is ticked. A licence this SDK
 * already records as accepted starts ticked and says so.
 */
export function AndroidLicenseDialog({
  licenses,
  parts,
  downloadBytes,
  sdkRoot,
  machineName,
  starting,
  onCancel,
  onAccept,
}: {
  licenses: AndroidSdkLicense[];
  parts: AndroidSdkSetupPart[];
  downloadBytes: number;
  sdkRoot: string;
  machineName: string | null;
  starting: boolean;
  onCancel: () => void;
  onAccept: (acceptedLicenseIds: string[]) => void;
}) {
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(licenses.filter((license) => license.accepted).map((license) => license.id)));
  const [open, setOpen] = useState<string | null>(licenses.find((license) => !license.accepted)?.id ?? licenses[0]?.id ?? null);
  const allAccepted = licenses.every((license) => accepted.has(license.id));
  const partLabel = (id: string) => parts.find((part) => part.id === id)?.label ?? id;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !starting) onCancel();
      }}
      title="Review licences"
      description={`Google's terms for the parts ADE installs${machineName ? ` on ${machineName}` : ""}. ADE records your acceptance in the SDK folder.`}
      width={560}
      testId="android-license-dialog"
      actions={[
        { label: "Cancel", onClick: onCancel, disabled: starting, variant: "secondary" },
        {
          label: starting ? "Starting…" : `Accept and install · ${formatAndroidBytes(downloadBytes)}`,
          onClick: () => onAccept(licenses.map((license) => license.id)),
          disabled: starting || !allAccepted,
          variant: "primary",
        },
      ]}
      footerStart={<span className="font-mono text-[11px] text-muted-fg" title={sdkRoot}>{sdkRoot}</span>}
    >
      <div className="flex flex-col gap-2 py-1">
        {licenses.map((license) => {
          const expanded = open === license.id;
          const checked = accepted.has(license.id);
          return (
            <section key={license.id} className="kit-panel flex min-w-0 flex-col" data-android-license={license.id}>
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 px-3 py-2 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : license.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-[13px] font-medium text-fg">{license.title}</span>
                  <span className="block truncate font-sans text-[11px] text-muted-fg">
                    For {license.partIds.map(partLabel).join(", ")}
                    {license.accepted ? " · accepted before on this SDK" : ""}
                  </span>
                </span>
                <span className="shrink-0 font-sans text-[11px] text-muted-fg">{expanded ? "Hide" : "Read"}</span>
              </button>
              <label className="flex cursor-pointer items-center gap-2 border-t border-[var(--kit-rule)] px-3 py-2 font-sans text-[12px] text-fg/90">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={starting}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    const next = new Set(accepted);
                    if (on) next.add(license.id);
                    else next.delete(license.id);
                    setAccepted(next);
                    // Accepted: fold it and open the next one still to read.
                    if (on) setOpen(licenses.find((entry) => !next.has(entry.id))?.id ?? null);
                  }}
                />
                I accept the {license.title}
              </label>
              {expanded ? (
                <pre
                  className="mx-3 my-2 max-h-56 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--kit-track)] p-3 font-mono text-[11px] leading-4 text-fg/85"
                  tabIndex={0}
                  aria-label={`${license.title} text`}
                >
                  {license.text.trim()}
                </pre>
              ) : null}
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
