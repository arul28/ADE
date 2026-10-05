/**
 * The demo engines this process can use, in the order they are tried.
 *
 * The Swift `ade-media` is built lazily on first use and only on macOS; the
 * Chromium engine exists only where the ADE desktop app runs (in-process in
 * Electron main, over the desktop bridge in the runtime daemon), so it is
 * asked for each time rather than kept.
 */

import type { DemoEngine } from "../../../shared/demoVideo/demoContract";
import type { Logger } from "../logging/logger";
import { resolveAdeMediaBinary } from "../native/nativeHelperPaths";
import { createSwiftDemoEngine } from "./swiftDemoEngine";

export type DemoEngineSet = {
  engines(): DemoEngine[];
  /**
   * Why the desktop app's engine is not here, when this process reaches it
   * over the bridge and it is missing; null otherwise. A recording filed
   * uncut says this instead of a generic "no demo engine".
   */
  missingEngineReason?(): string | null;
};

export function createDemoEngineSet(args: {
  logger: Logger;
  getChromiumDemoEngine?: (() => DemoEngine | null) | null;
  /** Why the desktop app could not attach, when one tried. */
  getChromiumUnavailableReason?: (() => string | null) | null;
}): DemoEngineSet {
  let swift: DemoEngine | null | undefined;
  const swiftEngine = (): DemoEngine | null => {
    if (swift !== undefined) return swift;
    const binaryPath = resolveAdeMediaBinary({ logger: args.logger });
    swift = binaryPath ? createSwiftDemoEngine({ binaryPath, logger: args.logger }) : null;
    return swift;
  };
  return {
    engines() {
      const list: DemoEngine[] = [];
      const native = swiftEngine();
      if (native) list.push(native);
      const chromium = args.getChromiumDemoEngine?.() ?? null;
      if (chromium) list.push(chromium);
      return list;
    },
    missingEngineReason() {
      if (!args.getChromiumDemoEngine || args.getChromiumDemoEngine()) return null;
      const why = args.getChromiumUnavailableReason?.()?.trim();
      return why
        ? `the ADE desktop app was not connected to make the demo (${why})`
        : "the ADE desktop app was not connected to make the demo";
    },
  };
}
