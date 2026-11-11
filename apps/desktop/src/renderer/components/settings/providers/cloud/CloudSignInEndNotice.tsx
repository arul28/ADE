/**
 * The one app banner that warns when a sign-in ADE Cloud uses ends soon, or
 * ended (design §4.5). Mounted once in the app shell; it renders nothing
 * itself and registers its banner with the host.
 *
 * Cost at start:
 * - ADE Cloud off (or not known yet): nothing. No read, no listener.
 * - ADE Cloud on: one read of the account part (`providerLogins.status({})`,
 *   a local read of the account vault in this computer's background service,
 *   no network), deferred: 10 s after the shell mounts, then when the window
 *   is idle. It reads again only on `providerLogins.onChanged`, after that
 *   first read. No poll.
 *
 * Pin: none. The account part is the same on every brain of the account; the
 * window's own brain answers it. A failed read shows nothing.
 */
import { useEffect, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { Warning } from "@phosphor-icons/react";
import type { ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { useAdeCloudEnabled } from "../../../../state/cloudAccess";
import { APP_BANNER_PRIORITY, useAppBanner } from "../../../ui/notice";
import { adeCloudEndNotice } from "./adeCloudEndNotice";

/** How long after the shell mounts the first read waits, so start-up work goes first. */
const FIRST_READ_DELAY_MS = 10_000;

/** Settings › Providers › ADE Cloud, at one provider's page; `renew` opens the pass approve there. */
function adeCloudProviderRoute(provider: string, renewKey: string | null): string {
  const params = new URLSearchParams({ tab: "agents", machine: "ade-cloud", provider });
  if (renewKey) params.set("renew", renewKey);
  return `/settings?${params.toString()}`;
}

export function CloudSignInEndNotice({ navigate }: { navigate: NavigateFunction }): null {
  const cloudOn = useAdeCloudEnabled();
  const [status, setStatus] = useState<ProviderLoginStatus | null>(null);
  const readRef = useRef(false);

  useEffect(() => {
    if (!cloudOn) {
      setStatus(null);
      return undefined;
    }
    const bridge = typeof window === "undefined" ? undefined : window.ade?.providerLogins;
    if (typeof bridge?.status !== "function") return undefined;
    let cancelled = false;
    let readAgain = false;
    let reading = false;
    const read = () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      bridge.status({}).then(
        (next) => {
          if (!cancelled) setStatus(next ?? null);
        },
        () => {
          // A failed read warns about nothing; the next change reads again.
        },
      ).finally(() => {
        reading = false;
        readRef.current = true;
        if (readAgain && !cancelled) {
          readAgain = false;
          read();
        }
      });
    };
    // One deferred first read, then idle time; changes read again only after it.
    let idle: number | null = null;
    const timer = window.setTimeout(() => {
      const ric = window.requestIdleCallback;
      if (typeof ric === "function") idle = ric(() => read(), { timeout: 5_000 });
      else read();
    }, FIRST_READ_DELAY_MS);
    const off = bridge.onChanged?.(() => {
      if (readRef.current) read();
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idle != null) window.cancelIdleCallback?.(idle);
      off?.();
    };
  }, [cloudOn]);

  const notice = cloudOn ? adeCloudEndNotice(status, Date.now()) : null;
  useAppBanner(
    notice
      ? {
          id: "ade-cloud-sign-in-end",
          tone: notice.tone,
          icon: <Warning size={13} weight="bold" />,
          title: notice.title,
          detail: notice.detail,
          actions: [
            notice.renewKey
              ? { label: "Renew", variant: "primary" as const, onClick: () => navigate(adeCloudProviderRoute("claude", notice.renewKey)) }
              : { label: "Show sign-in", variant: "primary" as const, onClick: () => navigate(adeCloudProviderRoute(notice.provider, null)) },
          ],
          dismiss: { key: "ade-cloud-sign-in-end", fingerprint: notice.fingerprint },
        }
      : null,
    { priority: APP_BANNER_PRIORITY.integration },
  );
  return null;
}
