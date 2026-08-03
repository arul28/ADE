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
import { useAsyncAction } from "../../hooks/useAsyncAction";
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
  /** The canonical pairing URL synthesized from the discovered nearby machine. */
  initialInput: string | null;
  busy?: boolean;
  /** Runs after pairing succeeds; parent connects on the returned target id. */
  onPaired: (targetId: string) => void | Promise<void>;
};

/**
 * First-time pairing with a nearby Mac: ADE discovered it on the network and
 * synthesized its pairing URL internally, so the user only confirms the machine
 * and types the 6-digit code shown in ADE on that Mac. There is no manual link
 * or address entry — nearby discovery is the only entry point.
 */
export function PairMachineForm({
  defaultDeviceName,
  initialInput,
  busy = false,
  onPaired,
}: PairMachineFormProps) {
  const [parsed, setParsed] = useState<RemoteRuntimeParsedPairingInput | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const deviceName = defaultDeviceName.trim() || "This Mac";

  const trimmedInput = initialInput?.trim() ?? "";

  useEffect(() => {
    if (!trimmedInput) {
      setParsed(null);
      setParseError(null);
      setParsing(false);
      return;
    }
    let cancelled = false;
    setParsing(true);
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
            "That doesn't look like a valid pairing target.",
        );
      } finally {
        if (!cancelled) setParsing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trimmedInput]);

  const pinValid = /^\d{6}$/.test(pin.trim());

  const { run: submitPairing, pending: submitting } = useAsyncAction({
    action: async () => {
      setError(null);
      const { targetId } = await window.ade.remoteRuntime.pairWithMachine({
        input: trimmedInput,
        pin: pin.trim(),
        deviceName,
      });
      await onPaired(targetId);
    },
    onError: (err) => setError(friendlyPairError(err)),
  });

  const canSubmit = useMemo(
    () => Boolean(parsed) && pinValid && !busy && !submitting,
    [parsed, pinValid, busy, submitting],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !trimmedInput) return;
    submitPairing();
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
      <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.45 }}>
        You haven't connected to this Mac before. Enter the pairing code shown in ADE on that Mac.
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <span style={LABEL_STYLE}>Nearby Mac</span>
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
            autoFocus
          />
        </label>
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.4 }}>
          This confirms that you can see the code on the other Mac.
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
