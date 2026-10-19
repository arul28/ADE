import { useCallback, useState } from "react";
import type { LaneDependencyStatus, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useLaneChatHandoff } from "../../lib/laneChatHandoff";
import { buildLaneTemplateSetupPrompt } from "../../lib/laneTemplateSetupPrompt";
import { showToast } from "../app/toast/toastStore";

/**
 * "Set up a lane template with an agent": a new chat draft in the PRIMARY lane
 * of the machine the templates belong to, with the setup prompt in the
 * composer. The user picks the model and presses Send.
 *
 * `pin` is null for the tab's own machine. For another machine every read and
 * the draft carry that machine's pin, so the chat starts there, where its main
 * checkout and its `.ade/local.yaml` are.
 */
export function useLaneTemplateSetupChat({
  pin,
  machineName,
}: {
  pin: OpenProjectBinding | null;
  machineName: string;
}): { start: (known?: LaneDependencyStatus | null) => Promise<void>; busy: boolean } {
  const handOff = useLaneChatHandoff(pin, { startDraftInLane: true });
  const tabLanes = useAppStore((state) => state.lanes);
  const projectName = useAppStore((state) => state.project?.displayName ?? null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async (known?: LaneDependencyStatus | null) => {
    setBusy(true);
    try {
      const lanes: LaneSummary[] = pin
        ? await window.ade.lanes.list({ includeArchived: false }, pin)
        : tabLanes;
      const primary = lanes.find((lane) => lane.laneType === "primary");
      if (!primary) throw new Error(`No main checkout lane on ${machineName}.`);
      const [status, templates] = await Promise.all([
        known ? Promise.resolve(known) : window.ade.lanes.getDependencyStatus({}, pin).catch(() => null),
        window.ade.lanes.listTemplates(pin).catch(() => []),
      ]);
      const defaultTemplate = templates.find((template) => template.id === status?.defaultTemplateId) ?? null;
      handOff({
        laneId: primary.id,
        sessionId: null,
        prompt: buildLaneTemplateSetupPrompt({
          projectName,
          machineName,
          folders: status?.folders ?? [],
          templateNames: templates.map((template) => template.name || template.id),
          defaultTemplateName: defaultTemplate ? defaultTemplate.name || defaultTemplate.id : null,
        }),
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Could not start the template chat",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, [handOff, machineName, pin, projectName, tabLanes]);

  return { start, busy };
}
