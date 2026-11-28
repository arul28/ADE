import { ResetAdeButton } from "../app/ResetAdeDialog";
import { ModernRow, ModernRows, ModernSection } from "./primitives";
import { BRAND } from "../../../shared/brand";

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
    <ModernSection group={`Reset ${BRAND.NAME}`} anchor="reset-ade" title={`Reset ${BRAND.NAME}`}>
      <ModernRows>
        <ModernRow
          title={`Remove everything ${BRAND.NAME} put on this computer`}
          hint={`Includes ${BRAND.NAME}'s data and lanes in every project, then reopens ${BRAND.NAME} as a new install. Your code and repositories stay.`}
          control={<ResetAdeButton label={`Reset ${BRAND.NAME}…`} className="ade-modern-btn ade-modern-btn-danger" />}
        />
      </ModernRows>
    </ModernSection>
  );
}
