import { useEffect, useState } from "react";
import { Banner } from "../ui/notice";
import { captureError } from "../../../shared/sentry/capture";
import type { OpenProjectBinding, ProjectConfigAccountNotice } from "../../../shared/types";

/**
 * Settings that now follow the ADE account, where the computer `pin` names
 * had a different value when they moved (`projectConfigAccountLayer.ts`).
 * One inline notice per setting, shown where that setting is edited. The
 * account's value is in use; the person can apply the computer's instead.
 */
export function AccountSettingNotices({
  pin,
  keys,
  onResolved,
}: {
  /** The computer whose settings these are; null for this tab's own machine. */
  pin: OpenProjectBinding | null;
  /** The account rows this surface edits. */
  keys: readonly string[];
  /** Called after an answer changed the value in use. */
  onResolved?: () => void;
}) {
  const [notices, setNotices] = useState<ProjectConfigAccountNotice[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pinKey = pin?.key ?? null;
  const keyList = keys.join("|");

  useEffect(() => {
    let cancelled = false;
    setNotices([]);
    window.ade.projectConfig
      .get(pin)
      .then((snapshot) => {
        if (!cancelled) setNotices((snapshot.accountNotices ?? []).filter((notice) => keys.includes(notice.key)));
      })
      .catch(() => {
        // The host section shows its own load failure; a notice is extra.
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the pin's key: a rebuilt pin for the same machine is no reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, keyList]);

  const answer = async (key: string, choice: "use_local" | "keep") => {
    setBusyKey(key);
    setError(null);
    try {
      const snapshot = await window.ade.projectConfig.resolveAccountSettingNotice({ key, choice }, pin);
      setNotices((snapshot.accountNotices ?? []).filter((notice) => keys.includes(notice.key)));
      if (choice === "use_local") onResolved?.();
    } catch (cause) {
      captureError(cause, {
        tags: { feature: "project_config", action: "resolve_account_notice" },
        fingerprint: ["project_config", "resolve_account_notice"],
        handled: true,
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  if (notices.length === 0) return null;
  return (
    <div className="ade-modern-stack" style={{ gap: 8 }}>
      {notices.map((notice) => (
        <Banner
          key={notice.key}
          layout="inline"
          model={{
            id: `account-setting-${notice.key}`,
            tone: "info",
            title: `This computer had a different value for ${notice.label}.`,
            detail: "ADE now uses the value saved in your account for this repository.",
            busy: busyKey === notice.key,
            error: busyKey === null && error ? error : undefined,
            actions: [
              {
                label: "Use this computer's value",
                onClick: () => { void answer(notice.key, "use_local"); },
                disabled: busyKey !== null,
              },
              {
                label: "Keep",
                variant: "secondary",
                onClick: () => { void answer(notice.key, "keep"); },
                disabled: busyKey !== null,
              },
            ],
          }}
        />
      ))}
    </div>
  );
}
