import { useEffect, useState } from "react";
import type { ResolvedAdeThemePalette } from "../../../shared/theme";
import { userSceneUrl } from "../../scene/userScenes";
import type { InterfaceSansFont } from "../../state/appearanceStore";

export const SANS_FONT_LABELS: Record<InterfaceSansFont, string> = { geist: "Geist", system: "System", "geist-mono": "Geist Mono" };

/** The Gradient background drawn small, in a given palette. */
export function gradientSceneBackground(palette: ResolvedAdeThemePalette): string {
  return `radial-gradient(120% 90% at 20% 15%, color-mix(in srgb, ${palette.accentDeep} 70%, transparent), transparent 62%), radial-gradient(110% 90% at 85% 85%, color-mix(in srgb, ${palette.accent} 55%, transparent), transparent 60%), ${palette.bg}`;
}

/** A tiny ADE window in a given palette: top bar, sidebar, a card and a composer. */
export function MiniChrome({ palette }: { palette: ResolvedAdeThemePalette }) {
  const p = palette;
  return (
    <div className="ade-ap-mini" style={{ background: p.bg }}>
      <div className="ade-ap-mini-top" style={{ background: `color-mix(in srgb, ${p.accent} 22%, ${p.bg})` }}>
        <span style={{ background: p.fg, opacity: 0.55 }} />
        <span style={{ background: p.accent }} />
      </div>
      <div className="ade-ap-mini-body">
        <div className="ade-ap-mini-side" style={{ background: p.surface, borderColor: `color-mix(in srgb, ${p.fg} 10%, transparent)` }}>
          <span style={{ background: p.accent, opacity: 0.9 }} />
          <span style={{ background: p.fg, opacity: 0.25 }} />
          <span style={{ background: p.fg, opacity: 0.18 }} />
        </div>
        <div className="ade-ap-mini-main">
          <span className="ade-ap-mini-line" style={{ background: p.fg, opacity: 0.4 }} />
          <div className="ade-ap-mini-card" style={{ background: p.surface, borderColor: `color-mix(in srgb, ${p.fg} 10%, transparent)` }}>
            <span style={{ background: p.fg, opacity: 0.3 }} />
            <span style={{ background: p.accent }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function UserSceneThumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void userSceneUrl(id).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}
