import { useState } from "react";
import { extractError } from "../../../lib/format";
import { Banner } from "../../ui/notice";

/**
 * The code from a provider's sign-in page (Claude's `url_paste`: the page
 * shows a code that goes back to the computer's sign-in job). It goes to the
 * ADE Cloud computer the launch made, never this window's machine: the
 * account server runs it on that computer, chosen by its instance id
 * (`POST /cloud/instances/:id/sign-ins/:job/code`), on desktop and web alike.
 * A refused code shows the provider's reason, and the field stays.
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
  const [sent, setSent] = useState(false);

  const send = async () => {
    const code = value.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sendCode = window.ade?.cloud?.sendLaunchSignInCode;
      if (!sendCode || !instanceId) throw new Error("The computer isn't ready for the code yet. Try again in a moment.");
      const answer = await sendCode({ instanceId, jobId, code });
      if (answer.state === "failed") {
        setError(answer.reason ?? "The code didn't work. Open the sign-in page again for a new one.");
        return;
      }
      setValue("");
      setSent(true);
      onSent?.();
    } catch (cause) {
      setError(extractError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <p className={className} style={{ color: "var(--kit-text-2)", margin: 0 }}>
        Code sent. The chat starts when the sign-in is done.
      </p>
    );
  }
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
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
        />
        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={busy || !value.trim()} onClick={() => void send()}>
          {busy ? "Sending…" : "Send code"}
        </button>
      </div>
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
