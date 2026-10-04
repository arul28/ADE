import type { OpenProjectBinding } from "../../shared/types";

/**
 * A clicked `localhost` link waiting for the Browser pane to mount.
 *
 * On a remote machine's chat, `localhost:4180` means that machine's port, so
 * the pane opens the link: it asks for the tunnel, keeps the address the user
 * clicked in the URL bar, and remembers which tab shows the other machine.
 * Clicking the link reveals the pane, but the pane is not mounted at that
 * moment (Git or another tool was showing). So the link waits here, and the
 * pane takes it when it mounts.
 *
 * Every hold has a fallback. If no pane takes the link in time, it opens through
 * the plain browser call, which still tunnels the URL to that machine. Only
 * the URL bar shows the tunnel address instead of the one that was clicked.
 */

export type PendingBrowserLinkOpen = {
  url: string;
  /** The machine the link belongs to; null means the window's own machine. */
  runtimePin: OpenProjectBinding | null;
};

type Held = PendingBrowserLinkOpen & {
  id: number;
  fallback: ReturnType<typeof setTimeout>;
};

/** Long enough for the Work pane to switch tools and mount the browser. */
const FALLBACK_MS = 3_000;
const HOLD_CAP = 8;

let nextId = 1;
let holds: Held[] = [];

function pinKey(pin: OpenProjectBinding | null): string {
  return pin ? `${pin.kind}:${pin.key}` : "bound";
}

export function holdBrowserLinkOpen(
  link: PendingBrowserLinkOpen,
  fallback: (link: PendingBrowserLinkOpen) => void,
): void {
  const id = nextId++;
  const timer = setTimeout(() => {
    const index = holds.findIndex((held) => held.id === id);
    if (index < 0) return;
    const [held] = holds.splice(index, 1);
    fallback({ url: held!.url, runtimePin: held!.runtimePin });
  }, FALLBACK_MS);
  holds.push({ ...link, id, fallback: timer });
  while (holds.length > HOLD_CAP) {
    const dropped = holds.shift();
    if (dropped) clearTimeout(dropped.fallback);
  }
}

/**
 * Take every link held for a pane on `paneBinding`. A link held with no pin
 * belongs to whichever pane runs on the window's machine, so any pane can
 * take it.
 */
export function takeHeldBrowserLinkOpens(paneBinding: OpenProjectBinding | null): PendingBrowserLinkOpen[] {
  const key = pinKey(paneBinding);
  const taken: PendingBrowserLinkOpen[] = [];
  holds = holds.filter((held) => {
    if (held.runtimePin && pinKey(held.runtimePin) !== key) return true;
    clearTimeout(held.fallback);
    taken.push({ url: held.url, runtimePin: held.runtimePin });
    return false;
  });
  return taken;
}
