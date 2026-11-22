import { useEffect, useRef, useState } from "react";
import { Banner } from "../ui/notice";
import { captureError } from "../../../shared/sentry/capture";
import type { OpenProjectBinding, ProjectConfigAccountNotice } from "../../../shared/types";

/**
 * Settings that follow the ADE account and need the person, on the computer
 * `pin` names (`projectConfigAccountLayer.ts`): a different value that
 * computer had when they moved (the account's is in use; the person can
 * apply the computer's instead), or a value that stays on that computer.
 * One inline notice per setting, shown where that setting is edited.
 */
export function AccountSettingNotices({
  pin,
  keys,
  onResolved,
}: {
  /** The computer whose settings these are; null when no copy is online (no notices). */
  pin: OpenProjectBinding | null;
  /** The account rows this surface edits: exact keys, or `ai.` for every row under it. */
  keys: readonly string[];
  /** Called after an answer changed the value in use. */
  onResolved?: () => void;
}) {
  const [notices, setNotices] = useState<ProjectConfigAccountNotice[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pinKey = pin?.key ?? null;
  const keyList = keys.join("|");
  // Bumped when the computer or the keys change: an answer that finishes
  // after that belongs to the old scope and must not touch this one.
  const scopeGeneration = useRef(0);
  const shows = (notice: ProjectConfigAccountNotice) =>
    keys.some((key) => (key.endsWith(".") ? notice.key.startsWith(key) : notice.key === key));

  useEffect(() => {
    let cancelled = false;
    scopeGeneration.current += 1;
    setNotices([]);
    setBusyKey(null);
    setError(null);
    // A host without project settings (or an older bridge) has no notices.
    // With no computer known there is nothing to ask.
    const projectConfig = window.ade?.projectConfig;
    if (!projectConfig?.get || !pin) return;
    projectConfig
      .get(pin)
      .then((snapshot) => {
        if (!cancelled) setNotices((snapshot.accountNotices ?? []).filter(shows));
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

  // A notice names its computer when that computer is not this one.
  const computer = pin?.kind === "remote" ? pin.runtimeName || "that computer" : "this computer";

  const answer = async (key: string, choice: "use_local" | "keep") => {
    if (!pin) return;
    const generation = scopeGeneration.current;
    const current = () => generation === scopeGeneration.current;
    setBusyKey(key);
    setError(null);
    try {
      // The answer goes to the computer it was asked on, even if the scope changes meanwhile.
      const snapshot = await window.ade.projectConfig.resolveAccountSettingNotice({ key, choice }, pin);
      if (!current()) return;
      setNotices((snapshot.accountNotices ?? []).filter(shows));
      if (choice === "use_local") onResolved?.();
    } catch (cause) {
      captureError(cause, {
        tags: { feature: "project_config", action: "resolve_account_notice" },
        fingerprint: ["project_config", "resolve_account_notice"],
        handled: true,
      });
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) setBusyKey(null);
    }
  };

  if (notices.length === 0) return null;
  return (
    <div className="ade-modern-stack" style={{ gap: 8 }}>
      {notices.map((notice) => (notice.kind === "kept_here" ? (
        <Banner
          key={notice.key}
          layout="inline"
          model={{
            id: `account-setting-${notice.key}`,
            tone: "info",
            title: keptHereTitle(notice, computer),
            detail: notice.reason === "secret"
              ? `Until then it stays on ${computer}, and your other computers do not get it.`
              : `It stays on ${computer}, and your other computers do not get it.`,
          }}
        />
      ) : (
        <Banner
          key={notice.key}
          layout="inline"
          model={{
            id: `account-setting-${notice.key}`,
            tone: "info",
            title: `${notice.label}: ${computer} had a different value.`,
            detail: "ADE now uses the value saved in your account for this repository.",
            busy: busyKey === notice.key,
            error: busyKey === null && error ? error : undefined,
            actions: [
              {
                label: `Use ${computer}'s value`,
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
      )))}
    </div>
  );
}

function keptHereTitle(notice: Extract<ProjectConfigAccountNotice, { kind: "kept_here" }>, computer: string): string {
  if (notice.reason === "secret") {
    const names = (notice.names ?? []).join(", ") || "its secret values";
    return `Move ${names} to Project secrets so ${notice.label} follows your account.`;
  }
  if (notice.reason === "machine_path") {
    return `${notice.label} names a folder on ${computer}, so it can't follow your account.`;
  }
  return `${notice.label} is too large to follow your ADE account.`;
}
