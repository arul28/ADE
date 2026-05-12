import { setPerfActive, startRendererMemorySampler } from "../markers";
import { installWebVitalsObservers } from "../webVitals";
import { runScenario } from "../scenarios";

export async function initPerfRuntime(): Promise<void> {
  const cfg = await window.ade?.perf?.getConfig?.();
  if (!cfg?.active) return;

  setPerfActive(true);
  installWebVitalsObservers();
  startRendererMemorySampler();

  window.ade?.perf?.recordEvent({
    kind: "note",
    ts: Date.now(),
    note: "rendererPerfReady",
    initialRoute: cfg.initialRoute ?? null,
    scenario: cfg.scenario ?? null,
  });

  if (cfg.initialRoute) {
    // Navigate immediately so the warm-mode shortcut lands on the requested tab.
    const target = cfg.initialRoute.startsWith("/")
      ? `#${cfg.initialRoute}`
      : cfg.initialRoute.startsWith("#")
        ? cfg.initialRoute
        : `#/${cfg.initialRoute}`;
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
  }

  if (!cfg.scenario) return;

  // Defer scenario kick-off until after first paint so we measure realistic cold flows.
  const start = () => {
    setTimeout(() => {
      void runScenario(cfg.scenario as string).catch((error) => {
        window.ade?.perf?.recordEvent({
          kind: "note",
          ts: Date.now(),
          note: "scenarioRunnerFailed",
          scenario: cfg.scenario,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 1500);
  };
  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start, { once: true });
  }
}
