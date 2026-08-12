import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  CircleNotch,
  DesktopTower,
  DotsThreeVertical,
  Laptop,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  AdeAccountLocalMachineIdentity,
  AdeAccountMachinePairingRepairResult,
  AdeAccountMachineRemovalResult,
} from "../../../shared/types";
import { ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE } from "../../../shared/types/account";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import {
  COLORS,
  RADII,
  SANS_FONT,
  cardStyle,
  dangerButton,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import {
  accountSessionState,
  invalidateAccountMachines,
  publishAccountMachines,
  useAccountStatus,
  type AdeAccountMachine,
  type AdeAccountMachinesResult,
  type AdeAccountSessionState,
  type AdeAccountStatus,
} from "../../lib/account";
import {
  runAccountDeviceLogin,
  type AccountDeviceLoginPrompt,
} from "../../lib/accountLogin";
import {
  formatMachineEndpoint,
  relativeLastSeenPhrase,
} from "../remoteTargets/remoteMachineModel";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { isWebClientMode } from "../../lib/webClientMode";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { useBrainRepair } from "../../hooks/useBrainRepair";
import { BrainRepairButton } from "../settings/BrainRepairButton";

const MACHINES_REFRESH_MS = 30_000;
const ACCOUNT_MENU_WIDTH = 200;

type AccountBridge = {
  listMachines: () => Promise<AdeAccountMachinesResult>;
  getLocalMachineIdentity: () => Promise<AdeAccountLocalMachineIdentity>;
  removeMachine: (machineKey: string) => Promise<AdeAccountMachineRemovalResult>;
  repairMachinePairing: () => Promise<AdeAccountMachinePairingRepairResult>;
  renameMachine: (
    machineKey: string,
    customName: string | null,
  ) => Promise<AdeAccountMachine>;
  signOut: () => Promise<AdeAccountStatus>;
};

function accountBridge(): Partial<AccountBridge> | undefined {
  return (window.ade as typeof window.ade & { account?: Partial<AccountBridge> }).account;
}

// ---------------------------------------------------------------------------
// Confirmation sheet — a calm modal consistent with the settings surface.
// ---------------------------------------------------------------------------

export function ConfirmSheet({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "color-mix(in srgb, #000 55%, transparent)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <div
        style={cardStyle({
          width: 400,
          maxWidth: "100%",
          padding: 0,
          overflow: "hidden",
          background: COLORS.cardBgSolid,
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
          boxShadow: "0 24px 64px -30px rgba(0,0,0,0.82)",
        })}
      >
        <div style={{ padding: "18px 20px 4px" }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
            {title}
          </div>
          <div style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.55, color: COLORS.textSecondary }}>
            {body}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "16px 20px 18px" }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={outlineButton({ height: 34, fontSize: 12.5, padding: "0 14px", opacity: busy ? 0.6 : 1 })}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            autoFocus
            onClick={onConfirm}
            style={(danger ? dangerButton : primaryButton)({
              height: 34,
              fontSize: 12.5,
              padding: "0 16px",
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            })}
          >
            {busy ? <CircleNotch size={14} weight="bold" className="animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the user is told after a reconnect attempt, and how it is styled. */
type ReconnectOutcome = { tone: "success" | "warning" | "danger"; message: string };

/** Join the brain's reason onto our sentence without doubling its punctuation. */
function sentence(reason: string): string {
  const trimmed = reason.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Turn a repair result into copy that stays true to what actually happened.
 *
 * Read against `repairMachinePairing` in ade-cli, not by intuition:
 * `published` is true only on the path that also sets `repaired`, and a
 * successful re-pair reports `pushRestored: false` whenever the push half was
 * never gated — so `!pushRestored` on its own does NOT mean "still muted".
 *
 * The state that does mean it is `repaired && wasRevoked && !pushRestored`:
 * something was gated, the directory took the machine back, and the push
 * revocation did not lift with it. That machine is on the roster and silent —
 * the exact failure the ade-cli side refuses to paper over — so it must not be
 * reported as a clean reconnect.
 */
function describeReconnectOutcome(
  result: AdeAccountMachinePairingRepairResult,
): ReconnectOutcome {
  if (result.repaired) {
    if (!result.wasRevoked) {
      return { tone: "success", message: "This computer is already connected to your account." };
    }
    return result.pushRestored
      ? {
          tone: "success",
          message: "This computer is back on your account. Activity and alerts are delivering again.",
        }
      : {
          tone: "warning",
          message:
            "This computer is back on your account, but it isn't delivering Activity yet. Reopen ADE on this computer to finish.",
        };
  }
  // Nothing was gated and the brain skipped the publish — no work to report.
  if (result.state === "not_revoked") {
    return { tone: "success", message: "This computer is already connected to your account." };
  }
  return {
    tone: "danger",
    message: result.reason
      ? `Couldn't reconnect this computer: ${sentence(result.reason)} It's still disconnected from your account.`
      : "Couldn't reconnect this computer, so it's still disconnected from your account. Try again in a moment.",
  };
}

/**
 * Does this failed reconnect mean "prove a fresh sign-in", rather than a
 * transport, configuration, or brain-availability failure?
 *
 * Decided by `reasonCode`, the brain's machine-readable answer. Both refusals
 * still share `state: "http_error"`, but they no longer share a discriminator:
 * `pairing_authentication_required` is the recoverable one, and a present code
 * is authoritative — `machine_revoked` means the sentence must NOT be consulted
 * to talk us into a sign-in the directory did not ask for.
 *
 * Fails CLOSED: an unrecognised or absent answer reports the brain's reason
 * as-is rather than dragging the user into a browser sign-in that would not
 * have fixed anything.
 */
export function reconnectNeedsFreshSignIn(
  result: AdeAccountMachinePairingRepairResult,
): boolean {
  if (result.repaired) return false;
  if (result.reasonCode) {
    return result.reasonCode === ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE;
  }
  // COMPATIBILITY SHIM — older brain only.
  //
  // Brains before `reasonCode` existed encoded this refusal solely in the
  // user-facing sentence `PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE` (see
  // `apps/ade-cli/src/services/account/accountMachinePublisherService.ts`; the
  // renderer cannot import that module because it pulls in Node, so a test pins
  // the two together). Matched loosely so small copy edits in those already-
  // shipped builds do not break their recovery path.
  //
  // Delete this branch — and the test that pins the sentence — once the
  // supported brain floor includes `reasonCode`.
  return /\bsign in\b[\s\S]*\bagain on this computer\b/i.test(result.reason ?? "");
}

/**
 * Body copy when this computer is missing from the account directory.
 *
 * Absence is not proof of removal: a publish gap, a split sync listener, or an
 * expired sign-in all produce the same empty row. Never claim the computer was
 * removed as fact.
 */
export function describeThisComputerMissing(sessionState: AdeAccountSessionState): {
  title: string;
  body: string;
} {
  const title = "This computer isn't on your account";
  switch (sessionState) {
    case "expired":
      return {
        title,
        body: "This computer's ADE sign-in expired, so it stopped publishing itself to your account. Sign in again, then Reconnect. If the row still doesn't come back, Repair restarts ADE's background service on this computer.",
      };
    case "unreadable":
      return {
        title,
        body: "ADE can't read this computer's sign-in, so it isn't publishing itself. Repair the stored sign-in, then Reconnect.",
      };
    case "signed_out":
    case "active":
      return {
        title,
        body: "This computer isn't listed on your account, so it isn't sharing Activity and your other computers can't reach it. That can happen if it was removed, or if ADE on this computer stopped publishing. Reconnect puts it back. If it still doesn't stick, Repair restarts ADE's background service here, then try Reconnect again.",
      };
    default: {
      const _exhaustive: never = sessionState;
      return _exhaustive;
    }
  }
}

function machineRouteHint(machine: AdeAccountMachine): string | null {
  const endpoint = machine.reachableEndpoints[0];
  if (!endpoint) return null;
  // Beginners never need the relay URL; the word is enough.
  if (endpoint.kind === "relay") return "Relay";
  return formatMachineEndpoint(endpoint);
}

function lastSeenLabel(lastSeenAt: number | null): string {
  const phrase = relativeLastSeenPhrase(lastSeenAt);
  return phrase ? `Last seen ${phrase}` : "Never seen";
}

// ---------------------------------------------------------------------------
// Signed-in: Your computers — the account directory, this computer pinned first.
// ---------------------------------------------------------------------------

export function YourMacsCard() {
  const webMode = isWebClientMode();
  const { status } = useAccountStatus();
  const missingCopy = describeThisComputerMissing(accountSessionState(status));
  const [result, setResult] = useState<AdeAccountMachinesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [localIdentity, setLocalIdentity] = useState<AdeAccountLocalMachineIdentity | null>(null);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AdeAccountMachine | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectOutcome, setReconnectOutcome] = useState<ReconnectOutcome | null>(null);
  const [signInPrompt, setSignInPrompt] = useState<AccountDeviceLoginPrompt | null>(null);
  // A ref, not state: the in-flight sign-in loop reads it between polls, and a
  // state value captured in that closure would stay false forever.
  const reconnectCancelledRef = useRef(false);

  // Returns what it loaded as well as storing it: the reconnect flow reports
  // its outcome from the directory's own answer, and reading it back out of
  // state would race the render that has not happened yet.
  const load = useCallback(async (): Promise<AdeAccountMachinesResult> => {
    const api = accountBridge();
    const unavailable: AdeAccountMachinesResult = {
      state: "unavailable",
      machines: [],
      message: null,
    };
    if (!api?.listMachines) {
      setResult(unavailable);
      setLoading(false);
      return unavailable;
    }
    try {
      const next = await api.listMachines();
      setResult(next);
      // Warm the shared cache so the Connections popover opens with this list
      // instead of racing its own cold fetch.
      publishAccountMachines(next);
      return next;
    } catch {
      setResult(unavailable);
      return unavailable;
    } finally {
      setLoading(false);
    }
  }, []);

  const repair = useBrainRepair(() => {
    invalidateAccountMachines();
    void load();
  });

  // Identify this computer once so it can be pinned and shielded from removal.
  useEffect(() => {
    let cancelled = false;
    const api = accountBridge();
    void api
      ?.getLocalMachineIdentity?.()
      .then((identity) => {
        if (!cancelled) setLocalIdentity(identity);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load now, then keep fresh while visible and on window focus.
  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), MACHINES_REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const isThisMac = useCallback(
    (machine: AdeAccountMachine): boolean => {
      if (!localIdentity) return false;
      if (machine.machineKey === localIdentity.machineKey) return true;
      return Boolean(machine.deviceId) && machine.deviceId === localIdentity.deviceId;
    },
    [localIdentity],
  );

  const machines = useMemo(() => {
    const list = [...(result?.machines ?? [])];
    // Pin this computer first; keep directory order otherwise.
    return list.sort((a, b) => (isThisMac(b) ? 1 : 0) - (isThisMac(a) ? 1 : 0));
  }, [result?.machines, isThisMac]);

  const onlineCount = machines.filter((m) => m.online).length;

  /**
   * Is THIS computer missing from its own account directory?
   *
   * A connected machine republishes itself every 30 seconds. A directory that
   * answers `ok` without a row for this machine can mean removal — or a publish
   * gap (expired sign-in, split sync listener, skipped publisher). `machineKey`
   * is checked for emptiness because the hosted web adapter reports a blank
   * identity, and a browser is a controller rather than a directory machine:
   * without this, the banner would fire on every web session and offer a repair
   * no browser can perform.
   */
  const thisMachineMissing =
    !webMode
    && result?.state === "ok"
    && Boolean(localIdentity?.machineKey)
    && !machines.some((candidate) => isThisMac(candidate));

  const canReconnect = !webMode && typeof accountBridge()?.repairMachinePairing === "function";

  /**
   * Reconnect this computer, signing in again first when the directory demands
   * proof of one.
   *
   * The re-pair is attempted first, because it is the only step needed when the
   * removal left nothing that requires fresh authentication (a push-only gate,
   * or a directory grant already in hand). When the directory does refuse for
   * want of a fresh sign-in, escalating in the same click is the whole point:
   * the refusal's own advice — "sign in again on this computer" — is exactly
   * what the user just did by pressing this button.
   *
   * The sign-in runs through the DEVICE flow, not the loopback flow the sign-in
   * card uses. Only the device flow passes through ADE's account directory, so
   * only it can end with the directory minting the single-use pairing grant
   * that gets a removed machine back on the roster.
   *
   * Nothing re-triggers the repair afterwards: the brain already re-pairs on
   * its own when an interactive sign-in completes while this machine is
   * revoked. So the follow-through is the directory read below, which reports
   * the outcome the user cares about — is this computer on the list again.
   */
  const reconnectThisMachine = useCallback(async () => {
    const api = accountBridge();
    if (!api?.repairMachinePairing) return;
    setReconnecting(true);
    setReconnectOutcome(null);
    setSignInPrompt(null);
    reconnectCancelledRef.current = false;
    try {
      const first = await api.repairMachinePairing();
      if (!reconnectNeedsFreshSignIn(first)) {
        setReconnectOutcome(describeReconnectOutcome(first));
        invalidateAccountMachines();
        await load();
        return;
      }
      const signIn = await runAccountDeviceLogin({
        onPrompt: setSignInPrompt,
        isCancelled: () => reconnectCancelledRef.current,
      });
      setSignInPrompt(null);
      if (signIn.status === "cancelled") return;
      if (signIn.status === "failed") {
        setReconnectOutcome({ tone: "danger", message: signIn.message });
        return;
      }
      invalidateAccountMachines();
      const refreshed = await load();
      const back = Boolean(
        refreshed?.state === "ok"
        && refreshed.machines.some((candidate) => isThisMac(candidate)),
      );
      setReconnectOutcome(
        back
          ? {
              tone: "success",
              message: "This computer is back on your account. Activity and alerts are delivering again.",
            }
          : {
              tone: "danger",
              message:
                "You're signed in, but this computer still isn't on your account. Try reconnecting it again.",
            },
      );
    } catch (err) {
      // Main already translated the brain's failure into a sentence; only a
      // truly unexpected throw reaches the fallback.
      setReconnectOutcome({
        tone: "danger",
        message: err instanceof Error && err.message
          ? err.message
          : "Couldn't reconnect this computer to your account. Try again in a moment.",
      });
    } finally {
      setSignInPrompt(null);
      setReconnecting(false);
    }
  }, [load, isThisMac]);

  const cancelReconnect = useCallback(() => {
    reconnectCancelledRef.current = true;
    setSignInPrompt(null);
  }, []);

  // The ⋮ menu is rendered in a fixed portal so it can never be clipped by, or
  // stack behind, the cards that follow this one (mirrors the TabNav pattern).
  const { ref: menuRef, position: menuPosition } = useClampedFixedPosition(menuAnchor, openMenuKey);
  const menuItemRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const openMenuMachine = useMemo(
    () => machines.find((m) => m.machineKey === openMenuKey) ?? null,
    [machines, openMenuKey],
  );
  const closeMenu = useCallback(() => {
    const trigger = menuTriggerRef.current;
    setOpenMenuKey(null);
    setMenuAnchor(null);
    menuTriggerRef.current = null;
    if (trigger?.isConnected) trigger.focus();
  }, []);
  const openMenu = useCallback((machineKey: string, anchorEl: HTMLElement) => {
    const rect = anchorEl.getBoundingClientRect();
    menuTriggerRef.current = anchorEl;
    setMenuAnchor({ x: rect.right - ACCOUNT_MENU_WIDTH, y: rect.bottom + 4 });
    setOpenMenuKey(machineKey);
  }, []);

  useEffect(() => {
    if (openMenuKey) menuItemRef.current?.focus();
  }, [openMenuKey]);

  const startRename = useCallback((machine: AdeAccountMachine) => {
    setRenameError(null);
    setRenameValue(accountMachineDisplayName(machine) ?? "");
    setRenamingKey(machine.machineKey);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingKey(null);
    setRenameError(null);
  }, []);

  /**
   * `customName === null` clears the override and falls back to the hostname —
   * the same contract the Connections panel's rename uses, so a machine renamed
   * here and a machine renamed there cannot end up in different states.
   */
  const saveRename = useCallback(
    async (machine: AdeAccountMachine, customName?: string | null) => {
      const api = accountBridge();
      if (!api?.renameMachine) return;
      const nextName = customName === undefined ? renameValue.trim() : customName;
      if (nextName !== null && !nextName) return;
      setRenameBusy(true);
      setRenameError(null);
      try {
        await api.renameMachine(machine.machineKey, nextName);
        setRenamingKey(null);
        await load();
      } catch (err) {
        setRenameError(
          err instanceof Error ? err.message : "Couldn't rename this computer.",
        );
      } finally {
        setRenameBusy(false);
      }
    },
    [renameValue, load],
  );

  let summary: string;
  if (loading && !result) summary = "Checking your computers…";
  else if (result?.state === "ok") {
    summary =
      machines.length === 0
        ? "No computers connected yet"
        : `${onlineCount} online · ${machines.length} connected`;
  } else if (result?.state === "not_configured") {
    summary = "The account directory isn't set up yet";
  } else if (result?.state === "signed_out") {
    summary = "Sign in to see your computers";
  } else {
    summary = "Can't reach the account directory";
  }

  const confirmRemoval = useCallback(async () => {
    const target = pendingRemoval;
    const api = accountBridge();
    if (!target || !api?.removeMachine) {
      setPendingRemoval(null);
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    try {
      await api.removeMachine(target.machineKey);
      setPendingRemoval(null);
      invalidateAccountMachines();
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Couldn't remove that computer from your account.");
    } finally {
      setRemoving(false);
    }
  }, [pendingRemoval, load]);

  return (
    <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 8,
              background: COLORS.accentSubtle,
              color: COLORS.accent,
              flexShrink: 0,
            }}
          >
            <DesktopTower size={16} weight="duotone" />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
              Your computers
            </div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>{summary}</div>
          </div>
        </div>
        {!webMode ? (
          <button
            type="button"
            onClick={() => openConnectionsPanel("machines")}
            style={outlineButton({ height: 30, fontSize: 12, padding: "0 12px" })}
          >
            Manage connections
            <ArrowRight size={13} weight="bold" />
          </button>
        ) : null}
      </div>

      {/*
        A missing directory row used to be treated as a one-way removal. Restart,
        sign-out, and reinstall still cannot put a truly revoked machine back,
        which is why Reconnect lives here — but the same empty row also appears
        when this computer simply stopped publishing. The copy must not claim
        removal as fact.
      */}
      {thisMachineMissing && canReconnect ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "12px 18px",
            borderTop: `1px solid ${COLORS.borderMuted}`,
            background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
          }}
        >
          <WarningCircle size={16} weight="fill" color={COLORS.warning} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
              {missingCopy.title}
            </div>
            <div style={{ marginTop: 2, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5, color: COLORS.textSecondary }}>
              {missingCopy.body}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 10 }}>
              <button
                type="button"
                disabled={reconnecting || repair.pending}
                onClick={() => void reconnectThisMachine()}
                style={primaryButton({
                  height: 30,
                  fontSize: 12,
                  padding: "0 12px",
                  flexShrink: 0,
                  opacity: reconnecting || repair.pending ? 0.6 : 1,
                  cursor: reconnecting || repair.pending ? "not-allowed" : "pointer",
                })}
              >
                {reconnecting ? <CircleNotch size={13} weight="bold" className="animate-spin" /> : null}
                {signInPrompt
                  ? "Signing in…"
                  : reconnecting
                    ? "Reconnecting…"
                    : "Reconnect this computer"}
              </button>
              {repair.available ? (
                <BrainRepairButton repair={repair} height={30} disabled={reconnecting} />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {result?.state === "ok" && machines.length > 0 ? (
        <div style={{ borderTop: `1px solid ${COLORS.borderMuted}` }}>
          {machines.map((machine) => {
            const thisMac = isThisMac(machine);
            const menuOpen = openMenuKey === machine.machineKey;
            const renaming = renamingKey === machine.machineKey;
            const rightText = thisMac
              ? null
              : machine.online
                ? machineRouteHint(machine) ?? "Online"
                : lastSeenLabel(machine.lastSeenAt);
            return (
              <div
                key={machine.machineKey}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "11px 18px",
                  borderTop: `1px solid ${COLORS.borderMuted}`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: machine.online ? COLORS.success : COLORS.textDim,
                    boxShadow: machine.online
                      ? `0 0 0 3px color-mix(in srgb, ${COLORS.success} 20%, transparent)`
                      : undefined,
                  }}
                />
                <Laptop size={15} weight="regular" color={COLORS.textMuted} style={{ flexShrink: 0 }} />
                {renaming ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveRename(machine);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}
                  >
                    <input
                      aria-label={`Name for ${accountMachineDisplayName(machine) ?? "this computer"}`}
                      autoFocus
                      maxLength={80}
                      value={renameValue}
                      disabled={renameBusy}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      style={{
                        minWidth: 0,
                        flex: 1,
                        height: 28,
                        borderRadius: RADII.sm,
                        border: `1px solid ${COLORS.borderMuted}`,
                        background: COLORS.recessedBg,
                        color: COLORS.textPrimary,
                        fontFamily: SANS_FONT,
                        fontSize: 12.5,
                        padding: "0 9px",
                        outline: "none",
                      }}
                    />
                    <button
                      type="submit"
                      disabled={renameBusy || !renameValue.trim()}
                      style={primaryButton({ height: 28, fontSize: 11, padding: "0 10px" })}
                    >
                      {renameBusy ? "Saving…" : "Save"}
                    </button>
                    {machine.customName ? (
                      <button
                        type="button"
                        disabled={renameBusy}
                        onClick={() => void saveRename(machine, null)}
                        style={outlineButton({ height: 28, fontSize: 11, padding: "0 10px" })}
                      >
                        Use hostname
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={renameBusy}
                      onClick={cancelRename}
                      style={outlineButton({ height: 28, fontSize: 11, padding: "0 10px" })}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span
                      style={{
                        fontFamily: SANS_FONT,
                        fontSize: 13,
                        color: COLORS.textPrimary,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {accountMachineDisplayName(machine) ?? "Unnamed computer"}
                    </span>
                    {thisMac ? (
                      <span style={inlineBadge(COLORS.accent, { fontSize: 10, padding: "2px 7px", flexShrink: 0 })}>
                        {THIS_MACHINE_NAME}
                      </span>
                    ) : null}
                  </>
                )}
                <span style={{ flex: 1 }} />
                {rightText ? (
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 11,
                      color: machine.online ? COLORS.success : COLORS.textMuted,
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {rightText}
                  </span>
                ) : null}
                {renaming ? (
                  <span style={{ width: 26, flexShrink: 0 }} />
                ) : (
                  <button
                    type="button"
                    // Every row gets this button now, including the local one:
                    // this list is the only place the local machine is shown,
                    // so it is the only place its name can be changed.
                    aria-label={`Options for ${accountMachineDisplayName(machine) ?? "Unnamed computer"}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={(event) =>
                      menuOpen ? closeMenu() : openMenu(machine.machineKey, event.currentTarget)
                    }
                    style={{
                      ...outlineButton({ height: 26, width: 26, padding: 0 }),
                      flexShrink: 0,
                      border: "none",
                      background: menuOpen ? COLORS.hoverBg : "transparent",
                      color: COLORS.textMuted,
                    }}
                  >
                    <DotsThreeVertical size={16} weight="bold" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {renameError ? (
        <div
          role="alert"
          style={{
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "10px 18px",
            fontFamily: SANS_FONT,
            fontSize: 12,
            color: COLORS.danger,
            lineHeight: 1.5,
          }}
        >
          {renameError}
        </div>
      ) : null}

      {/*
        The directory refused the re-pair without proof of a fresh sign-in, so
        one is in flight. The browser is already open on the pre-filled page;
        the code is shown for the case where it opened without it.
      */}
      {signInPrompt ? (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "10px 18px",
            background: COLORS.recessedBg,
          }}
        >
          <CircleNotch size={14} weight="bold" className="animate-spin" color={COLORS.textSecondary} />
          <div style={{ minWidth: 0, flex: 1, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5, color: COLORS.textSecondary }}>
            Finish signing in in your browser to reconnect this computer…
            <div style={{ color: COLORS.textMuted }}>
              If the page asks for a code, enter{" "}
              <span style={{ color: COLORS.textPrimary, fontWeight: 600, letterSpacing: 0.5 }}>
                {signInPrompt.userCode}
              </span>
              .
            </div>
          </div>
          <button
            type="button"
            onClick={cancelReconnect}
            style={outlineButton({ height: 26, fontSize: 11, padding: "0 10px", flexShrink: 0 })}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {/*
        Rendered independently of the banner: a successful reconnect refreshes
        the directory and the banner disappears with it, and the confirmation
        must outlive the state that prompted it.
      */}
      {reconnectOutcome ? (
        <div
          role="status"
          style={{
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "10px 18px",
            fontFamily: SANS_FONT,
            fontSize: 12,
            lineHeight: 1.5,
            color: reconnectOutcome.tone === "success"
              ? COLORS.success
              : reconnectOutcome.tone === "warning"
                ? COLORS.warning
                : COLORS.danger,
          }}
        >
          {reconnectOutcome.message}
        </div>
      ) : null}

      {removeError ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "10px 18px",
            fontFamily: SANS_FONT,
            fontSize: 12,
            color: COLORS.danger,
            lineHeight: 1.5,
          }}
        >
          {removeError}
        </div>
      ) : null}

      {result?.state === "unavailable" || result?.state === "not_configured" ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.borderMuted}`,
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {webMode
              ? "Use the machine menu above to switch computers."
              : result.state === "not_configured"
              ? "Your computers still connect from Connections — the shared directory just isn't live yet."
              : "Your computers still connect from Connections while the directory reconnects."}
          </span>
          {result.state === "unavailable" ? (
            <button
              type="button"
              onClick={() => void load()}
              style={outlineButton({ height: 28, fontSize: 11, padding: "0 10px" })}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {openMenuKey && openMenuMachine && menuAnchor
        ? createPortal(
            <>
              <div
                onClick={closeMenu}
                style={{ position: "fixed", inset: 0, zIndex: 9998 }}
              />
              <div
                ref={menuRef}
                role="menu"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeMenu();
                }}
                style={{
                  position: "fixed",
                  left: menuPosition?.left ?? menuAnchor.x,
                  top: menuPosition?.top ?? menuAnchor.y,
                  visibility: menuPosition ? "visible" : "hidden",
                  zIndex: 9999,
                  width: ACCOUNT_MENU_WIDTH,
                  padding: 4,
                  borderRadius: RADII.md,
                  background: COLORS.cardBgSolid,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  boxShadow: "0 18px 44px -24px rgba(0,0,0,0.8)",
                }}
              >
                <button
                  ref={menuItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const machine = openMenuMachine;
                    closeMenu();
                    startRename(machine);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: RADII.sm,
                    border: "none",
                    background: "transparent",
                    color: COLORS.textPrimary,
                    fontFamily: SANS_FONT,
                    fontSize: 12.5,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  Rename…
                </button>
                {/*
                  Always offered for the local row, not only when the banner
                  fires. Detection needs the directory to answer `ok`, so a
                  machine whose directory read is failing — or whose account has
                  no rows at all — would otherwise have no way back at all.
                */}
                {isThisMac(openMenuMachine) && canReconnect ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={reconnecting}
                    onClick={() => {
                      closeMenu();
                      void reconnectThisMachine();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: RADII.sm,
                      border: "none",
                      background: "transparent",
                      color: COLORS.textPrimary,
                      fontFamily: SANS_FONT,
                      fontSize: 12.5,
                      textAlign: "left",
                      cursor: reconnecting ? "not-allowed" : "pointer",
                      opacity: reconnecting ? 0.6 : 1,
                    }}
                  >
                    {signInPrompt
                      ? "Signing in…"
                      : reconnecting
                        ? "Reconnecting…"
                        : "Reconnect this computer"}
                  </button>
                ) : null}
                {/*
                  Removal stays withheld for the local machine. Signing this
                  computer out of the account from this computer is what the
                  sign-out card is for; "remove" here means "evict some other
                  machine", and pointing it at yourself would be a different
                  and far more destructive action wearing the same label.
                */}
                {!isThisMac(openMenuMachine) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const machine = openMenuMachine;
                      closeMenu();
                      setRemoveError(null);
                      setPendingRemoval(machine);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: RADII.sm,
                      border: "none",
                      background: "transparent",
                      color: COLORS.danger,
                      fontFamily: SANS_FONT,
                      fontSize: 12.5,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    Remove from account…
                  </button>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}

      {/*
        Removal is only reachable from a row's options menu, and that menu is
        withheld for the local machine — so this sheet always names some OTHER
        machine. It must never borrow THIS_MACHINE_NAME, and it can't assume the
        machine on the far end runs macOS.
      */}
      {pendingRemoval ? (
        <ConfirmSheet
          title={`Remove ${accountMachineDisplayName(pendingRemoval) ?? "Unnamed computer"} from your account?`}
          body="It will no longer connect through your account. You can add it back by signing in to ADE on that computer."
          confirmLabel="Remove"
          danger
          busy={removing}
          onConfirm={() => void confirmRemoval()}
          onCancel={() => {
            if (!removing) setPendingRemoval(null);
          }}
        />
      ) : null}
    </div>
  );
}

