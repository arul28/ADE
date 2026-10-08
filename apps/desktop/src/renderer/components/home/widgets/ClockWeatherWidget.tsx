import { useCallback, useEffect, useRef, useState } from "react";
import { MapPin } from "@phosphor-icons/react";
import type { HomeWeather, HomeWeatherHour, HomeWeatherPlace } from "../../../../shared/types/homeWidgets";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetPreview, useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import { WeatherGlyph, weatherKind, weatherLabel, weatherSky } from "./WeatherGlyph";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { usePolling } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * Clock & weather, drawn as a sky: the card takes the colour of the weather
 * and the time of day, with glass panels for now, the next hours and the
 * next days, and animated condition glyphs (paused off screen).
 *
 * The clock repaints once a minute, on the minute. Weather is
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
  const tall = span.h >= 2;

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
  const hh = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const [clock, meridiem] = hh.split(/\s(?=[AP]M$)/i);
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const kind = weather ? weatherKind(weather.code, weather.isDay) : null;
  const sky = kind && weather ? weatherSky(kind, weather.isDay, now.getHours()) : now.getHours() >= 19 || now.getHours() < 6 ? "night" : "day";
  const label = weather ? weatherLabel(weather.code) : null;
  const hourCount = span.w >= 2 ? 6 : 4;
  const hours = (weather?.hours ?? []).slice(0, hourCount);
  const days = (weather?.days ?? []).slice(1, tall ? 5 : 4);
  const lowest = Math.min(...days.map((day) => day.minC));
  const highest = Math.max(...days.map((day) => day.maxC));
  const spread = Math.max(1, highest - lowest);
  const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });

  const tempPanel = weather && kind ? (
    <div className="ade-hw-glass ade-hw-now">
      <div className="ade-hw-now-top">
        <span className="ade-hw-temp kit-num">{deg(weather.temperatureC)}</span>
        <WeatherGlyph kind={kind} size={tall || wide ? 44 : 38} title={label ?? undefined} />
      </div>
      <div className="ade-hw-cond">
        <span>{label}</span>
        {weather.todayMaxC != null ? <span className="kit-num ade-hw-hilo">H {deg(weather.todayMaxC)} · L {deg(weather.todayMinC)}</span> : null}
      </div>
    </div>
  ) : null;

  const clockPanel = (
    <div className={`ade-hw-clock${wide && weather ? " ade-hw-glass" : ""}`}>
      <div className="ade-hw-time kit-num">
        {clock}
        {meridiem ? <span className="ade-hw-meridiem">{meridiem}</span> : null}
      </div>
      <div className="ade-hw-date">{date}</div>
      {place && !picking ? (
        <button type="button" className="ade-hw-place-pill" title="Change place" onClick={() => setPicking(true)}>
          <MapPin size={11} weight="fill" aria-hidden />
          {place.name}
        </button>
      ) : null}
    </div>
  );

  return (
    <section
      className="kit-card ade-home-card ade-hw"
      aria-label="Clock and weather"
      data-size={item.size}
      data-sky={sky}
      data-wide={wide || undefined}
      data-tall={tall || undefined}
      data-still={!visible || preview ? "true" : undefined}
    >
      <div className="ade-hw-sky" aria-hidden>
        <span className="ade-hw-blob ade-hw-blob-a" />
        <span className="ade-hw-blob ade-hw-blob-b" />
      </div>
      <div className="ade-hw-body">
        {!bridge ? (
          <>
            {clockPanel}
            <div className="ade-hw-note">Weather needs the ADE desktop app.</div>
          </>
        ) : picking || !place ? (
          <>
            {clockPanel}
            <div className="ade-hw-glass ade-hw-picker">
              <PlacePicker
                onCancel={place ? () => setPicking(false) : undefined}
                onPick={(picked) => {
                  updateSettings(item.id, { place: { name: picked.name, detail: picked.detail, latitude: picked.latitude, longitude: picked.longitude } });
                  setPicking(false);
                }}
              />
            </div>
          </>
        ) : error && !weather ? (
          <>
            {clockPanel}
            <div className="ade-hw-note" role="alert">{error}</div>
          </>
        ) : !weather ? (
          <>
            {clockPanel}
            <div className="ade-hw-note">Reading the weather…</div>
          </>
        ) : (
          <>
            {wide && tall && hours.length > 0 ? <HourStrip hours={hours} deg={deg} hourLabel={hourLabel} /> : null}
            <div className="ade-hw-pair">
              {tempPanel}
              {wide ? clockPanel : null}
            </div>
            {!wide ? clockPanel : null}
            {!(wide && tall) && (tall || wide) && hours.length > 0 ? <HourStrip hours={hours} deg={deg} hourLabel={hourLabel} /> : null}
            {tall && days.length > 0 ? (
              <div className="ade-hw-glass ade-hw-days" role="list" aria-label="Next days">
                {days.map((day) => {
                  const [y, m, d] = day.date.split("-").map(Number);
                  const when = new Date(y!, (m ?? 1) - 1, d);
                  const dayKind = weatherKind(day.code, true);
                  return (
                    <div key={day.date} className="ade-hw-day" role="listitem" title={weatherLabel(day.code)}>
                      <WeatherGlyph kind={dayKind} size={18} title={weatherLabel(day.code)} />
                      <span className="ade-hw-day-name">{when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                      <span className="kit-num ade-hw-day-min">{deg(day.minC)}</span>
                      <span className="ade-hw-day-bar" aria-hidden>
                        <i style={{ left: `${((day.minC - lowest) / spread) * 100}%`, right: `${((highest - day.maxC) / spread) * 100}%` }} />
                      </span>
                      <span className="kit-num ade-hw-day-max">{deg(day.maxC)}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
      {weather ? (
        <div className="ade-hw-unit" role="radiogroup" aria-label="Temperature unit">
          {(["c", "f"] as const).map((option) => (
            <button key={option} type="button" role="radio" aria-checked={unit === option} onClick={() => updateSettings(item.id, { unit: option })}>
              °{option.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function HourStrip({ hours, deg, hourLabel }: { hours: HomeWeatherHour[]; deg: (c: number) => string; hourLabel: (hour: number) => string }) {
  return (
    <div className="ade-hw-glass ade-hw-hours" role="list" aria-label="Next hours">
      {hours.map((hour, index) => (
        <div key={`${hour.hour}-${index}`} className="ade-hw-hour" role="listitem">
          <span className="ade-hw-hour-label kit-num">{hourLabel(hour.hour)}</span>
          <WeatherGlyph kind={weatherKind(hour.code, hour.isDay)} size={20} title={weatherLabel(hour.code)} />
          <span className="kit-num ade-hw-hour-temp">{deg(hour.tempC)}</span>
        </div>
      ))}
    </div>
  );
}
