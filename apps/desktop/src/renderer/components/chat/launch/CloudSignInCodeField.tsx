import { useState } from "react";
import { extractError } from "../../../lib/format";
import { Banner } from "../../ui/notice";

/**
 * The code from a provider's sign-in page (Claude's `url_paste`: the page
 * shows a code that goes back to the computer's sign-in job). It goes to the
 * ADE Cloud computer the launch made, never this window's machine: the
 * account server runs it on that computer, chosen by its instance id
 * (`POST /cloud/instances/:id/sign-ins/:job/code`), on desktop and web alike.
 * The box stays after a send and reads "Checking the code…" while the
 * computer reads its verdict (`verdict` on the answer, from a DAEX that
 * reports one; an older computer answers `pending`). A refused code shows
 * the reason, and the field stays. Callers key it on the job and its link,
 * so a new link (a restart) starts it fresh.
 */
export function CloudSignInCodeField({
  jobId,
  instanceId,
  className,
  onSent,
}: {
  jobId: string;
  /** The ADE Cloud computer the launch made. */
  instanceId: string | null;
  className?: string;
  /** The computer took the code (the caller reads the launch again). */
  onSent?: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** After a send: what the computer answered (`accepted`: the sign-in took it; `pending`: no verdict yet). */
  const [sent, setSent] = useState<"accepted" | "pending" | null>(null);

  const send = async () => {
    const code = value.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sendCode = window.ade?.cloud?.sendLaunchSignInCode;
      if (!sendCode || !instanceId) throw new Error("The computer isn't ready for the code yet. Try again in a moment.");
      const answer = await sendCode({ instanceId, jobId, code });
      if (answer.state === "failed" || answer.verdict === "refused") {
        setError(answer.reason ?? "The code didn't work. Open the sign-in page again for a new one.");
        return;
      }
      setValue("");
      setSent(answer.state === "done" || answer.verdict === "accepted" ? "accepted" : "pending");
      onSent?.();
    } catch (cause) {
      setError(extractError(cause));
    } finally {
      setBusy(false);
    }
  };

  // The field stays: the sign-in can ask for another code on the same job.
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="kit-input"
          data-size="sm"
          style={{ flex: "1 1 200px" }}
          autoComplete="off"
          spellCheck={false}
          placeholder="Code from the sign-in page"
          aria-label="Code from the sign-in page"
          value={value}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setSent(null);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
        />
        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={busy || !value.trim()} onClick={() => void send()}>
          {busy ? "Checking…" : "Send code"}
        </button>
      </div>
      {busy ? (
        <p role="status" style={{ color: "var(--kit-text-2)", margin: "6px 0 0" }}>Checking the code…</p>
      ) : sent && !error ? (
        <p role="status" style={{ color: "var(--kit-text-2)", margin: "6px 0 0" }}>
          {sent === "accepted" ? "Code accepted. Starting the chat…" : "Code sent. The chat starts when the sign-in is done."}
        </p>
      ) : null}
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 6 }}
          model={{ id: `cloud-sign-in-code-${jobId}`, tone: "error", title: "The sign-in didn't go through", detail: error }}
        />
      ) : null}
    </div>
  );
}
