import { useState } from "react";
import { ArrowSquareOut, Copy, PaperPlaneRight } from "@phosphor-icons/react";
import { SetupSteps, type SetupStep, type SetupStepState } from "./SetupSteps";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import {
  cancelAccountCloudLaunch,
  queueAccountCloudMessage,
  refreshAccountCloudLaunches,
  retryAccountCloudLaunch,
  type AccountCloudLaunchEntry,
} from "../../state/accountCloudLaunches";
import { CLOUD_REMOTE_SIGN_IN, type CloudLaunchRecord, type CloudLaunchSignIn, type CloudLaunchStage } from "../../../shared/accountCloudLaunches";
import { humanizeProvider } from "../usage/usageProviderNames";

const COMPUTER_STAGES = ["computer", "join"];
const REPO_STAGES = ["clone", "fetch", "checkout"];
const AGENT_STAGE = "agent";

function stagesState(stages: readonly CloudLaunchStage[], ids: readonly string[]): SetupStepState | null {
  const mine = stages.filter((stage) => ids.includes(stage.id));
  if (mine.length === 0) return null;
  if (mine.some((stage) => stage.status === "failed")) return "failed";
  if (mine.every((stage) => stage.status === "done" || stage.status === "skipped" || stage.status === "warning")) return "done";
  if (mine.some((stage) => stage.status === "running" || stage.status === "done")) return "running";
  return "todo";
}

const AFTER_JOIN = new Set(["joined", "waiting_for_sign_in", "running", "done"]);

/** The four steps, from the launch's record. */
export function cloudSetupStepStates(record: CloudLaunchRecord | null): {
  computer: SetupStepState;
  repo: SetupStepState;
  signIn: SetupStepState;
  send: SetupStepState;
} {
  if (!record) return { computer: "running", repo: "todo", signIn: "todo", send: "todo" };
  const stages = record.stages ?? [];
  const failed = record.state === "failed" || record.state === "cancelled";
  const computer = stagesState(stages, COMPUTER_STAGES)
    ?? (AFTER_JOIN.has(record.state) ? "done" : record.state === "needs_approval" ? "waiting" : failed ? "failed" : "running");
  const repoFromStages = stagesState(stages, REPO_STAGES);
  const agent = stages.find((stage) => stage.id === AGENT_STAGE)?.status ?? null;
  const agentStarted = agent === "running" || agent === "done" || record.state === "running" || record.state === "done";
  const repo = repoFromStages ?? (agentStarted || record.state === "waiting_for_sign_in" ? "done" : computer === "done" ? "running" : "todo");
  const signIn: SetupStepState = record.state === "waiting_for_sign_in"
    ? "waiting"
    : agentStarted
      ? "done"
      : failed && repo === "done" ? "failed" : "todo";
  const send: SetupStepState = record.sessionId || record.state === "done" || agent === "done"
    ? "done"
    : agentStarted ? "running" : failed && signIn === "done" ? "failed" : "todo";
  return {
    computer: failed && computer !== "done" ? "failed" : computer,
    repo: failed && computer === "done" && repo !== "done" ? "failed" : repo,
    signIn,
    send,
  };
}

function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "your provider";
  return CLOUD_REMOTE_SIGN_IN.find((row) => row.provider === provider)?.label ?? humanizeProvider(provider);
}

function openPage(url: string): void {
  void window.ade.app.openExternal(url).catch(() => undefined);
}

/** What the person does for a provider sign-in the launch waits on. */
function SignInDetail({ signIn, instanceId }: { signIn: CloudLaunchSignIn; instanceId: string | null }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const api = window.ade?.cloudLaunches;

  if (signIn.kind === "desktop") {
    return (
      <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
        {signIn.reason ?? "Sign in from ADE desktop; it reaches ADE Cloud."} Sign in from ADE desktop, or pick another model.
      </p>
    );
  }

  const submit = async () => {
    const text = value.trim();
    if (!text || !api) return;
    setBusy(true);
    setError(null);
    try {
      if (signIn.kind === "api_key") {
        if (!signIn.signInId) throw new Error("ADE Cloud didn't say which key to save.");
        await api.saveSignIn(signIn.signInId, text);
      } else {
        if (!instanceId || !signIn.jobId) throw new Error("The computer isn't ready for the code yet. Try again in a moment.");
        const status = await api.sendSignInCode(instanceId, signIn.jobId, text);
        if (status.state === "failed") throw new Error(status.reason ?? "The code didn't work. Open the page again for a new one.");
      }
      setValue("");
      setSent(true);
      refreshAccountCloudLaunches();
    } catch (cause) {
      setError(extractError(cause));
    } finally {
      setBusy(false);
    }
  };

  const needsInput = signIn.kind === "api_key" || signIn.needsPastedCode || signIn.kind === "url_paste";
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {signIn.kind === "device" && signIn.userCode ? (
        <div className="flex items-center gap-2">
          <span className="ade-signin-code" aria-label="Sign-in code">{signIn.userCode}</span>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Copy the code"
            onClick={() => void navigator.clipboard?.writeText(signIn.userCode ?? "").catch(() => undefined)}
          >
            <Copy size={13} aria-hidden />
          </button>
        </div>
      ) : null}
      {signIn.reason && signIn.kind === "api_key" ? (
        <p className="m-0 text-[12px]" style={{ color: "var(--kit-text-2)" }}>{signIn.reason}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {signIn.url ? (
          <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={() => openPage(signIn.url!)}>
            <ArrowSquareOut size={13} aria-hidden />
            Open sign-in page
          </button>
        ) : null}
        {needsInput ? (
          <form
            className="flex min-w-[220px] flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              className="kit-input min-w-0 flex-1"
              data-size="sm"
              type={signIn.kind === "api_key" ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={signIn.kind === "api_key" ? "Paste your key" : "Paste the code from the page"}
              aria-label={signIn.kind === "api_key" ? "Key" : "Code from the sign-in page"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="kit-btn" data-size="sm" disabled={busy || !value.trim()}>
              {busy ? "Sending…" : signIn.kind === "api_key" ? "Save" : "Send code"}
            </button>
          </form>
        ) : null}
      </div>
      {sent && !error ? (
        <p className="m-0 text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>Sent. The computer goes on once the sign-in lands.</p>
      ) : null}
      {error ? (
        <Banner layout="inline" model={{ id: "cloud-setup-sign-in", tone: "error", title: "The sign-in didn't go through", detail: error }} />
      ) : null}
    </div>
  );
}

/**
 * "Getting ADE Cloud ready": the chat's first message made a computer on
 * ADE Cloud. The message waits on the server (the tab may close) while the
 * computer starts, clones the repository, and signs in to the chat's
 * provider; then the computer sends it. Messages typed now wait with it.
 */
export function CloudSetupCard({
  entry,
  onOpenChat,
}: {
  entry: AccountCloudLaunchEntry;
  /** Opens the chat on the cloud computer once it exists. */
  onOpenChat?: (record: CloudLaunchRecord) => void;
}) {
  const record = entry.record;
  const provider = record?.request?.chat?.provider ?? entry.request?.chat?.provider ?? null;
  const steps = cloudSetupStepStates(record);
  const [draft, setDraft] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const failed = entry.startError != null || record?.state === "failed";
  const cancelled = record?.state === "cancelled";
  const ready = Boolean(record?.sessionId) && (record?.state === "running" || record?.state === "done");
  const signIn = record?.signIn ?? null;

  const rows: SetupStep[] = [
    {
      id: "computer",
      title: "Computer started",
      state: entry.startError ? "failed" : steps.computer,
      detail: record?.state === "needs_approval" && record.approval ? (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[12px]" style={{ color: "var(--kit-text-2)" }}>Confirm the computer's sign-in to your account.</span>
          <button type="button" className="kit-btn" data-size="sm" onClick={() => openPage(record.approval!.url)}>
            Confirm
          </button>
        </div>
      ) : undefined,
    },
    { id: "repo", title: "Cloned repo", state: steps.repo },
    {
      id: "sign-in",
      title: `Sign in to ${signIn?.label ?? providerLabel(provider)}`,
      state: steps.signIn,
      detail: signIn && record?.state === "waiting_for_sign_in" ? <SignInDetail signIn={signIn} instanceId={record.instanceId} /> : undefined,
    },
    { id: "send", title: "Send your message", state: steps.send },
  ];

  const pending = entry.messages.filter((message) => message.state !== "delivered");
  const canQueue = !ready && !failed && !cancelled && record != null;

  return (
    <section className="kit-card w-full" aria-label="Getting ADE Cloud ready" data-testid="ade-cloud-setup-card">
      <header className="kit-card-head">
        {ready ? "Your chat is on ADE Cloud" : failed ? "ADE Cloud couldn't start this chat" : cancelled ? "Chat cancelled" : "Getting ADE Cloud ready"}
        {!ready && !failed && !cancelled && record ? (
          <button
            type="button"
            className="kit-card-head-action"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void cancelAccountCloudLaunch(entry.launchId).finally(() => setCancelling(false));
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
      </header>
      <div className="kit-card-body flex flex-col gap-2.5" style={{ paddingTop: 4 }}>
        <SetupSteps steps={rows} label="Getting ADE Cloud ready" />
        {pending.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Messages waiting to send">
            {pending.map((message) => (
              <li key={message.messageId} className="kit-panel flex items-start gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px]" style={{ overflowWrap: "anywhere" }}>{message.text}</span>
                <span className="kit-tag shrink-0" data-tone={message.state === "failed" || failed || cancelled ? "crit" : undefined}>
                  {message.state === "failed" || failed || cancelled ? "Not sent" : message.state === "sending" ? "Sending" : "Waiting"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {failed ? (
          <Banner
            layout="inline"
            model={{
              id: `cloud-setup-failed-${entry.launchId}`,
              tone: "error",
              title: entry.startError ? "The chat didn't start" : "The computer stopped before the chat started",
              detail: `${entry.startError ?? record?.error ?? "ADE Cloud didn't say why."} Your message is not sent.`,
              actions: [{ label: "Retry", onClick: () => void retryAccountCloudLaunch(entry.launchId) }],
              report: { surface: "cloud_setup_card", code: "launch_failed", technicalDetail: entry.startError ?? record?.error ?? "" },
            }}
          />
        ) : null}
        {ready && record ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
              {record.laneName ? `Lane ${record.laneName} is working.` : "The agent is working."}
            </span>
            {onOpenChat ? (
              <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={() => onOpenChat(record)}>
                Open chat
              </button>
            ) : null}
          </div>
        ) : null}
        {canQueue ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              setDraft("");
              void queueAccountCloudMessage(entry.launchId, text);
            }}
          >
            <input
              className="kit-input min-w-0 flex-1"
              data-size="sm"
              placeholder="Add a message; it waits for the computer"
              aria-label="Add a message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="kit-icon-btn" aria-label="Queue message" disabled={!draft.trim()}>
              <PaperPlaneRight size={14} aria-hidden />
            </button>
          </form>
        ) : null}
        {!ready && !failed && !cancelled ? (
          <p className="m-0 text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>
            You can close this tab. ADE Cloud sends your message when the computer is ready.
          </p>
        ) : null}
      </div>
    </section>
  );
}
