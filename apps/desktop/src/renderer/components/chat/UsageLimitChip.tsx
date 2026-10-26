import React from "react";
import { Clock } from "@phosphor-icons/react";

import type { AgentChatUsageLimitResume, OpenProjectBinding } from "../../../shared/types";
import { usageLimitChip } from "../../../shared/usageLimitResumePresentation";
import { showToast } from "../app/toast/toastStore";
import { StatusChip, type StatusChipAction } from "../ui/notice/StatusChip";
import { useAgentChatApi } from "./agentChatApi";

/**
 * The usage-limit chip in the composer's status row. It sits beside the other
 * chips (lifecycle, branch, compact-first) and works like compact-first: one
 * toggle turns auto-resume off (`Cancel`) and back on (`Resume in 2h`). When
 * another account has room and ADE has not already moved the chat there,
 * `Continue on <account>` sits beside it. A provider that only says "limit
 * reached" gets the bare chip.
 */
export function UsageLimitChip({
  sessionId,
  resume,
  runtimePin = null,
}: {
  sessionId: string;
  resume: AgentChatUsageLimitResume;
  runtimePin?: OpenProjectBinding | null;
}) {
  const agentChatApi = useAgentChatApi();
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [busy, setBusy] = React.useState(false);
  const model = usageLimitChip(resume, nowMs);

  // One interval, sized by the model: a minute while the reset is far off, a
  // second inside the last five minutes, none for a static state.
  const refreshMs = model.refreshMs;
  React.useEffect(() => {
    if (refreshMs == null) return undefined;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), refreshMs);
    return () => window.clearInterval(intervalId);
  }, [refreshMs]);

  // An action belongs to the state and chat it was pressed for. Bumping the run
  // token orphans one still in flight, so its late result neither speaks about
  // a state nobody is looking at nor clears a newer press's `busy`.
  const runTokenRef = React.useRef(0);
  React.useEffect(() => {
    runTokenRef.current += 1;
    setBusy(false);
  }, [resume.state, sessionId]);

  const run = (action: () => Promise<string | null>) => {
    if (busy) return;
    const token = runTokenRef.current;
    setBusy(true);
    void action()
      .then((refusal) => {
        if (token !== runTokenRef.current) return;
        if (refusal) showToast({ tone: "warning", title: "Usage limit", message: refusal });
      })
      .catch((error: unknown) => {
        if (token !== runTokenRef.current) return;
        showToast({ tone: "error", title: "Usage limit", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (token === runTokenRef.current) setBusy(false);
      });
  };

  const actions: StatusChipAction[] = [];
  const alternate = resume.alternateAccount;
  if (alternate?.instanceId && alternate.label && resume.state !== "resuming") {
    actions.push({
      label: `Continue on ${alternate.label}`,
      disabled: busy,
      testId: "usage-limit-continue-on-account",
      onClick: () => run(async () => {
        const send = agentChatApi.continueUsageLimitOnAlternate;
        if (typeof send !== "function") return "This ADE runtime can't switch accounts yet. Update the app and try again.";
        const result = await send({ sessionId }, runtimePin);
        return result.ok ? null : result.message;
      }),
    });
  }
  if (model.toggle) {
    const { enable } = model.toggle;
    actions.push({
      label: model.toggle.label,
      title: model.toggle.title,
      disabled: busy,
      testId: "usage-limit-auto-resume-toggle",
      onClick: () => run(async () => {
        await agentChatApi.updateSession({ sessionId, autoContinueAtUsageLimit: enable }, runtimePin);
        return null;
      }),
    });
  }

  return (
    <StatusChip
      tone="warning"
      icon={<Clock size={10} weight="bold" />}
      label="Usage limit reached"
      detail={model.detail}
      tooltip={model.tooltip}
      actions={actions}
      testId="usage-limit-chip"
      dataAttributes={{ "data-usage-limit-state": resume.state }}
    />
  );
}
