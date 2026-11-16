import { useState } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { extractError } from "../../../lib/format";

/**
 * The code from a provider's sign-in page (Claude's `url_paste`: the page
 * shows a code that goes back to the computer's sign-in job). It goes to the
 * ADE Cloud computer the launch made, never this window's machine:
 * - the desktop sends `providers.remoteSignInCode` to that computer's pin
 *   (`cloud.binding`, its own connection);
 * - the web has no direct line to a machine's brain, so it sends the code
 *   through the account server, which runs the same call on that computer
 *   (`POST /cloud/instances/:id/sign-ins/:job/code`).
 * A refused code shows the provider's reason, and the field stays.
 */
export function CloudSignInCodeField({
  jobId,
  pin,
  instanceId,
  className,
}: {
  jobId: string;
  /** The cloud computer's pin, once its project is there. */
  pin: (OpenProjectBinding & { kind: "remote" }) | null;
  instanceId: string | null;
  className?: string;
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
      const direct = window.ade?.remoteRuntime?.submitProviderSignInCode;
      const viaAccount = window.ade?.cloudLaunches?.sendSignInCode;
      let refusal: string | null = null;
      if (direct && pin) {
        const answer = await direct(pin.targetId, { jobId, code });
        refusal = answer.state === "failed" ? answer.reason ?? "The code didn't work. Open the page again for a new one." : null;
      } else if (viaAccount && instanceId) {
        const answer = await viaAccount(instanceId, jobId, code);
        refusal = answer.state === "failed" ? answer.reason ?? "The code didn't work. Open the page again for a new one." : null;
      } else {
        throw new Error("The computer isn't ready for the code yet. Try again in a moment.");
      }
      if (refusal) {
        setError(refusal);
        return;
      }
      setValue("");
      setSent(true);
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
        <p role="alert" className="m-0 mt-1.5" style={{ color: "var(--color-danger, #ef4444)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
