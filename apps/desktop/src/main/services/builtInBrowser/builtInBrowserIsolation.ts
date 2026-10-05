import { createHash } from "node:crypto";
import { session } from "electron";
import type { DownloadItem, Session, WebContents } from "electron";
import type { BuiltInBrowserClaimArgs, BuiltInBrowserIsolationArgs } from "../../../shared/types";
import type { Logger } from "../logging/logger";

/**
 * A tab's own throwaway sign-in: the in-memory partition it was created in and
 * the profile name the agent asked for. Null on a shared-profile tab.
 */
export type BrowserTabIsolation = {
  partition: string;
  profile: string;
};

export type BrowserDownloadListener = (
  event: { preventDefault: () => void },
  item: DownloadItem,
  downloadWebContents: WebContents,
) => void;

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
const RESOLVED = Promise.resolve();

/**
 * The isolated sign-ins of one browser service (one window's tab collection).
 *
 * A partition without `persist:` lives only in memory. It is also wiped when
 * its last tab closes, so "throwaway" holds within one run of the app. The
 * same partition is reused after its wipe finishes rather than replaced:
 * Electron cannot destroy a session, so a fresh name per cycle would leak one
 * session per sign-in an agent's test loop opens and closes.
 *
 * `ownerKey` is unique per service. Two windows of one project, or two personal
 * collections, would otherwise share a partition name, and one window's wipe
 * would sign out a tab the other still has open.
 */
export function createBuiltInBrowserIsolatedSessions(args: {
  ownerKey: string;
  /** The same per-session setup the shared profile gets. */
  configureSession: (isolatedSession: Session) => void;
  logger: () => Logger | null;
}) {
  const live = new Map<string, { session: Session; downloadListener: BrowserDownloadListener | null }>();
  const wiping = new Map<string, Promise<void>>();

  return {
    /** Null when no isolation was asked for; throws for a bad profile name. */
    forInput(input: BuiltInBrowserIsolationArgs & BuiltInBrowserClaimArgs): BrowserTabIsolation | null {
      const requested = typeof input.profile === "string" ? input.profile.trim() : "";
      if (!input.isolated && !requested) return null;
      const profile = requested || "default";
      if (!PROFILE_NAME_PATTERN.test(profile)) {
        throw new Error("An isolated browser profile name uses 1-40 letters, digits, '.', '_' or '-'.");
      }
      // One jar per (window, chat or lane, name): two chats that both say
      // "viewer" must not sign each other out.
      const scope = input.chatSessionId?.trim() || input.laneId?.trim() || "user";
      const key = createHash("sha256")
        .update(`${args.ownerKey}\u0000${scope}\u0000${profile}`)
        .digest("hex")
        .slice(0, 24);
      return { partition: `ade-browser-isolated-${key}`, profile };
    },

    /** Settles once the wipe from this partition's last close has finished. */
    whenReady(isolation: BrowserTabIsolation): Promise<void> {
      return wiping.get(isolation.partition) ?? RESOLVED;
    },

    ensure(isolation: BrowserTabIsolation, downloadListener: BrowserDownloadListener | null): void {
      if (live.has(isolation.partition)) return;
      const isolatedSession = session.fromPartition(isolation.partition);
      args.configureSession(isolatedSession);
      if (downloadListener) isolatedSession.on("will-download", downloadListener);
      live.set(isolation.partition, { session: isolatedSession, downloadListener });
    },

    /** Wipe every sign-in no live tab uses any more. */
    release(livePartitions: ReadonlySet<string>): void {
      for (const [partition, { session: isolatedSession, downloadListener }] of live) {
        if (livePartitions.has(partition)) continue;
        live.delete(partition);
        if (downloadListener) {
          try {
            isolatedSession.removeListener("will-download", downloadListener);
          } catch {
            // ignore session teardown races
          }
        }
        const wipe = Promise.allSettled([
          isolatedSession.clearStorageData(),
          isolatedSession.clearCache(),
        ]).then(() => {
          if (wiping.get(partition) === wipe) wiping.delete(partition);
          args.logger()?.info("built_in_browser.isolated_profile_cleared", { partition });
        });
        wiping.set(partition, wipe);
      }
    },
  };
}
