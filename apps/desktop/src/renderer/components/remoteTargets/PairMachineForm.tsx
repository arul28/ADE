import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, primaryButton } from "../lanes/laneDesignTokens";
import { extractError } from "../../lib/format";
import type { RemoteRuntimeParsedPairingInput } from "../../../shared/types";

const fieldStyle: CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.03)",
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 10px",
  outline: "none",
};

function friendlyPairError(error: unknown): string {
  const message = extractError(error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  if (/pin|unauthor|forbidden|401|403|invalid code/i.test(message)) {
    return "That code didn't work. Check the six digits shown on the other Mac and try again.";
  }
  if (/unreachable|timed out|timeout|ECONN|ENOTFOUND|network|connect|offline/i.test(message)) {
    return "Couldn't reach that Mac. Make sure ADE is open there, then try again.";
  }
  return message || "Pairing failed.";
}

type PairMachineFormProps = {
  defaultDeviceName: string;
  initialInput?: string | null;
  busy?: boolean;
  /** Runs after pairing succeeds; parent connects on the returned target id. */
  onPaired: (targetId: string) => void | Promise<void>;
};

/**
 * Pair tab: paste a pairing link, enter the 6-digit PIN, and connect. The link
 * is validated live via parsePairingInput so the machine name shows before the
 * user commits.
 */
export function PairMachineForm({
  defaultDeviceName,
  initialInput = null,
  busy = false,
  onPaired,
}: PairMachineFormProps) {
  const [rawInput, setRawInput] = useState(initialInput ?? "");
  const [parsed, setParsed] = useState<RemoteRuntimeParsedPairingInput | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deviceName = defaultDeviceName.trim() || "This Mac";

  const trimmedInput = rawInput.trim();

  useEffect(() => {
    if (initialInput) setRawInput(initialInput);
  }, [initialInput]);

  useEffect(() => {
    if (!trimmedInput) {
      setParsed(null);
      setParseError(null);
      setParsing(false);
      return;
    }
    let cancelled = false;
    setParsing(true);
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.ade.remoteRuntime.parsePairingInput(trimmedInput);
          if (cancelled) return;
          setParsed(result);
          setParseError(null);
        } catch (err) {
          if (cancelled) return;
          setParsed(null);
          setParseError(
            extractError(err).replace(/^Error:\s*/i, "").trim() ||
              "That doesn't look like a valid pairing link.",
          );
        } finally {
          if (!cancelled) setParsing(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmedInput]);

  const pinValid = /^\d{6}$/.test(pin.trim());
  const canSubmit = useMemo(
    () => Boolean(parsed) && pinValid && !busy && !submitting,
    [parsed, pinValid, deviceName, busy, submitting],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const { targetId } = await window.ade.remoteRuntime.pairWithMachine({
        input: trimmedInput,
        pin: pin.trim(),
        deviceName,
      });
      await onPaired(targetId);
    } catch (err) {
      setError(friendlyPairError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: 12 }}>
      <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.45 }}>
        {initialInput
          ? "ADE found this Mac nearby. On that Mac, open Connections and choose Share, then enter its 6-digit code."
          : "On the other Mac, open Connections and choose Share. Paste its link here, then enter the 6-digit code."}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>{initialInput ? "Nearby Mac" : "Pairing link"}</span>
        {!initialInput ? (
          <input
            aria-label="Pairing link"
            value={rawInput}
            onChange={(event) => setRawInput(event.target.value)}
            placeholder="Paste the link from the other Mac"
            style={fieldStyle}
            disabled={busy || submitting}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        {parsing ? (
          <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11.5 }}>
            Checking…
          </span>
        ) : parsed ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: COLORS.success,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
            }}
          >
            <CheckCircle size={14} weight="fill" />
            {parsed.machineName?.trim() || parsed.hostIdentity.name || "Machine"} ready to pair
          </span>
        ) : parseError ? (
          <span style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11.5 }}>
            {parseError}
          </span>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr)", gap: 12, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>6-digit code</span>
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="000000"
            style={{ ...fieldStyle, letterSpacing: "0.24em" }}
            disabled={busy || submitting}
            autoComplete="off"
          />
        </label>
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.4 }}>
          {initialInput
            ? "This confirms that you can see the code on the other Mac."
            : "This code is shown beside the pairing link."}
        </div>
      </div>

      {error ? (
        <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.45 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            ...primaryButton({ height: 36, padding: "0 16px", fontSize: 12 }),
            opacity: canSubmit ? 1 : 0.55,
          }}
        >
          {submitting ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
