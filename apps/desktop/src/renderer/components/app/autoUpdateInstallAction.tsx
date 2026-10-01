import type { AutoUpdateSnapshot, UpdateInterruptedChat } from "../../../shared/types";
import { checkboxConfirmDialog, confirmDialog } from "../ui/dialog/confirm";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the latest update";
}

/**
 * The chats a restart will interrupt, as a compact list. Project names only
 * appear when the list spans more than one, so a single-project list stays
 * quiet.
 */
function InterruptedChatList({ chats }: { chats: UpdateInterruptedChat[] }) {
  const projectNames = new Set(chats.map((chat) => chat.projectName).filter(Boolean));
  const showProject = projectNames.size > 1;
  return (
    <div style={{ marginTop: 2 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--color-fg)" }}>
        {chats.length === 1 ? "1 agent is running" : `${chats.length} agents are running`}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
        {chats.map((chat) => (
          <li key={chat.sessionId} style={{ overflowWrap: "anywhere" }}>
            {showProject ? `${chat.title} — ${chat.projectName}` : chat.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Shared confirmation and install action for every manual update affordance. */
export async function requestDownloadedUpdateInstall(
  snapshot: AutoUpdateSnapshot,
  onAccepted?: () => void,
): Promise<boolean> {
  const impact = await Promise.resolve()
    .then(() => window.ade.updateGetInstallImpact())
    .catch(() => null);
  const phones = impact?.connectedPhones ?? [];
  const interruptedChats = impact?.interruptedChats ?? [];
  const title = `ADE will quit and reopen automatically to install ${versionLabel(snapshot.version)}.`;
  const lines: string[] = [];
  if (phones.length === 1) {
    lines.push(
      `${phones[0].deviceName} is connected through ADE phone sync. It will disconnect during the update and reconnect automatically once ADE is back.`,
    );
  } else if (phones.length > 1) {
    lines.push(
      `Connected phones (${phones.map((phone) => phone.deviceName).join(", ")}) will disconnect during the update and reconnect automatically once ADE is back.`,
    );
  }
  lines.push(
    "Open ADE Code terminals and running agent sessions on this machine will disconnect while the ADE service restarts — you can reopen them right after the update.",
    "",
    "You do not need to restart ADE yourself. Any unsaved work may be lost. Continue?",
  );
  const message = lines.join("\n");

  const accepted = async (resumeChats: boolean): Promise<boolean> => {
    captureUpdatePromptDecision(snapshot, "accepted", { resumeChats });
    onAccepted?.();
    try {
      return await window.ade.updateQuitAndInstall({ resumeChats });
    } catch {
      // The main process logs updater failures.
      return false;
    }
  };

  if (interruptedChats.length > 0) {
    const result = await checkboxConfirmDialog({
      title,
      message,
      children: <InterruptedChatList chats={interruptedChats} />,
      checkbox: { label: "Resume these chats when ADE is back", defaultChecked: true },
      confirmLabel: "Continue",
    });
    if (!result.confirmed) {
      captureUpdatePromptDecision(snapshot, "deferred");
      return false;
    }
    return await accepted(result.checked);
  }

  const confirmed = await confirmDialog({ title, message, confirmLabel: "Continue" });
  if (!confirmed) {
    captureUpdatePromptDecision(snapshot, "deferred");
    return false;
  }
  return await accepted(false);
}
