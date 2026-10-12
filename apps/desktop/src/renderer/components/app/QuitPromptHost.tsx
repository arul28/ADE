/**
 * "Quit ADE?" in ADE's own dialog. Main asks the window it is quitting from
 * and waits for the answer; when no window can show it, main asks natively
 * with the same words.
 *
 * Two shapes. Normally agents run in the background service and keep going
 * after the desktop quits, so the dialog reassures and offers "Don't ask
 * again" (unticked). When the desktop is running the service itself, quitting
 * stops running agents, so it says so and offers to repair the service first.
 */
import { useEffect, useState } from "react";
import { Power } from "@phosphor-icons/react";
import type { QuitPromptAnswer, QuitPromptRequest } from "../../../shared/types";
import { Dialog, type DialogAction } from "../ui/dialog";
import { agentsAre, quitPromptCopy } from "../../../shared/quitPromptCopy";
import { showToast, updateToast } from "./toast/toastStore";

const REPAIR_TOAST_ID = "quit-prompt-repair";

export function QuitPromptHost(): JSX.Element | null {
  const [request, setRequest] = useState<QuitPromptRequest | null>(null);

  useEffect(() => {
    const app = window.ade?.app;
    return app?.onQuitPrompt?.((next) => {
      setRequest(next);
      // Tell main it is on screen, so it does not ask natively as well.
      void app.answerQuitPrompt?.({ requestId: next.requestId }).catch(() => {});
    });
  }, []);

  if (!request) return null;
  return <QuitPromptDialog key={request.requestId} request={request} onDone={() => setRequest(null)} />;
}

function QuitPromptDialog({ request, onDone }: { request: QuitPromptRequest; onDone: () => void }): JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const verb = request.relaunch ? "Restart" : "Quit";
  const owned = request.appOwnedService;
  const { title, description } = quitPromptCopy(request);

  const answer = (choice: QuitPromptAnswer["choice"]) => {
    onDone();
    void window.ade.app.answerQuitPrompt?.({ requestId: request.requestId, choice, dontAskAgain }).catch(() => {});
  };

  const repair = () => {
    onDone();
    if (owned?.blockedByMacOS) {
      void window.ade.app.answerQuitPrompt?.({ requestId: request.requestId, choice: "keep" }).catch(() => {});
      void window.ade.recovery?.openBackgroundSettings?.().catch(() => undefined);
      return;
    }
    showToast({
      id: REPAIR_TOAST_ID,
      tone: "info",
      busy: true,
      title: "Repairing ADE's background service…",
      message: "This can take a minute.",
      durationMs: 0,
      dismissible: false,
    });
    void (window.ade.app.answerQuitPrompt?.({ requestId: request.requestId, choice: "repair" }) ?? Promise.resolve(null))
      .then((result) => {
        if (result?.repaired) {
          updateToast(REPAIR_TOAST_ID, {
            tone: "success",
            busy: false,
            title: "ADE's background service is running",
            message: result.resumedChats > 0
              ? `${agentsAre(result.resumedChats)} picking up where ${result.resumedChats === 1 ? "it" : "they"} left off. You can quit now and they keep going.`
              : "You can quit now and your agents keep going.",
            durationMs: 8_000,
            dismissible: true,
          });
          return;
        }
        throw new Error("repair failed");
      })
      .catch(() => {
        updateToast(REPAIR_TOAST_ID, {
          tone: "warning",
          busy: false,
          title: "ADE's background service still won't start",
          message: "Try again from the banner, or restart your computer.",
          durationMs: 18_000,
          dismissible: true,
        });
      });
  };

  const actions: DialogAction[] = owned
    ? [
        { label: "Keep ADE open", variant: "secondary", onClick: () => answer("keep") },
        { label: `${verb} anyway`, variant: "secondary", onClick: () => answer("quit") },
        {
          label: owned.blockedByMacOS ? "Open System Settings" : "Repair service",
          variant: "solid",
          autoFocus: true,
          onClick: repair,
        },
      ]
    : [
        { label: "Keep ADE open", variant: "secondary", onClick: () => answer("keep") },
        { label: `${verb} ADE`, variant: "solid", autoFocus: true, onClick: () => answer("quit") },
      ];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) answer("keep");
      }}
      role="alertdialog"
      layer="nestedDialog"
      size="sm"
      tone={owned ? "warning" : "accent"}
      icon={owned ? true : <Power size={16} weight="bold" />}
      title={title}
      description={description}
      hideClose
      testId="quit-prompt"
      footerStart={owned ? undefined : (
        <label className="ade-dialog-checkbox" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          <span>Don't ask again</span>
        </label>
      )}
      actions={actions}
    />
  );
}
