import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { CloudLaunchRecord } from "../../../shared/accountCloudLaunches";
import { captureError } from "../../../shared/sentry/capture";
import { openExternalUrl } from "../../lib/openExternal";
import { Banner } from "../ui/notice";
import { CloudSignInCodeField } from "./launch/CloudSignInCodeField";

/** A message this pane queued for an ADE Cloud chat whose computer was asleep or gone. */
export type CloudQueueSend = {
  chatId: string;
  wake: "awake" | "waking" | "launching";
  /** With `launching`: the launch that continues this chat on a new computer. */
  launchId: string | null;
  text: string;
};

/** The step a continue launch is at, in the chat's words. */
function launchTitle(record: CloudLaunchRecord | null): string {
  switch (record?.state) {
    case "failed":
      return record.error?.trim() || "ADE Cloud couldn't continue this chat on a new computer.";
    case "cancelled":
      return "The new computer for this chat was cancelled. Your message wasn't sent.";
    case "waiting_for_sign_in":
      return record.signIn?.reason?.trim() || `Sign in to ${record.signIn?.label ?? "the agent"} so the chat goes on.`;
    case "needs_approval":
      return "Confirm the new computer's sign-in to your account.";
    case "joining":
    case "joined":
      return "Setting up this lane's new ADE Cloud computer…";
    case "running":
    case "done":
      return "The chat goes on on this lane's new ADE Cloud computer.";
    default:
      return "Making a new ADE Cloud computer for this lane…";
  }
}

/**
 * The chat's own card after a message went to the account's queue: the
 * computer wakes, or (its computer gone) a new one continues this same chat
 * and the card follows that launch. The launch is read when the card opens,
 * when ADE Cloud's status changes, and when the window takes focus: no timer.
 * Account level, by the launch id: no pin.
 */
export function CloudQueueSendCard({
  send,
  style,
  onDone,
  onRestore,
}: {
  send: CloudQueueSend;
  style?: CSSProperties;
  onDone: () => void;
  /** Puts a message that wasn't sent back in the box. */
  onRestore: (text: string) => void;
}) {
  const [record, setRecord] = useState<CloudLaunchRecord | null>(null);
  const launchId = send.wake === "launching" ? send.launchId : null;
  const seqRef = useRef(0);
  const read = useCallback(() => {
    const status = window.ade?.cloud?.serverLaunchStatus;
    if (!launchId || !status) return;
    const seq = ++seqRef.current;
    void status(launchId).then(
      (next) => {
        if (seq === seqRef.current && next) setRecord(next);
      },
      // The card keeps its last record; the next focus or status change reads again.
      (error: unknown) => {
        captureError(error, { level: "warning", handled: true, fingerprint: ["ade-cloud", "queue-send-launch-status"] });
      },
    );
  }, [launchId]);
  useEffect(() => {
    if (!launchId) return undefined;
    read();
    window.addEventListener("focus", read);
    const off = window.ade?.cloud?.onStatusChanged?.(read) ?? null;
    return () => {
      window.removeEventListener("focus", read);
      off?.();
    };
  }, [launchId, read]);

  if (!launchId) {
    return (
      <Banner
        layout="inline"
        style={style}
        model={{
          id: "chat-cloud-queued",
          tone: "info",
          busy: send.wake === "waking",
          title: send.wake === "waking"
            ? "Sent. Your ADE Cloud computer is waking, and the agent gets your message when it is up."
            : "Sent to your ADE Cloud computer.",
          detail: "You can leave this chat.",
          dismiss: { onDismiss: onDone },
        }}
      />
    );
  }

  const failed = record?.state === "failed" || record?.state === "cancelled";
  const started = record?.state === "running" || record?.state === "done";
  const signIn = record?.state === "waiting_for_sign_in" ? record.signIn ?? null : null;
  const approval = record?.state === "needs_approval" ? record.approval : null;
  const actions = [
    ...(failed ? [{ label: "Put back", onClick: () => { onRestore(send.text); onDone(); } }] : []),
    ...(signIn?.url ? [{ label: "Open sign-in", onClick: () => openExternalUrl(signIn.url!) }] : []),
    ...(approval ? [{ label: "Confirm", onClick: () => openExternalUrl(approval.url) }] : []),
  ];
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id: "chat-cloud-continue",
        tone: failed ? "error" : signIn || approval ? "warning" : started ? "success" : "info",
        busy: !failed && !started && !signIn && !approval,
        title: launchTitle(record),
        detail: failed
          ? "Your message wasn't sent. Put it back in the box to send it again."
          : started
            ? null
            : "Your message goes to the agent once the computer is up. You can leave this chat.",
        report: failed ? false : undefined,
        actions,
        extra: signIn?.userCode
          ? <span className="ade-signin-code" aria-label="Sign-in code">{signIn.userCode}</span>
          : signIn?.jobId && (signIn.needsPastedCode || signIn.kind === "url_paste")
            ? <CloudSignInCodeField jobId={signIn.jobId} instanceId={record?.instanceId ?? null} className="text-[12px]" onSent={read} />
            : undefined,
        dismiss: failed || started ? { onDismiss: onDone } : undefined,
      }}
    />
  );
}
