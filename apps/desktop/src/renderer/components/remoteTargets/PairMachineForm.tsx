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
    return "That PIN didn't work. Check the 6-digit code shown on the other machine and try again.";
  }
  if (/unreachable|timed out|timeout|ECONN|ENOTFOUND|network|connect|offline/i.test(message)) {
    return "Couldn't reach that machine. Make sure it's awake and on the same network, Tailscale, or relay.";
  }
  return message || "Pairing failed.";
}

type PairMachineFormProps = {
  defaultDeviceName: string;
  busy?: boolean;
  /** Runs after pairing succeeds; parent connects on the returned target id. */
  onPaired: (targetId: string) => void | Promise<void>;
};

/**
 * Pair tab: paste a pairing code/link, enter the 6-digit PIN, confirm this
 * Mac's name, and connect. The link is validated live via parsePairingInput so
 * the machine name shows before the user commits.
 */
export function PairMachineForm({
  defaultDeviceName,
  busy = false,
  onPaired,
}: PairMachineFormProps) {
  const [rawInput, setRawInput] = useState("");
  const [parsed, setParsed] = useState<RemoteRuntimeParsedPairingInput | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [pin, setPin] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDeviceName((current) => (current.trim() ? current : defaultDeviceName));
  }, [defaultDeviceName]);

  const trimmedInput = rawInput.trim();

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
              "That doesn't look like a valid pairing code or link.",
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
    () => Boolean(parsed) && pinValid && deviceName.trim().length > 0 && !busy && !submitting,
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
        deviceName: deviceName.trim(),
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
      <label style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>Pairing code or link</span>
        <input
          value={rawInput}
          onChange={(event) => setRawInput(event.target.value)}
          placeholder="Paste the code or link from the other machine"
          style={fieldStyle}
          disabled={busy || submitting}
          autoComplete="off"
          spellCheck={false}
        />
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
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr)", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>PIN</span>
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="6-digit"
            style={{ ...fieldStyle, letterSpacing: "0.24em" }}
            disabled={busy || submitting}
            autoComplete="off"
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={LABEL_STYLE}>This device's name</span>
          <input
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder="Mac name"
            style={fieldStyle}
            disabled={busy || submitting}
          />
        </label>
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
