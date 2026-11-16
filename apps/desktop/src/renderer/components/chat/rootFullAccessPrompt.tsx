import { ShieldWarning } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { confirmDialog } from "../ui/dialog/confirm";

/**
 * Full access for Claude on a machine where ADE runs as root (the brain's
 * `claudeRootFullAccess.ts`). Claude refuses it there unless the person sets
 * the machine aside for agents, once, for every chat on it.
 *
 * Both calls go to the chat's machine through `pin`: the choice belongs to the
 * machine the chat runs on, never the tab's.
 */

const ROOT_FULL_ACCESS_MESSAGE =
  "ADE runs as root on this machine. Claude only allows Full access as root on a machine set aside for agents. Allowing it covers every chat on this machine, and agents there can then change anything on it without asking.";

/** Asks the person and saves a yes. True when Full access can run on the chat's machine. */
export async function confirmRootFullAccess(pin: OpenProjectBinding | null): Promise<boolean> {
  const set = window.ade?.agentChat?.setRootFullAccess;
  if (typeof set !== "function") return false;
  const confirmed = await confirmDialog({
    title: "Allow Full access on this machine?",
    message: ROOT_FULL_ACCESS_MESSAGE,
    confirmLabel: "Allow on this machine",
    cancelLabel: "Use Accept edits",
    tone: "warning",
    icon: <ShieldWarning size={18} weight="duotone" />,
  });
  if (!confirmed) return false;
  try {
    const state = await set({ allowed: true }, pin);
    return state.allowed;
  } catch {
    return false;
  }
}

/**
 * Before a Claude chat moves to Full access: when its machine needs the
 * root opt-in and doesn't have it, ask. True to go ahead with Full access.
 * A machine that can't be asked (an older brain) goes ahead as before; the
 * chat's own notice still explains a refusal.
 */
export async function ensureRootFullAccessFor(pin: OpenProjectBinding | null): Promise<boolean> {
  const get = window.ade?.agentChat?.getRootFullAccess;
  if (typeof get !== "function") return true;
  let state: { applies: boolean; allowed: boolean } | null = null;
  try {
    state = await get(pin);
  } catch {
    return true;
  }
  if (!state?.applies || state.allowed) return true;
  return confirmRootFullAccess(pin);
}
