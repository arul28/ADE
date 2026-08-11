import React from "react";
import { Star } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import {
  githubStarActionSupported,
  parseGithubRepoUrl,
  readRepoStarState,
  setRepoStarred,
  useGithubConnected,
} from "../../lib/githubStars";
import { formatCount } from "./marketplaceModel";

/**
 * Star a plugin's repository from its detail page.
 *
 * The button is HIDDEN rather than disabled whenever it could not work: no
 * GitHub connection, a host with no star action, a plugin that lives outside
 * GitHub, or a read that came back with nothing. A disabled star is a question
 * ("why can't I?") that this page has no good place to answer, and the star is
 * a courtesy rather than something anyone came here to do.
 *
 * The press is optimistic and reverts on failure, count included. Starring is a
 * one-round-trip write against someone else's server: waiting on it makes the
 * button feel broken, and keeping an optimistic state that turned out to be
 * wrong would quietly tell someone they had starred something they had not.
 */
export function PluginStarButton({
  repo,
  /** The catalogue's count, used until GitHub tells us its own. */
  fallbackStars,
  onCountChange,
}: {
  repo: string | null;
  fallbackStars: number | null;
  onCountChange?: (stars: number | null) => void;
}) {
  const parsed = React.useMemo(() => parseGithubRepoUrl(repo), [repo]);
  const connected = useGithubConnected();
  const supported = React.useMemo(() => githubStarActionSupported(), []);

  const [state, setState] = React.useState<{ starred: boolean; stars: number | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const active = parsed !== null && supported && connected === true;

  React.useEffect(() => {
    if (!active || !parsed) {
      setState(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const read = await readRepoStarState(parsed);
      if (cancelled) return;
      setState(read);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, parsed]);

  if (!active || !parsed || !state) return null;

  const stars = state.stars ?? fallbackStars;
  const label = state.starred ? "Starred" : "Star";
  const count = formatCount(stars);

  const toggle = async () => {
    if (busy) return;
    const next = !state.starred;
    // The count moves with the press. It is the whole point of the optimism:
    // a star that lands but leaves the number alone reads as a press that did
    // not take.
    const optimistic = {
      starred: next,
      stars: stars === null ? null : Math.max(0, stars + (next ? 1 : -1)),
    };
    const previous = state;
    setState(optimistic);
    setFailed(false);
    setBusy(true);
    onCountChange?.(optimistic.stars);
    try {
      await setRepoStarred(parsed, next);
    } catch {
      setState(previous);
      setFailed(true);
      onCountChange?.(previous.stars ?? fallbackStars);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={state.starred}
      title={failed ? "That didn’t reach GitHub. Try again." : `${label} ${parsed.owner}/${parsed.name} on GitHub`}
      data-tour="plugin:marketplace.star"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 30,
        padding: "0 10px",
        fontFamily: SANS_FONT,
        fontSize: 12,
        fontWeight: 500,
        color: state.starred ? COLORS.accent : COLORS.textSecondary,
        background: state.starred
          ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
          : "transparent",
        border: `1px solid ${state.starred ? COLORS.accentBorder : COLORS.border}`,
        borderRadius: RADII.md,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        whiteSpace: "nowrap",
      }}
    >
      <Star size={13} weight={state.starred ? "fill" : "regular"} aria-hidden />
      {label}
      {count ? (
        <span style={{ color: COLORS.textDim, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      ) : null}
    </button>
  );
}

export default PluginStarButton;
