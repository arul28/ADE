import { useCallback } from "react";
import type { LaneDependencyStatus, OpenProjectBinding } from "../../../../shared/types";
import { isAdeCloudBinding } from "../../../../shared/adeCloud/binding";
import { isAdeCloudComputer } from "../../../state/adeCloudLaneIndex";
import { settingsRouteFor } from "../../settings/settingsManifest";
import { requestLaneEnvImport } from "../../settings/passwords/laneEnvImport";
import { useSituationalSuggestion } from "./useSituationalSuggestion";
import { BRAND } from "../../../../shared/brand";

/**
 * The `.env` tip: the main checkout of the open project has an ignored
 * `.env` file. Read from the dependency status the lane-template notice
 * already reads on the tab's machine (`envFiles`), so it costs no call of its
 * own. Once per set of files. Only a connected own computer shows it: ADE
 * Cloud has no checkout of the person's own to import from.
 *
 * Import goes to the machine the pin names (`passwords.previewLaneEnv`,
 * `passwords.importLaneEnv`): the file is only there, and no value comes to
 * this window.
 */
export function useEnvImportSuggestion({
  status,
  pin,
  scopeKey,
  context,
  navigate,
}: {
  status: LaneDependencyStatus | null;
  pin: OpenProjectBinding | null;
  scopeKey: string | null;
  context: string | null;
  navigate: (path: string) => void;
}): void {
  const ownComputer = Boolean(pin)
    && !isAdeCloudBinding(pin)
    && !(pin?.kind === "remote" && isAdeCloudComputer({ hostname: pin.hostname ?? null }));
  const file = ownComputer ? status?.envFiles?.[0] ?? null : null;
  const canImport = Boolean(window.ade?.passwords?.previewLaneEnv);
  const start = useCallback(() => {
    if (!pin || !file) return;
    requestLaneEnvImport({ path: file, pin });
    navigate(settingsRouteFor("passwords.secrets"));
  }, [file, navigate, pin]);
  useSituationalSuggestion({
    id: "env-import",
    signalKey: scopeKey && file && canImport ? `${scopeKey}:${status?.envFiles?.join(",")}` : null,
    detail: file && file !== ".env"
      ? `${file} in this project's main checkout is ignored by git, so new lanes and ${BRAND.CLOUD_NAME} start without it. As ${BRAND.NAME} secrets, its values reach every lane and computer, and agents never see them.`
      : undefined,
    scopeKey,
    context,
    start: scopeKey && file && canImport ? start : null,
  });
}
