import { useCallback, useEffect, useRef, useState } from "react";
import { CloudSun, MapPin } from "@phosphor-icons/react";
import type { HomeWeather, HomeWeatherPlace } from "../../../../shared/types/homeWidgets";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetPreview, useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import { WeatherGlyph, weatherKind, weatherLabel } from "./WeatherGlyph";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { FitList } from "../HomeFitList";
import { Banner } from "../../ui/notice";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { usePolling } from "../../../hooks/usePolling";
import "../homeWidgets.css";
import { isAdeAvailable } from "../../../lib/adeAvailability";

/**
 * Clock & weather, in the same quiet card as the rest of the page: the time
 * in the head, then now (an animated condition glyph, the temperature, the
 * condition, high and low), a tight strip of the next hours, and as many of
 * the next days as fit. No coloured panels; colour is only in the glyphs.
 *
 * The clock repaints once a minute, on the minute. Weather is
 * Open-Meteo (free, no key) for a place the user types, or until they do, the
 * city this computer's internet address is in (falling back to the city in
 * the system time zone's name): no location prompt and no precise position. Main caches each place for 15 minutes; this card asks every 30
 * while it is on screen. Glyphs hold still off screen. A gallery preview
 * shows a sample day and reads nothing.
 */

type PlaceSetting = { name: string; detail: string | null; latitude: number; longitude: number };

function readPlace(value: unknown): PlaceSetting | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.latitude !== "number" || typeof raw.longitude !== "number") return null;
  return { name: raw.name, detail: typeof raw.detail === "string" ? raw.detail : null, latitude: raw.latitude, longitude: raw.longitude };
}

/**
 * A coarse place with no prompt: the city this computer's internet address
 * is in (`weather.locate`), or when that fails, the city in the system time
 * zone's name ("America/New_York" → New York). Kept a few hours per time
 * zone, so a laptop that travels catches up. A zone with no city in it (UTC,
 * Etc/GMT+5) and no address lookup gives nothing, and the card asks.
 */
const AUTO_PLACE_KEY = "ade.home.weather.autoPlace.v2";
const AUTO_PLACE_TTL_MS = 6 * 3_600_000;
let autoPlaceRequest: { zone: string; promise: Promise<PlaceSetting | null> } | null = null;

function systemTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function timeZoneCity(zone: string): string | null {
  const parts = zone.split("/");
  if (parts.length < 2 || parts[0] === "Etc") return null;
  const city = parts[parts.length - 1]!.replace(/_/g, " ").trim();
  return city.length >= 2 ? city : null;
}

function readAutoPlace(zone: string): PlaceSetting | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(AUTO_PLACE_KEY) ?? "null") as { zone?: unknown; place?: unknown; at?: unknown } | null;
    if (!raw || raw.zone !== zone || typeof raw.at !== "number" || Date.now() - raw.at > AUTO_PLACE_TTL_MS) return null;
    return readPlace(raw.place);
  } catch {
    return null;
  }
}

/** The desktop weather bridge, or undefined where there is none (the web client). */
function weatherBridge() {
  const bridge = window.ade?.home?.weather;
  return isAdeAvailable(bridge) ? bridge : undefined;
}

function lookUpAutoPlace(zone: string): Promise<PlaceSetting | null> {
  if (autoPlaceRequest?.zone === zone) return autoPlaceRequest.promise;
  const city = timeZoneCity(zone);
  const bridge = weatherBridge();
  const promise = (async () => {
    if (!bridge) return null;
    let picked: HomeWeatherPlace | null = null;
    const located = await bridge.locate?.().catch(() => null);
    if (located?.ok) picked = located.place;
    else if (city) {
      const result = await bridge.search(city).catch(() => null);
      if (result?.ok && result.places.length) picked = result.places.find((entry) => entry.timezone === zone) ?? result.places[0]!;
    }
    if (!picked) return null;
    const place: PlaceSetting = { name: picked.name, detail: picked.detail, latitude: picked.latitude, longitude: picked.longitude };
    try {
      window.localStorage.setItem(AUTO_PLACE_KEY, JSON.stringify({ zone, place, at: Date.now() }));
    } catch {
      // Storage full or blocked: it is looked up again next launch.
    }
    return place;
  })();
  autoPlaceRequest = { zone, promise };
  return promise;
}

/** The place from the time zone, or null while it is looked up or when there is none. */
function useAutoPlace(enabled: boolean): { place: PlaceSetting | null; settled: boolean } {
  const zone = systemTimeZone();
  const [state, setState] = useState<{ place: PlaceSetting | null; settled: boolean }>(() => {
    const cached = enabled && zone ? readAutoPlace(zone) : null;
    return { place: cached, settled: Boolean(cached) || !enabled || !zone };
  });
  useEffect(() => {
    if (!enabled || !zone || state.settled) return undefined;
    let cancelled = false;
    void lookUpAutoPlace(zone).then((place) => {
      if (!cancelled) setState({ place, settled: true });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, zone, state.settled]);
  return state;
}

/**
 * What a gallery preview shows: a made-up mild day, so the tile looks like
 * the real card without a place lookup or a forecast read leaving the machine.
 */
const PREVIEW_PLACE: PlaceSetting = { name: "Your city", detail: null, latitude: 0, longitude: 0 };

function previewWeather(now: Date): HomeWeather {
  const day = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const codes = [2, 1, 3, 61, 0, 2];
  return {
    temperatureC: 18,
    apparentC: 17,
    code: 2,
    isDay: true,
    windKph: 9,
    todayMaxC: 21,
    todayMinC: 12,
    days: codes.map((code, index) => ({ date: day(index), code, maxC: 21 - (index % 3), minC: 12 - (index % 2) })),
    hours: Array.from({ length: 12 }, (_, index) => ({ hour: (now.getHours() + index) % 24, code: index < 4 ? 2 : 1, tempC: 18 + Math.round(Math.sin(index / 3) * 2), isDay: true })),
    fetchedAt: now.getTime(),
  };
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

function PlacePicker({
  onPick,
  onCancel,
  onUseLocation,
}: {
  onPick: (place: HomeWeatherPlace) => void;
  onCancel?: () => void;
  /** Back to the place found automatically; shown once a place was picked. */
  onUseLocation?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HomeWeatherPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const search = useCallback(async (text: string) => {
    const bridge = weatherBridge();
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
      data-results={results && results.length > 0 ? "true" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void search(query);
      }}
    >
      <div className="ade-hw-place-intro">
        <WeatherGlyph kind="partly" size={40} />
        <span className="ade-hw-place-title">{onCancel ? "Change place" : "Weather where you are"}</span>
        <span className="ade-hw-place-hint">Type a city. Only its name is looked up.</span>
      </div>
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
        {onCancel ? <button type="button" className="kit-btn kit-btn-ghost" onClick={onCancel}>Cancel</button> : null}
      </div>
      {onUseLocation ? (
        <button type="button" className="kit-btn kit-btn-ghost ade-hw-use-location" onClick={onUseLocation}>
          <MapPin size={12} weight="fill" aria-hidden />
          Use my location
        </button>
      ) : null}
      {error ? (
        <Banner
          layout="inline"
          model={{
            // The weather service being out of reach is not an ADE failure.
            id: "home-weather-place-search-error",
            tone: "warning",
            title: error,
            report: false,
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
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
  const chosen = readPlace(item.settings?.place);
  // No city chosen: the time zone's city, looked up once without a prompt.
  // A gallery preview reads nothing: it shows a sample day.
  const auto = useAutoPlace(!preview && !chosen && weatherBridge() != null);
  const place = preview ? PREVIEW_PLACE : chosen ?? auto.place;
  const unit: "c" | "f" = item.settings?.unit === "f" || item.settings?.unit === "c" ? item.settings.unit : defaultUnit();
  const [liveWeather, setWeather] = useState<HomeWeather | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const bridge = weatherBridge();
  const span = useWidgetSpan(item);
  const wide = span.w >= 2;

  const lat = place?.latitude;
  const lon = place?.longitude;
  const readWeather = useCallback(async () => {
    if (!bridge || lat == null || lon == null) return;
    const result = await bridge.get({ latitude: lat, longitude: lon });
    if (result.ok) {
      setWeather(result.weather);
      setError(null);
    } else {
      setError("Weather is unavailable right now.");
    }
  }, [bridge, lat, lon]);
  const readActive = !preview && visible && lat != null && lon != null && Boolean(bridge);
  // A new place reads its weather now: the poll below owns the first read and
  // then repeats only every half hour, so on its own a change sat on "Reading".
  const placeKey = lat == null || lon == null ? null : `${lat},${lon}`;
  const shownPlaceRef = useRef(placeKey);
  useEffect(() => {
    if (shownPlaceRef.current === placeKey) return;
    shownPlaceRef.current = placeKey;
    setWeather(null);
    setError(null);
    if (readActive) void readWeather();
  }, [placeKey, readActive, readWeather]);
  usePolling(readWeather, 30 * 60_000, readActive);
  const weather = preview ? previewWeather(now) : liveWeather;

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
  // A gallery preview never asks for a place.
  const showPicker = Boolean(bridge) && !preview && (picking || (!place && auto.settled));

  return (
    <section
      className="kit-card ade-home-card ade-wx2"
      aria-label="Clock and weather"
      data-wide={wide || undefined}
      data-still={!visible || preview ? "true" : undefined}
    >
      <WelcomeCardHead icon={CloudSun} title="Weather">
        {place && !picking ? (
          <button type="button" className="ade-wx2-place" title={chosen ? "Change place" : "Near this computer (from its internet address). Change place"} onClick={() => setPicking(true)}>
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
            onUseLocation={chosen ? () => {
              updateSettings(item.id, { place: null });
              setPicking(false);
            } : undefined}
            onPick={(picked) => {
              updateSettings(item.id, { place: { name: picked.name, detail: picked.detail, latitude: picked.latitude, longitude: picked.longitude } });
              setPicking(false);
            }}
          />
        ) : !place ? (
          <div className="ade-home-empty"><span>Finding your city…</span></div>
        ) : error && !weather ? (
          <Banner
            layout="inline"
            style={{ margin: 10 }}
            model={{
              id: "home-weather-error",
              tone: "warning",
              title: error,
              report: false,
            }}
          />
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
