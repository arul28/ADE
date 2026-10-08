import { useCallback, useEffect, useRef, useState } from "react";
import { CloudSun, MapPin } from "@phosphor-icons/react";
import type { HomeWeather, HomeWeatherPlace } from "../../../../shared/types/homeWidgets";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetPreview, useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import { WeatherGlyph, weatherKind, weatherLabel } from "./WeatherGlyph";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { FitList } from "../HomeFitList";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { usePolling } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * Clock & weather, in the same quiet card as the rest of the page: the time
 * in the head, then now (an animated condition glyph, the temperature, the
 * condition, high and low), a tight strip of the next hours, and as many of
 * the next days as fit. No coloured panels; colour is only in the glyphs.
 *
 * The clock repaints once a minute, on the minute. Weather is
 * Open-Meteo (free, no key) for a place the user types: no location prompt,
 * no precise position, and only the place's rounded coordinates leave the
 * machine. Main caches each place for 15 minutes; this card asks every 30
 * while it is on screen. Glyphs hold still off screen.
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
          {results.slice(0, 4).map((place) => (
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
  const preview = useWidgetPreview();
  const now = useMinuteClock(visible);
  const updateSettings = useHomeLayoutStore((s) => s.updateSettings);
  const place = readPlace(item.settings?.place);
  const unit: "c" | "f" = item.settings?.unit === "f" || item.settings?.unit === "c" ? item.settings.unit : defaultUnit();
  const [weather, setWeather] = useState<HomeWeather | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const bridge = window.ade?.home?.weather;
  const span = useWidgetSpan(item);
  const wide = span.w >= 2;

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

  const deg = (celsius: number | null | undefined) =>
    celsius == null ? "—" : `${Math.round(unit === "f" ? celsius * 9 / 5 + 32 : celsius)}°`;
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const kind = weather ? weatherKind(weather.code, weather.isDay) : null;
  const label = weather ? weatherLabel(weather.code) : null;
  const hours = (weather?.hours ?? []).slice(0, wide ? 7 : 6);
  const days = (weather?.days ?? []).slice(1, 7);
  const lowest = Math.min(...days.map((day) => day.minC));
  const highest = Math.max(...days.map((day) => day.maxC));
  const spread = Math.max(1, highest - lowest);
  const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
  // A gallery preview never asks for a place; it says what the card will show.
  const showPicker = Boolean(bridge) && !preview && (picking || !place);

  return (
    <section
      className="kit-card ade-home-card ade-wx2"
      aria-label="Clock and weather"
      data-wide={wide || undefined}
      data-still={!visible || preview ? "true" : undefined}
    >
      <WelcomeCardHead icon={CloudSun} title="Weather">
        {place && !picking ? (
          <button type="button" className="ade-wx2-place" title="Change place" onClick={() => setPicking(true)}>
            <MapPin size={11} weight="fill" aria-hidden />
            <span>{place.name}</span>
          </button>
        ) : null}
        <span className="ade-wx2-clock kit-num" title={now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}>
          {time}
        </span>
        {weather ? (
          <div className="kit-seg ade-wx2-unit" role="radiogroup" aria-label="Temperature unit">
            {(["c", "f"] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={unit === option} onClick={() => updateSettings(item.id, { unit: option })}>
                °{option.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-wx2-body">
        {!bridge ? (
          <div className="ade-home-empty"><span>Weather needs the ADE desktop app.</span></div>
        ) : showPicker ? (
          <PlacePicker
            onCancel={place ? () => setPicking(false) : undefined}
            onPick={(picked) => {
              updateSettings(item.id, { place: { name: picked.name, detail: picked.detail, latitude: picked.latitude, longitude: picked.longitude } });
              setPicking(false);
            }}
          />
        ) : !place ? (
          <div className="ade-home-empty"><span>Pick a city and it shows the weather there.</span></div>
        ) : error && !weather ? (
          <div className="ade-home-empty" role="alert"><span>{error}</span></div>
        ) : !weather || !kind ? (
          <div className="ade-home-empty"><span>Reading the weather…</span></div>
        ) : (
          <>
            <div className="ade-wx2-now">
              <WeatherGlyph kind={kind} size={40} title={label ?? undefined} />
              <span className="ade-wx2-temp kit-num">{deg(weather.temperatureC)}</span>
              <span className="ade-wx2-cond">
                <span className="ade-wx2-label">{label}</span>
                <span className="ade-wx2-sub kit-num">
                  {weather.todayMaxC != null ? `H ${deg(weather.todayMaxC)}  L ${deg(weather.todayMinC)}` : date}
                  {weather.apparentC != null ? ` · feels ${deg(weather.apparentC)}` : ""}
                </span>
              </span>
            </div>
            {hours.length > 0 ? (
              <div className="ade-wx2-hours" role="list" aria-label="Next hours">
                {hours.map((hour, index) => (
                  <div key={`${hour.hour}-${index}`} className="ade-wx2-hour" role="listitem">
                    <span className="ade-wx2-hour-label kit-num">{index === 0 ? "Now" : hourLabel(hour.hour)}</span>
                    <WeatherGlyph kind={weatherKind(hour.code, hour.isDay)} size={18} title={weatherLabel(hour.code)} />
                    <span className="ade-wx2-hour-temp kit-num">{deg(hour.tempC)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {days.length > 0 ? (
              <FitList className="ade-wx2-days-fit" listClassName="ade-wx2-days" ariaLabel="Next days">
                {days.map((day) => {
                  const [y, m, d] = day.date.split("-").map(Number);
                  const when = new Date(y!, (m ?? 1) - 1, d);
                  return (
                    <div key={day.date} className="ade-wx2-day" role="listitem" title={weatherLabel(day.code)}>
                      <span className="ade-wx2-day-name">{when.toLocaleDateString(undefined, { weekday: "short" })}</span>
                      <WeatherGlyph kind={weatherKind(day.code, true)} size={16} title={weatherLabel(day.code)} />
                      <span className="kit-num ade-wx2-day-min">{deg(day.minC)}</span>
                      <span className="ade-wx2-day-bar" aria-hidden>
                        <i style={{ left: `${((day.minC - lowest) / spread) * 100}%`, right: `${((highest - day.maxC) / spread) * 100}%` }} />
                      </span>
                      <span className="kit-num ade-wx2-day-max">{deg(day.maxC)}</span>
                    </div>
                  );
                })}
              </FitList>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
