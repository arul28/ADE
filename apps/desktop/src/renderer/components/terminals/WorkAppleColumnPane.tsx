import type { AppleLaneDevice, OpenProjectBinding } from "../../../shared/types";
import { ChatIosSimulatorPanel } from "../chat/ChatIosSimulatorPanel";
import { useWorkToolContextInsertion, type WorkSidebarContextTarget } from "./workToolContextInsertion";

/**
 * The Apple device column's pane: a sibling of the chat column, not a tenant
 * of the tools pane.
 *
 * Spec §2a is explicit that an open device "gets its own full-height column in
 * the Work tab, not the shared tools pane". The first build rendered the column
 * full-bleed INSIDE the tools pane, which looks similar and is not the same
 * thing: the device then shared one width with Git and Files, it disappeared
 * the moment you opened another tool, and every one of the spec's breakpoints
 * (700 / 420 / 280 / 200) was measured against a pane sized for a file tree.
 *
 * This pane exists whenever the lane has a device. It carries no chrome of its
 * own — the column draws its own header, stage, toolbar and quick strip — so
 * all this adds is the column's own context-insertion wiring, which used to
 * come from the tools pane's props object.
 */
export function WorkAppleColumnPane({
  laneId,
  laneRoot,
  device,
  runtimePin,
  contextTarget,
  contextDisabledReason,
  onClose,
}: {
  laneId: string | null;
  /** The lane's worktree path — the column builds and launches inside it. */
  laneRoot: string | null;
  /** The device this column is open for. Its udid keys the remount. */
  device: AppleLaneDevice | null;
  runtimePin: OpenProjectBinding | null;
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason: string | null;
  onClose: () => void;
}) {
  const { addIosContext, insertDraft } = useWorkToolContextInsertion({
    contextTarget,
    contextDisabledReason,
    runtimePin,
  });
  const panelSessionId = contextTarget?.kind === "chat" ? contextTarget.sessionId : null;
  const canInsertContext = Boolean(contextTarget && !contextDisabledReason);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ChatIosSimulatorPanel
        // Remount on a machine change for the same reason the terminal does:
        // a foreign machine's device must never paint into the machine you
        // just switched to. The udid is in the key so replacing a lane's
        // device starts a clean column rather than reusing the old one's
        // stream state.
        key={`work-apple:${runtimePin?.key ?? "bound"}:${device?.udid ?? "none"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        projectRoot={laneRoot}
        runtimePin={runtimePin}
        controlDisabledReason={null}
        ignoreChatOwnership
        onAddContext={canInsertContext ? addIosContext : undefined}
        onInsertDraft={canInsertContext ? insertDraft : undefined}
        onClose={onClose}
      />
    </div>
  );
}
