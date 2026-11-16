import { useState } from "react";
import { ArrowSquareOut, Copy, PaperPlaneRight } from "@phosphor-icons/react";
import { SetupSteps, type SetupStep, type SetupStepState } from "./SetupSteps";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternal";
import { CloudSignInCodeField } from "../chat/launch/CloudSignInCodeField";
import {
  accountCloudLaunchHideable,
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
function cloudSetupStepStates(record: CloudLaunchRecord | null): {
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

/** What the person does for a provider sign-in the launch waits on. */
function SignInDetail({ signIn, instanceId }: { signIn: CloudLaunchSignIn; instanceId: string | null }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (signIn.kind === "desktop") {
    return (
      <p className="m-0 mt-1 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
        {signIn.reason ?? "Sign in from ADE desktop; it reaches ADE Cloud."} Sign in from ADE desktop, or pick another model.
      </p>
    );
  }

  const saveKey = async () => {
    const text = key.trim();
    const api = window.ade?.cloudLaunches;
    if (!text || !api) return;
    setBusy(true);
    setError(null);
    try {
      if (!signIn.signInId) throw new Error("ADE Cloud didn't say which key to save.");
      await api.saveSignIn(signIn.signInId, text);
      setKey("");
      setSaved(true);
      refreshAccountCloudLaunches();
    } catch (cause) {
      setError(extractError(cause));
    } finally {
      setBusy(false);
    }
  };

  const needsCode = signIn.kind !== "api_key" && (signIn.needsPastedCode || signIn.kind === "url_paste");
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
      {signIn.url ? (
        <div>
          <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={() => openExternalUrl(signIn.url)}>
            <ArrowSquareOut size={13} aria-hidden />
            Open sign-in
          </button>
        </div>
      ) : null}
      {needsCode && signIn.jobId ? (
        <CloudSignInCodeField jobId={signIn.jobId} instanceId={instanceId} className="text-[12px]" onSent={refreshAccountCloudLaunches} />
      ) : null}
      {needsCode && !signIn.jobId ? (
        <p className="m-0 text-[12px]" style={{ color: "var(--kit-text-2)" }}>The computer isn't ready for the code yet. It asks for it in a moment.</p>
      ) : null}
      {signIn.kind === "api_key" ? (
        <form
          className="flex min-w-[220px] items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <input
            className="kit-input min-w-0 flex-1"
            data-size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your key"
            aria-label="Key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="kit-btn" data-size="sm" disabled={busy || !key.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}
      {saved && !error ? (
        <p className="m-0 text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>Saved. The chat starts when the sign-in is done.</p>
      ) : null}
      {error ? (
        <Banner layout="inline" model={{ id: "cloud-setup-sign-in", tone: "error", title: "The sign-in didn't go through", detail: error }} />
      ) : null}
    </div>
  );
}

type CardPhase = "working" | "ready" | "failed" | "cancelled";

const CARD_TITLE: Record<CardPhase, string> = {
  working: "Getting ADE Cloud ready",
  ready: "Your chat is on ADE Cloud",
  failed: "ADE Cloud couldn't start this chat",
  cancelled: "Chat cancelled",
};

function cardPhaseOf(entry: AccountCloudLaunchEntry): CardPhase {
  const record = entry.record;
  if (entry.startError != null || record?.state === "failed") return "failed";
  if (record?.state === "cancelled") return "cancelled";
  if (record?.sessionId && (record.state === "running" || record.state === "done")) return "ready";
  return "working";
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
  onHide,
}: {
  entry: AccountCloudLaunchEntry;
  /** Opens the chat on the cloud computer once it exists. */
  onOpenChat?: (record: CloudLaunchRecord) => void;
  /** Takes a card whose chat started off the screen ("Hide"). */
  onHide?: () => void;
}) {
  const record = entry.record;
  const provider = record?.request?.chat?.provider ?? entry.request?.chat?.provider ?? null;
  const steps = cloudSetupStepStates(record);
  const [draft, setDraft] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const phase = cardPhaseOf(entry);
  const failed = phase === "failed";
  const ready = phase === "ready";
  const working = phase === "working";
  const failureReason = entry.startError?.trim() || record?.error?.trim() || null;
  const signIn = record?.signIn ?? null;
  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelAccountCloudLaunch(entry.launchId);
    } catch (error) {
      // The server refuses once the agent started (`launch_started`); the card says so.
      setCancelError(extractError(error));
    } finally {
      setCancelling(false);
    }
  };

  const rows: SetupStep[] = [
    {
      id: "computer",
      title: "Computer started",
      state: entry.startError ? "failed" : steps.computer,
      detail: record?.state === "needs_approval" && record.approval ? (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[12px]" style={{ color: "var(--kit-text-2)" }}>Confirm the computer's sign-in to your account.</span>
          <button type="button" className="kit-btn" data-size="sm" onClick={() => openExternalUrl(record.approval!.url)}>
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
      detail: signIn && record?.state === "waiting_for_sign_in"
        ? <SignInDetail key={signIn.jobId ?? signIn.signInId ?? signIn.kind} signIn={signIn} instanceId={record.instanceId} />
        : undefined,
    },
    { id: "send", title: "Send your message", state: steps.send },
  ];

  const pending = entry.messages.filter((message) => message.state !== "delivered");
  const messageNotSent = (message: AccountCloudLaunchEntry["messages"][number]) => message.state === "failed" || failed || phase === "cancelled";
  const messageTag = (message: AccountCloudLaunchEntry["messages"][number]) => {
    if (messageNotSent(message)) return "Not sent";
    return message.state === "sending" ? "Sending" : "Waiting";
  };
  const canQueue = working && record != null;

  return (
    <section className="kit-card w-full" aria-label="Getting ADE Cloud ready" data-testid="ade-cloud-setup-card">
      <header className="kit-card-head">
        {CARD_TITLE[phase]}
        {working && record ? (
          <button type="button" className="kit-card-head-action" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
        {(ready || failed) && onHide && accountCloudLaunchHideable(entry) ? (
          <button type="button" className="kit-card-head-action" onClick={onHide}>
            Hide
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
                <span className="kit-tag shrink-0" data-tone={messageNotSent(message) ? "crit" : undefined}>
                  {messageTag(message)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {cancelError ? (
          <Banner layout="inline" model={{ id: `cloud-setup-cancel-${entry.launchId}`, tone: "error", title: "The chat wasn't cancelled", detail: cancelError }} />
        ) : null}
        {failed ? (
          <Banner
            layout="inline"
            model={{
              id: `cloud-setup-failed-${entry.launchId}`,
              tone: "error",
              title: entry.startError ? "The chat didn't start" : "The computer stopped before the chat started",
              // The server's sentence once: the report's raw error is the same
              // text, so the notice hides its "›" line. The message rows above
              // already say "Not sent".
              detail: failureReason ?? "ADE Cloud didn't say why.",
              actions: [{ label: "Retry", onClick: () => void retryAccountCloudLaunch(entry.launchId) }],
              report: { surface: "cloud_setup_card", code: "launch_failed", technicalDetail: failureReason },
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
        {working ? (
          <p className="m-0 text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>
            You can close this tab. ADE Cloud sends your message when the computer is ready.
          </p>
        ) : null}
      </div>
    </section>
  );
}
