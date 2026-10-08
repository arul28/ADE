/**
 * Animated weather glyphs: each is a small living scene (rays turn, rain
 * falls, snow drifts, lightning flickers, fog breathes). Pure SVG, animated
 * by CSS on transform and opacity only, so it runs on the compositor; the
 * card pauses it when it is off screen and it holds still under reduced
 * motion (homeWidgets.css, `.ade-wx`).
 */

export type WeatherKind =
  | "sun"
  | "moon"
  | "cloud"
  | "partly"
  | "partlyNight"
  | "drizzle"
  | "rain"
  | "heavyRain"
  | "snow"
  | "thunder"
  | "fog";

/** WMO weather interpretation codes, as Open-Meteo reports them. */
export function weatherKind(code: number, isDay: boolean): WeatherKind {
  if (code === 0) return isDay ? "sun" : "moon";
  if (code === 1 || code === 2) return isDay ? "partly" : "partlyNight";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 65 || code === 67 || code === 82) return "heavyRain";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunder";
  return "cloud";
}

export function weatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code === 65 || code === 67) return "Heavy rain";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Cloudy";
}

/** The sky a condition paints behind the card. */
export function weatherSky(kind: WeatherKind, isDay: boolean, hour: number): "day" | "dusk" | "night" | "grey" | "storm" | "snow" {
  if (kind === "thunder") return "storm";
  if (kind === "snow") return isDay ? "snow" : "night";
  if (!isDay) return "night";
  if (kind === "rain" || kind === "heavyRain" || kind === "drizzle" || kind === "fog" || kind === "cloud") return "grey";
  if (hour >= 17 || hour < 7) return "dusk";
  return "day";
}

function Sun({ small }: { small?: boolean }) {
  return (
    <g className="ade-wx-sun" transform={small ? "translate(-5 -5) scale(0.62)" : undefined}>
      <g className="ade-wx-rays">
        {Array.from({ length: 8 }, (_, index) => (
          <line key={index} x1="16" y1="3.2" x2="16" y2="6.4" transform={`rotate(${index * 45} 16 16)`} />
        ))}
      </g>
      <circle className="ade-wx-disc" cx="16" cy="16" r="6" />
    </g>
  );
}

function Moon({ small }: { small?: boolean }) {
  return (
    <g className="ade-wx-moon" transform={small ? "translate(-4 -5) scale(0.62)" : undefined}>
      <path className="ade-wx-moon-body" d="M20.5 6.2a10 10 0 1 0 6 15.6A8 8 0 0 1 20.5 6.2Z" />
      <circle className="ade-wx-star ade-wx-star-a" cx="25.5" cy="7.5" r="0.9" />
      <circle className="ade-wx-star ade-wx-star-b" cx="28.5" cy="12.5" r="0.7" />
    </g>
  );
}

function Cloud({ shade = "light", y = 0 }: { shade?: "light" | "dark"; y?: number }) {
  return (
    <path
      className="ade-wx-cloud"
      data-shade={shade}
      transform={`translate(0 ${y})`}
      d="M9.5 24h14a5.5 5.5 0 0 0 .6-10.97A7.5 7.5 0 0 0 9.8 15.2 4.5 4.5 0 0 0 9.5 24Z"
    />
  );
}

function Drops({ count, heavy }: { count: number; heavy?: boolean }) {
  const xs = count === 2 ? [13, 20] : count === 3 ? [11.5, 16.5, 21.5] : [10.5, 14.5, 18.5, 22.5];
  return (
    <g className="ade-wx-drops" data-heavy={heavy ? "true" : undefined}>
      {xs.map((x, index) => (
        <line key={x} className="ade-wx-drop" style={{ animationDelay: `${index * 0.27}s` }} x1={x} y1="25.5" x2={x - 1.2} y2={heavy ? 30 : 28.5} />
      ))}
    </g>
  );
}

function Flakes() {
  return (
    <g className="ade-wx-flakes">
      {[11, 16.5, 22].map((x, index) => (
        <circle key={x} className="ade-wx-flake" style={{ animationDelay: `${index * 0.6}s` }} cx={x} cy="27" r="1.15" />
      ))}
    </g>
  );
}

export function WeatherGlyph({ kind, size = 32, title }: { kind: WeatherKind; size?: number; title?: string }) {
  return (
    <svg className="ade-wx" data-kind={kind} viewBox="0 0 32 32" width={size} height={size} role="img" aria-label={title ?? kind}>
      {kind === "sun" ? <Sun /> : null}
      {kind === "moon" ? <Moon /> : null}
      {kind === "partly" ? (
        <>
          <Sun small />
          <g className="ade-wx-drift"><Cloud y={2} /></g>
        </>
      ) : null}
      {kind === "partlyNight" ? (
        <>
          <Moon small />
          <g className="ade-wx-drift"><Cloud y={2} /></g>
        </>
      ) : null}
      {kind === "cloud" ? (
        <g className="ade-wx-drift">
          <Cloud shade="dark" y={-3} />
          <g transform="translate(3 3)"><Cloud /></g>
        </g>
      ) : null}
      {kind === "drizzle" || kind === "rain" || kind === "heavyRain" ? (
        <>
          <Drops count={kind === "drizzle" ? 2 : kind === "rain" ? 3 : 4} heavy={kind === "heavyRain"} />
          <g className="ade-wx-drift"><Cloud shade={kind === "drizzle" ? "light" : "dark"} y={-3} /></g>
        </>
      ) : null}
      {kind === "snow" ? (
        <>
          <Flakes />
          <g className="ade-wx-drift"><Cloud y={-3} /></g>
        </>
      ) : null}
      {kind === "thunder" ? (
        <>
          <path className="ade-wx-bolt" d="M16.8 20.5 13.6 26h3.2l-1.4 5 4.6-6.6h-3.3l1.6-3.9Z" />
          <g className="ade-wx-drift"><Cloud shade="dark" y={-4} /></g>
        </>
      ) : null}
      {kind === "fog" ? (
        <g className="ade-wx-fog">
          <line x1="7" y1="13" x2="25" y2="13" />
          <line x1="5" y1="18" x2="23" y2="18" />
          <line x1="9" y1="23" x2="27" y2="23" />
        </g>
      ) : null}
    </svg>
  );
}
