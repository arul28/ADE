import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Robot } from "@phosphor-icons/react";
import {
  CLOUD_LIMITS_PRESETS,
  CLOUD_MACHINES_PER_DAY_CHOICES,
  CLOUD_SHAPES,
  cloudLimitsPresetOf,
  type CloudAgentLimits,
} from "../../../shared/adeCloud";
import { IntegrationChoice } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { adeCloudAccountCallFn, runAccountCall } from "../../lib/adeCloudAccountRead";
import { isWebClientMode } from "../../lib/webClientMode";
import { captureError } from "../../../shared/sentry/capture";
import { parseCodedErrorMessage } from "../../../shared/codedError";
import { BRAND } from "../../../shared/brand";

/** A save that named an older revision: another device saved first. */
const LIMITS_CHANGED_SENTENCE = `Your limits changed on another device. ${BRAND.NAME} loaded the new ones.`;

class LimitsRouteMissing extends Error {}
/** The account answered with its own sentence (a refusal, a conflict): news for the person, not an ADE bug. */
class LimitsRefused extends Error {}

/** What the card shows under the limits; `refused` carries no Report. */
type LimitsNotice = { text: string; refused: boolean };

/** The account's answer that is not a limits answer: its own sentence for a 4xx, else an ADE failure (5xx, no answer). */
function accountFailure(answer: { status: number; message: string }): Error {
  if (answer.status === 404) return new LimitsRouteMissing(answer.message);
  return answer.status >= 400 && answer.status < 500 ? new LimitsRefused(answer.message) : new Error(answer.message);
}

/**
 * A failed read or save as the card's notice. The web path throws
 * `LimitsRefused`; this desktop's main process sends the server's refusal as
 * a `limits_refused` coded message, since IPC keeps only the message.
 */
function noticeOf(error: unknown, fallback: string): LimitsNotice {
  if (error instanceof LimitsRefused) return { text: error.message || fallback, refused: true };
  const coded = parseCodedErrorMessage(error);
  if (coded.code === "limits_refused") return { text: coded.message || fallback, refused: true };
  return { text: ipcErrorMessage(error) || fallback, refused: false };
}

/**
 * Settings › ADE Cloud › What agents may do alone: what an agent may
 * do when nobody is watching (a full-auto chat, an automation), as one yes/no
 * with its limits under Yes (the preset is derived). Account-wide (the account
 * vault), so it asks this desktop's main process with no pin.
 */
export function CloudAgentLimitsCard() {
  const bridge = window.ade.cloud;
  const [limits, setLimits] = useState<CloudAgentLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LimitsNotice | null>(null);
  // The web app reads and saves the limits in the account (`/cloud/limits`),
  // with no computer on. A server without the route (404) goes back to the
  // computer path, as before. The desktop's main process does the same itself.
  const [viaAccount, setViaAccount] = useState(() => isWebClientMode() && adeCloudAccountCallFn() !== null);
  // The revision the shown limits came with: a save names it, so a save over
  // another device's newer one is refused instead of undoing it.
  const revisionRef = useRef<string | null>(null);

  const readAccount = useCallback(async (): Promise<CloudAgentLimits | null> => {
    const answer = await runAccountCall({ call: "limits" });
    if (!answer) return null;
    if (!answer.ok) throw accountFailure(answer);
    if (!answer.result) return null;
    revisionRef.current = answer.result.revision;
    return answer.result.limits;
  }, []);

  const load = useCallback(async () => {
    const read = viaAccount ? readAccount : bridge?.getAgentLimits;
    if (!read) return;
    try {
      const next = await read();
      setLimits(next);
      // No answer: no computer could read them (the web app with every computer offline, or an older ADE on it).
      setError(next
        ? null
        : {
            refused: true,
            text: viaAccount
              ? `${BRAND.NAME} couldn't read what agents may do from your ${BRAND.NAME} account. Try again soon.`
              : `${BRAND.NAME} couldn't read what agents may do on their own. Connect a computer, or update ${BRAND.NAME} on it.`,
          });
    } catch (loadError) {
      if (loadError instanceof LimitsRouteMissing) {
        setViaAccount(false);
        return;
      }
      setError(noticeOf(loadError, "Couldn't read what agents may do."));
    }
  }, [bridge, readAccount, viaAccount]);

  const writeAccount = useCallback(async (next: Partial<CloudAgentLimits>): Promise<CloudAgentLimits | null> => {
    const answer = await runAccountCall({ call: "saveLimits", update: { limits: next, ifRevision: revisionRef.current } });
    if (!answer) return null;
    if (!answer.ok) {
      if (answer.code === "limits_changed") {
        const fresh = await readAccount().catch((readError: unknown) => {
          captureError(readError, { level: "warning", handled: true, fingerprint: ["ade-cloud", "limits-reread-after-conflict"] });
          return null;
        });
        if (fresh) setLimits(fresh);
        throw new LimitsRefused(LIMITS_CHANGED_SENTENCE);
      }
      throw accountFailure(answer);
    }
    if (!answer.result) return null;
    revisionRef.current = answer.result.revision;
    return answer.result.limits;
  }, [readAccount]);

  useEffect(() => {
    void load();
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    return () => off?.();
  }, [bridge, load]);

  const write = viaAccount ? writeAccount : bridge?.setAgentLimits;
  if (!write || (!viaAccount && !bridge?.getAgentLimits)) return null;

  const save = async (next: Partial<CloudAgentLimits>) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await write(next);
      if (saved) setLimits(saved);
    } catch (saveError) {
      setError(noticeOf(saveError, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  };

  const preset = limits ? cloudLimitsPresetOf(limits) : null;
  const setLimit = (patch: Partial<CloudAgentLimits>) => {
    if (limits) void save({ ...limits, ...patch });
  };
  const disabled = busy || limits == null;

  const unattended = limits?.unattendedSpend ?? null;
  // "Yes" starts from Balanced's limits when the saved ones are the "No" preset's leftovers.
  const allow = (value: boolean) => {
    if (!limits || limits.unattendedSpend === value) return;
    void save(value && preset === "ask" ? CLOUD_LIMITS_PRESETS.balanced : { ...limits, unattendedSpend: value });
  };

  return (
    <section id="cloud-agent-limits" data-settings-anchor="cloud-agent-limits" className="kit-card adecd-card" aria-label="What agents may do">
      <header className="kit-card-head">
        <Robot size={14} />
        What agents may do alone
      </header>
      <div className="kit-card-body adecd-limits">
        <p className="adecd-lead">An agent you're watching always asks in its chat first. These rules are for a full-auto chat or an automation, when nobody is watching. Outside agents (through {BRAND.NAME} MCP) may use {BRAND.CLOUD_NAME} on paid plans only.</p>
        <div className="kit-panel adecd-limit-rows">
          <div className="adecd-limit-row">
            <div><b>May they make or change computers?</b></div>
            <IntegrationChoice
              label="When nobody is watching, may agents make or change computers?"
              value={unattended == null ? null : unattended ? "yes" : "no"}
              disabled={disabled}
              onChange={(choice) => allow(choice === "yes")}
              options={[
                { value: "no", label: "No, they ask you first" },
                { value: "yes", label: "Yes, within these limits" },
              ]}
            />
          </div>
          {unattended ? (
            <>
              <div className="adecd-limit-row">
                <div><b>New computers a day</b><small>Made, copied or moved by agents</small></div>
                <IntegrationChoice
                  label="New computers a day"
                  value={limits?.machinesPerDay ?? null}
                  disabled={disabled}
                  sentenceCase={false}
                  onChange={(count) => setLimit({ machinesPerDay: count })}
                  options={CLOUD_MACHINES_PER_DAY_CHOICES.map((count) => ({ value: count, label: String(count) }))}
                />
              </div>
              <div className="adecd-limit-row">
                <div><b>Largest size</b><small>Bigger computers use credits faster</small></div>
                <IntegrationChoice
                  label="Largest size"
                  value={limits?.maxShape ?? null}
                  disabled={disabled}
                  sentenceCase={false}
                  onChange={(maxShape) => setLimit({ maxShape })}
                  options={CLOUD_SHAPES.map((shape) => ({ value: shape.id, label: shape.label, title: `${shape.cpu} CPU · ${shape.memoryGb} GB` }))}
                />
              </div>
            </>
          ) : null}
        </div>

        <p className="adecd-limits-note"><Lock size={12} weight="fill" /> Always yours to decide: changing a computer's size, keeping one awake for good, raising these limits, and deleting a computer an agent didn't make.</p>
        {error ? (
          // A 409 means another device saved first and ADE loaded its limits:
          // news. A refusal says the server's sentence. Neither is a bug, so
          // neither has Report; only a throw from ADE itself does.
          <Banner
            layout="inline"
            model={{
              id: "cloud-limits-error",
              tone: error.text === LIMITS_CHANGED_SENTENCE ? "info" : error.refused ? "warning" : "error",
              title: "What agents may do",
              detail: error.text,
              actions: [{ label: "Dismiss", onClick: () => setError(null) }],
              ...(error.refused ? { report: false as const } : {}),
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
