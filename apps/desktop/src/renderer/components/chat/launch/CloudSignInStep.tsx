import { useState } from "react";
import { cloudSignInStepWords, type CloudSignInStepFacts, type CloudSignInStepWords } from "../../../../shared/cloudSignInStep";
import { extractError } from "../../../lib/format";
import { askAdeFreeModelsConsent } from "../../shared/ModelPicker/AdeFreeModelsConsentDialog";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/notice";
import { CloudSignInCodeField } from "./CloudSignInCodeField";

/**
 * A cloud start's provider sign-in step: what to do, what changed, the time
 * left, what the wait costs (the server's sentence), the pasted-code box, and
 * the ways out. The same on the desktop launch card, the web setup card and
 * the queued message card (`launchId` null: no free-model button there).
 *
 * Every call here is an account call: the code goes by the computer's
 * instance id, the free-model move by the launch id. No pin.
 */
export function CloudSignInStep({
  signIn,
  instanceId,
  launchId,
  testId,
  className,
  metaClassName,
  onChanged,
}: {
  signIn: CloudSignInStepFacts;
  /** The DAEX Cloud computer that waits. */
  instanceId: string | null;
  /** The server launch, for "Start with … instead"; null for a queued message. */
  launchId: string | null;
  testId?: string;
  className?: string;
  metaClassName?: string;
  /** Something changed on the server (a code went, the chat moved): the caller reads the launch again. */
  onChanged?: () => void;
}) {
  // Worked out on each render (the card re-renders as the launch is read); no timer of its own.
  const words = cloudSignInStepWords(signIn, Date.now());
  const detail = [words.instruction, words.reason].filter(Boolean).join(" ");
  const meta = [words.timeLeft, words.charge].filter(Boolean).join(" ");
  return (
    <div className={className} data-testid={testId}>
      <Banner
        layout="inline"
        model={{
          id: testId ?? "cloud-sign-in-step",
          tone: "info",
          title: words.title,
          ...(detail ? { detail } : {}),
          ...(signIn.url ? { actions: [{ label: "Open sign-in", href: signIn.url }] } : {}),
        }}
      />
      {meta ? <p className={cn("mt-1.5 text-muted-fg", metaClassName)}>{meta}</p> : null}
      {signIn.needsPastedCode && signIn.jobId ? (
        <CloudSignInCodeField
          // A new link (a restart after a refused or expired code) starts the box fresh.
          key={`${signIn.jobId}:${signIn.url ?? ""}`}
          jobId={signIn.jobId}
          instanceId={instanceId}
          className={cn("mt-1.5", metaClassName)}
          onSent={onChanged}
        />
      ) : null}
      <CloudSignInWayOuts signIn={signIn} words={words} launchId={launchId} className={metaClassName} onChanged={onChanged} />
    </div>
  );
}

/** The ways out of the step, each only when the server's field says so: a free model (a launch only), Share my sign-ins. */
export function CloudSignInWayOuts({ signIn, words, launchId, className, onChanged }: {
  signIn: CloudSignInStepFacts;
  words: CloudSignInStepWords;
  launchId: string | null;
  className?: string;
  onChanged?: () => void;
}) {
  return (
    <>
      {launchId && signIn.freeModel && words.freeModelButton ? (
        <FreeModelWayOut launchId={launchId} label={words.freeModelButton} note={words.freeModelNote} className={className} onMoved={onChanged} />
      ) : null}
      {words.ownComputer ? <p className={cn("mt-1.5 text-muted-fg", className)}>{words.ownComputer}</p> : null}
    </>
  );
}

/** "Start with {model} instead": the same message on the same computer, on DAEX Free Models. */
function FreeModelWayOut({ launchId, label, note, className, onMoved }: {
  launchId: string;
  label: string;
  note: string | null;
  className?: string;
  onMoved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);

  const move = async () => {
    if (busy || moved) return;
    setBusy(true);
    setError(null);
    try {
      const call = window.ade?.cloud?.launchFreeModel;
      if (!call) throw new Error("This app can't do that yet. Update it and try again.");
      let answer = await call({ launchId });
      // The account hasn't said yes to DAEX Free Models yet: ask once, then try again.
      if (!answer.ok && answer.code === "free_models_consent") {
        if (!(await askAdeFreeModelsConsent())) return;
        answer = await call({ launchId });
      }
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      setMoved(true);
      onMoved?.();
    } catch (cause) {
      setError(extractError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("mt-2", className)}>
      <button
        type="button"
        className="kit-btn"
        data-size="sm"
        data-testid="cloud-sign-in-free-model"
        disabled={busy || moved}
        onClick={() => void move()}
      >
        {moved ? "Starting the chat…" : busy ? "Switching…" : label}
      </button>
      {note && !moved ? <p className="mt-1 text-muted-fg">{note}</p> : null}
      {error ? <p role="alert" className="mt-1 text-red-400">{error}</p> : null}
    </div>
  );
}
