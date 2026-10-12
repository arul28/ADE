/**
 * "Quit ADE?" in ADE's own dialog. Main asks the window it is quitting from
 * and waits for the answer; when no window can show it, main asks natively
 * from the same model (`shared/quitPromptModel.ts`).
 *
 * Normally agents run in the background service and keep going after the
 * desktop quits, so the dialog reassures and offers "Don't ask again"
 * (unticked). When the desktop is running the service itself, quitting stops
 * running agents, so it says so and offers to repair the service first.
 */
import { useEffect, useState } from "react";
import { Power } from "@phosphor-icons/react";
import type { QuitPromptChoice, QuitPromptRequest } from "../../../shared/types";
import { agentsAre, quitPromptModel } from "../../../shared/quitPromptModel";
import { Dialog, type DialogAction } from "../ui/dialog";
import { READABLE_TOAST_DURATION_MS, showToast, updateToast } from "./toast/toastStore";

const REPAIR_TOAST_ID = "quit-prompt-repair";

export function QuitPromptHost(): JSX.Element | null {
  const [request, setRequest] = useState<QuitPromptRequest | null>(null);

  useEffect(() => {
    const app = window.ade?.app;
    const offPrompt = app?.onQuitPrompt?.((next) => {
      setRequest(next);
      // Tell main it is on screen, so it does not ask natively as well.
      app.quitPromptShown?.(next.requestId);
    });
    const offDismiss = app?.onQuitPromptDismiss?.((requestId) => {
      setRequest((current) => (current?.requestId === requestId ? null : current));
    });
    return () => {
      offPrompt?.();
      offDismiss?.();
    };
  }, []);

  if (!request) return null;
  return <QuitPromptDialog key={request.requestId} request={request} onDone={() => setRequest(null)} />;
}

/** Runs "Repair service" and reports it; main holds quitting until it settles. */
function repairFromQuitPrompt(requestId: string): void {
  showToast({
    id: REPAIR_TOAST_ID,
    tone: "info",
    busy: true,
    title: "Repairing ADE's background service…",
    message: "This can take a minute. ADE won't quit until it finishes.",
    durationMs: 0,
    dismissible: false,
  });
  const repaired = (resumedChats: number) => updateToast(REPAIR_TOAST_ID, {
    tone: "success",
    busy: false,
    title: "ADE's background service is running",
    message: resumedChats > 0
      ? `${agentsAre(resumedChats)} picking up where ${resumedChats === 1 ? "it" : "they"} left off. You can quit now and they keep going.`
      : "You can quit now and your agents keep going.",
    durationMs: READABLE_TOAST_DURATION_MS,
    dismissible: true,
  });
  const failed = () => updateToast(REPAIR_TOAST_ID, {
    tone: "warning",
    busy: false,
    title: "ADE's background service still won't start",
    message: "Try again from the banner, or restart your computer.",
    durationMs: READABLE_TOAST_DURATION_MS,
    dismissible: true,
  });
  void (window.ade.app.answerQuitPrompt?.({ requestId, choice: "repair", dontAskAgain: false }) ?? Promise.resolve(null))
    .then((result) => {
      if (result?.repaired) repaired(result.resumedChats);
      else failed();
    })
    .catch(failed);
}

function QuitPromptDialog({ request, onDone }: { request: QuitPromptRequest; onDone: () => void }): JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const model = quitPromptModel(request, { canRepair: true });

  const answer = (choice: QuitPromptChoice) => {
    onDone();
    void window.ade.app.answerQuitPrompt?.({ requestId: request.requestId, choice, dontAskAgain }).catch(() => {});
  };

  const choose = (choice: QuitPromptChoice) => {
    if (choice !== "repair") {
      answer(choice);
      return;
    }
    if (request.appOwnedService?.repair === "system_settings") {
      // Only the person can allow the background item; ADE stays open meanwhile.
      answer("keep");
      void window.ade.recovery?.openBackgroundSettings?.().catch(() => undefined);
      return;
    }
    onDone();
    repairFromQuitPrompt(request.requestId);
  };

  const actions: DialogAction[] = model.actions.map((action) => ({
    label: action.label,
    variant: action.primary ? "solid" : "secondary",
    autoFocus: action.primary,
    onClick: () => choose(action.choice),
  }));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) answer("keep");
      }}
      role="alertdialog"
      size="sm"
      tone={model.tone}
      icon={model.tone === "warning" ? true : <Power size={16} weight="bold" />}
      title={model.title}
      description={model.description}
      hideClose
      testId="quit-prompt"
      footerStart={model.offerDontAskAgain ? (
        <label className="ade-dialog-checkbox ade-dialog-checkbox--footer">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          <span>Don't ask again</span>
        </label>
      ) : undefined}
      actions={actions}
    />
  );
}
