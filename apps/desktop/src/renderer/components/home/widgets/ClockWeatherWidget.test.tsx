/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetPreviewContext } from "../HomeWidgetGrid";
import ClockWeatherWidget from "./ClockWeatherWidget";

/**
 * The Add widget gallery renders every widget live. A preview must not send
 * anything off the machine: no place lookup, no forecast read.
 */
const PLACE = { name: "Lisbon", detail: "Portugal", latitude: 38.72, longitude: -9.14 };

function installWeatherBridge() {
  const weather = {
    get: vi.fn(async () => ({ ok: false as const, error: "offline" })),
    search: vi.fn(async () => ({ ok: true as const, places: [] })),
  };
  Object.defineProperty(window, "ade", { configurable: true, writable: true, value: { home: { weather } } });
  return weather;
}

afterEach(() => cleanup());

describe("Clock & weather in the widget gallery", () => {
  it.each([
    ["with a chosen city", { place: PLACE }],
    ["with no city chosen yet", {}],
  ])("reads no weather and looks up no place as a preview, %s", async (_label, settings) => {
    const weather = installWeatherBridge();
    render(
      <WidgetPreviewContext.Provider value>
        <ClockWeatherWidget item={{ id: "clock-preview", type: "clock", size: "m", settings }} />
      </WidgetPreviewContext.Provider>,
    );
    // Let every effect run.
    await act(async () => {});
    expect(weather.get).not.toHaveBeenCalled();
    expect(weather.search).not.toHaveBeenCalled();

    // The same widget on the page does read its city's weather.
    cleanup();
    render(<ClockWeatherWidget item={{ id: "clock", type: "clock", size: "m", settings: { place: PLACE } }} />);
    await waitFor(() => expect(weather.get).toHaveBeenCalledWith({ latitude: PLACE.latitude, longitude: PLACE.longitude }));
  });
});
