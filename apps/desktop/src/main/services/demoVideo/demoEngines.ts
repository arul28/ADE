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
};

export function createDemoEngineSet(args: {
  logger: Logger;
  getChromiumDemoEngine?: (() => DemoEngine | null) | null;
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
  };
}
