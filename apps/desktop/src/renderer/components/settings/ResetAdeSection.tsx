import { Trash } from "@phosphor-icons/react";
import { ResetAdeButton } from "../app/ResetAdeDialog";
import { SettingsCard } from "./primitives";

/**
 * The hard reset, as a setting. Its own section at the very bottom of General,
 * away from About, so it is never mistaken for a routine control.
 *
 * The About section is `machine: "local"`, and so is this one: the reset runs
 * in the main process of the machine you are looking at. A remote machine's
 * page drops the section and says why, because the button would otherwise
 * reset this computer instead. The dialog itself carries the warnings, the
 * lane-rescue choices and the typed confirmation.
 */
export function ResetAdeSection() {
  return (
    <SettingsCard
      anchor="reset-ade"
      icon={<Trash size={15} weight="duotone" />}
      tone="red"
      title="Reset ADE"
      description="Removes everything ADE put on this computer, including ADE's data and lanes in every project, then reopens ADE as a new install. Your code and repositories stay."
      control={<ResetAdeButton label="Reset ADE…" />}
    />
  );
}
