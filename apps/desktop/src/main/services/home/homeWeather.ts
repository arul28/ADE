import type {
  HomeWeather,
  HomeWeatherPlace,
  HomeWeatherResult,
  HomeWeatherSearchResult,
} from "../../../shared/types/homeWidgets";

/**
 * Weather for the home page's Clock & weather widget: two small HTTPS reads
 * to Open-Meteo (free, no key), cached 15 minutes per place. The caller
 * passes the fetch to use; in the app it is Electron's `net.fetch`, which
 * honors the system proxy where Node's fetch does not.
 */

export type HomeWeatherFetch = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const WEATHER_TTL_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

type WeatherCodeSource = {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    is_day?: number;
    wind_speed_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    weather_code?: number[];
    is_day?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createWeatherService(deps: { fetch: HomeWeatherFetch }) {
  const fetchJson = async (url: string): Promise<unknown> => {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const weatherCache = new Map<string, HomeWeather>();

  const search = async (query: string): Promise<HomeWeatherSearchResult> => {
    const name = query.trim().slice(0, 80);
    if (name.length < 2) return { ok: true, places: [] };
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=en&format=json`;
      const raw = (await fetchJson(url)) as { results?: Array<Record<string, unknown>> };
      const places: HomeWeatherPlace[] = (raw.results ?? []).flatMap((row) => {
        const latitude = finite(row.latitude);
        const longitude = finite(row.longitude);
        if (latitude == null || longitude == null || typeof row.name !== "string") return [];
        const detail = [row.admin1, row.country].filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
        return [{
          name: row.name,
          detail: detail || null,
          latitude,
          longitude,
          timezone: typeof row.timezone === "string" ? row.timezone : null,
        }];
      });
      return { ok: true, places };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const get = async (args: { latitude: number; longitude: number }): Promise<HomeWeatherResult> => {
    const latitude = finite(args?.latitude);
    const longitude = finite(args?.longitude);
    if (latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return { ok: false, error: "Invalid place." };
    }
    // Coarse on purpose: two decimals is about a kilometre.
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return { ok: true, weather: cached };
    try {
      const url = "https://api.open-meteo.com/v1/forecast"
        + `?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}`
        + "&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m"
        + "&hourly=temperature_2m,weather_code,is_day&forecast_hours=13"
        + "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5";
      const raw = (await fetchJson(url)) as WeatherCodeSource;
      const temperatureC = finite(raw.current?.temperature_2m);
      if (temperatureC == null) return { ok: false, error: "No current weather for that place." };
      const daily = raw.daily ?? {};
      const days = (daily.time ?? []).flatMap((date, index) => {
        const maxC = finite(daily.temperature_2m_max?.[index]);
        const minC = finite(daily.temperature_2m_min?.[index]);
        const code = finite(daily.weather_code?.[index]);
        return maxC == null || minC == null || code == null ? [] : [{ date, code, maxC, minC }];
      });
      const hourly = raw.hourly ?? {};
      const hours = (hourly.time ?? []).flatMap((time, index) => {
        const temp = finite(hourly.temperature_2m?.[index]);
        const code = finite(hourly.weather_code?.[index]);
        // Local wall time at the place, "2026-10-07T17:00": keep the hour as written.
        const hour = Number(/T(\d{2}):/.exec(time)?.[1]);
        return temp == null || code == null || !Number.isFinite(hour) ? [] : [{ hour, code, tempC: temp, isDay: hourly.is_day?.[index] !== 0 }];
      }).slice(1, 13);
      const weather: HomeWeather = {
        temperatureC,
        apparentC: finite(raw.current?.apparent_temperature),
        code: finite(raw.current?.weather_code) ?? 0,
        isDay: raw.current?.is_day !== 0,
        windKph: finite(raw.current?.wind_speed_10m),
        todayMaxC: days[0]?.maxC ?? null,
        todayMinC: days[0]?.minC ?? null,
        days,
        hours,
        fetchedAt: Date.now(),
      };
      weatherCache.set(key, weather);
      return { ok: true, weather };
    } catch (error) {
      if (cached) return { ok: true, weather: cached };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return { search, get };
}
