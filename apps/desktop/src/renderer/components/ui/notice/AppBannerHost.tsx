import { useCallback, useMemo, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { useBannerDismissals } from "../../../lib/bannerDismiss";
import { Z_LAYERS } from "../zLayers";
import { Banner, isDurableDismiss } from "./Banner";
import { useAppBannerEntries, type AppBannerEntry } from "./appBannerStore";
import { NOTICE_TONE_RANK } from "./noticeTones";

/**
 * Renders every registered app banner (see `appBannerStore.ts`).
 *
 * - Docked banners stack in flow under the top bar: ordered by priority band,
 *   then tone urgency, then registration. At most `MAX_DOCKED` show; the rest
 *   fold behind a "N more" toggle so a bad day never eats the window.
 * - Floating banners are short prompts at the top center, over the app, newest
 *   last, at most `MAX_FLOATING` at once.
 *
 * Mount exactly one, in `AppShell`, outside any project condition so account
 * and app-level banners reach the welcome screen too.
 */

const MAX_DOCKED = 2;
const MAX_FLOATING = 2;

function byPriority(a: AppBannerEntry, b: AppBannerEntry): number {
  return (
    a.priority - b.priority ||
    NOTICE_TONE_RANK[a.model.tone] - NOTICE_TONE_RANK[b.model.tone] ||
    a.order - b.order
  );
}

export function AppBannerHost(): JSX.Element | null {
  const entries = useAppBannerEntries();
  const dismissals = useBannerDismissals();
  const [expanded, setExpanded] = useState(false);

  const { docked, floating } = useMemo(() => {
    const live = entries.filter(
      (entry) =>
        !(isDurableDismiss(entry.model.dismiss) &&
          dismissals.isDismissed(entry.model.dismiss.key, entry.model.dismiss.fingerprint)),
    );
    return {
      docked: live.filter((entry) => entry.placement === "docked").sort(byPriority),
      floating: live
        .filter((entry) => entry.placement === "floating")
        .sort(byPriority)
        .slice(0, MAX_FLOATING),
    };
  }, [entries, dismissals]);

  const handleDurableDismiss = useCallback(
    (d: { key: string; fingerprint: string }) => dismissals.dismiss(d.key, d.fingerprint),
    [dismissals],
  );

  const visible = docked.slice(0, MAX_DOCKED);
  const overflow = docked.slice(MAX_DOCKED);

  return (
    <>
      {docked.length > 0 ? (
        <div
          data-testid="app-banner-dock"
          style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0, margin: "6px 8px 0" }}
        >
          {visible.map((entry) => (
            <Banner key={entry.id} model={entry.model} layout="docked" onDurableDismiss={handleDurableDismiss} />
          ))}
          {overflow.length > 0 ? (
            <>
              <button
                type="button"
                className="ade-notice-more"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  alignSelf: "flex-start",
                  padding: "1px 4px",
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--color-muted-fg)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11.5,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                <CaretRight
                  size={11}
                  weight="bold"
                  aria-hidden="true"
                  style={{ transition: "transform 120ms ease", transform: expanded ? "rotate(90deg)" : "none" }}
                />
                {expanded ? "Show fewer" : `${overflow.length} more notice${overflow.length === 1 ? "" : "s"}`}
              </button>
              {expanded
                ? overflow.map((entry) => (
                    <Banner key={entry.id} model={entry.model} layout="docked" onDurableDismiss={handleDurableDismiss} />
                  ))
                : null}
            </>
          ) : null}
        </div>
      ) : null}
      {floating.length > 0 ? (
        <div
          data-testid="app-banner-floating"
          style={{
            position: "fixed",
            top: 48,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: Z_LAYERS.floatingBanner,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            width: "max-content",
            maxWidth: "min(640px, calc(100vw - 28px))",
            pointerEvents: "none",
          }}
        >
          {floating.map((entry) => (
            <div key={entry.id} style={{ pointerEvents: "auto", maxWidth: "100%" }}>
              <Banner model={entry.model} layout="floating" onDurableDismiss={handleDurableDismiss} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
