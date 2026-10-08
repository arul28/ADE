import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  MapPin,
  Moon,
  Sun,
  type Icon,
} from "@phosphor-icons/react";
import type { HomeWeather, HomeWeatherPlace } from "../../../../shared/types/homeWidgets";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { usePolling } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * Clock & weather. The clock repaints once a minute, on the minute. Weather is
 * Open-Meteo (free, no key) for a place the user types: no location prompt,
 * no precise position, and only the place's rounded coordinates leave the
 * machine. Main caches each place for 15 minutes; this card asks every 30
 * while it is on screen.
 */

type PlaceSetting = { name: string; detail: string | null; latitude: number; longitude: number };

function readPlace(value: unknown): PlaceSetting | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.latitude !== "number" || typeof raw.longitude !== "number") return null;
  return { name: raw.name, detail: typeof raw.detail === "string" ? raw.detail : null, latitude: raw.latitude, longitude: raw.longitude };
}

function defaultUnit(): "c" | "f" {
  const locale = typeof navigator !== "undefined" ? navigator.language : "";
  return /^en-(US|LR|MM)$/i.test(locale) || /-(US|LR|MM)$/i.test(locale) ? "f" : "c";
}

/** WMO weather interpretation codes, as Open-Meteo reports them. */
function describeCode(code: number, isDay: boolean): { label: string; icon: Icon } {
  if (code === 0) return { label: "Clear", icon: isDay ? Sun : Moon };
  if (code === 1 || code === 2) return { label: code === 1 ? "Mostly clear" : "Partly cloudy", icon: isDay ? CloudSun : Cloud };
  if (code === 3) return { label: "Overcast", icon: Cloud };
  if (code === 45 || code === 48) return { label: "Fog", icon: CloudFog };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: CloudRain };
  if (code >= 61 && code <= 67) return { label: "Rain", icon: CloudRain };
  if (code >= 71 && code <= 77) return { label: "Snow", icon: CloudSnow };
  if (code >= 80 && code <= 82) return { label: "Showers", icon: CloudRain };
  if (code === 85 || code === 86) return { label: "Snow showers", icon: CloudSnow };
  if (code >= 95) return { label: "Thunderstorm", icon: CloudLightning };
  return { label: "Cloudy", icon: Cloud };
}

function useMinuteClock(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    let timer: number;
    const schedule = () => {
      const next = 60_000 - (Date.now() % 60_000) + 50;
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, next);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active]);
  return now;
}

function PlacePicker({ onPick, onCancel }: { onPick: (place: HomeWeatherPlace) => void; onCancel?: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HomeWeatherPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const search = useCallback(async (text: string) => {
    const bridge = window.ade?.home?.weather;
    if (!bridge) return;
    const request = ++requestRef.current;
    setBusy(true);
    setError(null);
    const result = await bridge.search(text).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (request !== requestRef.current) return;
    setBusy(false);
    if (result.ok) setResults(result.places);
    else setError("Couldn't search places. Check your connection.");
  }, []);
  return (
    <form
      className="ade-hw-place"
      onSubmit={(event) => {
        event.preventDefault();
        void search(query);
      }}
    >
      <div className="ade-hw-place-row">
        <MapPin size={13} aria-hidden />
        <input
          className="ade-hw-input"
          autoFocus
          placeholder="City for weather"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && onCancel) {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          aria-label="City for weather"
        />
        <button type="submit" className="kit-btn" disabled={busy || query.trim().length < 2}>{busy ? "…" : "Find"}</button>
      </div>
      {error ? <div className="ade-hw-note" role="alert">{error}</div> : null}
      {results && results.length === 0 ? <div className="ade-hw-note">No places match.</div> : null}
      {results && results.length > 0 ? (
        <div className="ade-hw-results" role="list">
          {results.map((place) => (
            <button key={`${place.latitude},${place.longitude}`} type="button" role="listitem" className="kit-row" onClick={() => onPick(place)}>
              <span className="ade-hw-result-name">{place.name}</span>
              <span className="ade-hw-result-detail">{place.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}

export default function ClockWeatherWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const now = useMinuteClock(visible);
  const updateSettings = useHomeLayoutStore((s) => s.updateSettings);
  const place = readPlace(item.settings?.place);
  const unit: "c" | "f" = item.settings?.unit === "f" || item.settings?.unit === "c" ? item.settings.unit : defaultUnit();
  const [weather, setWeather] = useState<HomeWeather | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const bridge = window.ade?.home?.weather;
  const wide = item.size === "w" || item.size === "l";

  const lat = place?.latitude;
  const lon = place?.longitude;
  useEffect(() => {
    setWeather(null);
    setError(null);
  }, [lat, lon]);
  usePolling(async () => {
    if (!bridge || lat == null || lon == null) return;
    const result = await bridge.get({ latitude: lat, longitude: lon });
    if (result.ok) {
      setWeather(result.weather);
      setError(null);
    } else {
      setError("Weather is unavailable right now.");
    }
  }, 30 * 60_000, visible && lat != null && lon != null && Boolean(bridge));

  const temp = (celsius: number | null | undefined) =>
    celsius == null ? "—" : `${Math.round(unit === "f" ? celsius * 9 / 5 + 32 : celsius)}°`;
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const condition = weather ? describeCode(weather.code, weather.isDay) : null;
  const ConditionIcon = condition?.icon ?? CloudSun;

  return (
    <section className="kit-card ade-home-card ade-hw" aria-label="Clock and weather" data-size={item.size}>
      <WelcomeCardHead icon={CloudSun} title="Clock & weather">
        {place && !picking ? (
          <button type="button" className="ade-home-card-scope ade-hw-place-btn" title="Change place" onClick={() => setPicking(true)}>
            {place.name}
          </button>
        ) : null}
        {weather ? (
          <div className="kit-seg ade-hw-unit" role="radiogroup" aria-label="Temperature unit">
            {(["c", "f"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={unit === option} onClick={() => updateSettings(item.id, { unit: option })}>
                °{option.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-hw-body">
        <div className="ade-hw-clock">
          <div className="ade-hw-time kit-num">{time}</div>
          <div className="ade-hw-date">{date}</div>
        </div>
        <div className="ade-hw-weather">
          {!bridge ? (
            <div className="ade-hw-note">Weather needs the ADE desktop app.</div>
          ) : picking || !place ? (
            <PlacePicker
              onCancel={place ? () => setPicking(false) : undefined}
              onPick={(picked) => {
                updateSettings(item.id, { place: { name: picked.name, detail: picked.detail, latitude: picked.latitude, longitude: picked.longitude } });
                setPicking(false);
              }}
            />
          ) : error && !weather ? (
            <div className="ade-hw-note" role="alert">{error}</div>
          ) : !weather ? (
            <div className="ade-hw-note">Reading the weather…</div>
          ) : (
            <>
              <div className="ade-hw-now">
                <ConditionIcon size={30} weight="duotone" aria-hidden className="ade-hw-icon" />
                <div>
                  <div className="ade-hw-temp kit-num">{temp(weather.temperatureC)}</div>
                  <div className="ade-hw-cond">
                    {condition?.label}
                    {weather.todayMaxC != null ? <span className="kit-num"> · {temp(weather.todayMaxC)} / {temp(weather.todayMinC)}</span> : null}
                  </div>
                </div>
              </div>
              {wide && weather.days.length > 1 ? (
                <div className="ade-hw-days">
                  {weather.days.slice(1, 5).map((day) => {
                    const info = describeCode(day.code, true);
                    const DayIcon = info.icon;
                    const [y, m, d] = day.date.split("-").map(Number);
                    const label = new Date(y!, (m ?? 1) - 1, d).toLocaleDateString(undefined, { weekday: "short" });
                    return (
                      <div key={day.date} className="ade-hw-day" title={info.label}>
                        <span>{label}</span>
                        <DayIcon size={16} aria-hidden />
                        <span className="kit-num">{temp(day.maxC)}</span>
                        <span className="kit-num ade-hw-min">{temp(day.minC)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
