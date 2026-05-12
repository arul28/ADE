import { perfMark, perfMeasure } from "../markers";

export type ScenarioContext = {
  mark: (name: string) => void;
  measure: (name: string, startMark: string, endMark?: string) => number | null;
  /** Wait until the test condition returns truthy, or timeoutMs elapses. Returns true if found. */
  waitFor: (testFn: () => boolean, timeoutMs?: number) => Promise<boolean>;
  /** Wait until a DOM element with [data-testid=id] appears. */
  waitForTestId: (id: string, timeoutMs?: number) => Promise<HTMLElement | null>;
  /** Click an element by testid. Throws if not found within timeout. */
  clickTestId: (id: string, timeoutMs?: number) => Promise<void>;
  /** Navigate (hash-router style). */
  navigate: (route: string) => Promise<void>;
  /** Idle for ms, lets the event loop breathe and metrics samplers tick. */
  idle: (ms: number) => Promise<void>;
  /** Assert an invariant; pushes failure to smokeFailures if false. */
  assert: (condition: boolean, message: string) => void;
};

export type Scenario = {
  id: string;
  description: string;
  requiresClaude?: boolean;
  run: (ctx: ScenarioContext) => Promise<void>;
};

const registry = new Map<string, Scenario>();

export function registerScenario(scenario: Scenario): void {
  if (registry.has(scenario.id)) {
    throw new Error(`Duplicate perf scenario id: ${scenario.id}`);
  }
  registry.set(scenario.id, scenario);
}

export function getScenario(id: string): Scenario | null {
  return registry.get(id) ?? null;
}

export function listScenarios(): string[] {
  return [...registry.keys()];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(testFn: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (testFn()) return true;
    await delay(50);
  }
  return false;
}

async function waitForTestId(id: string, timeoutMs = 10_000): Promise<HTMLElement | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (el && el.offsetParent !== null) return el;
    await delay(50);
  }
  return null;
}

function makeContext(smokeFailures: string[]): ScenarioContext {
  return {
    mark: (name) => perfMark(name),
    measure: (name, startMark, endMark) => perfMeasure(name, startMark, endMark),
    waitFor,
    waitForTestId,
    clickTestId: async (id, timeoutMs = 5_000) => {
      const el = await waitForTestId(id, timeoutMs);
      if (!el) {
        throw new Error(`clickTestId timeout: ${id}`);
      }
      el.click();
    },
    navigate: async (route) => {
      window.location.hash = route.startsWith("#") ? route : `#${route}`;
      await delay(50);
    },
    idle: (ms) => delay(ms),
    assert: (condition, message) => {
      if (!condition) smokeFailures.push(message);
    },
  };
}

async function loadScenarioModule(scenarioId: string): Promise<void> {
  const prefix = scenarioId.split(".", 1)[0] ?? scenarioId;
  switch (prefix) {
    case "lanes":
      await import("./lanes");
      return;
    case "boot":
      await import("./boot");
      return;
    default:
      // Best-effort: try direct import. If it fails, the scenario lookup will report not-found.
      try {
        await import(/* @vite-ignore */ `./${prefix}`);
      } catch {
        // ignore — handled by caller
      }
  }
}

async function finalizePerfRun(): Promise<void> {
  try {
    await window.ade?.perf?.finalize();
  } catch {
    // ignore
  }
}

export async function runScenario(scenarioId: string): Promise<void> {
  await loadScenarioModule(scenarioId);

  const scenario = getScenario(scenarioId);
  if (!scenario) {
    await window.ade?.perf?.recordEvent({
      kind: "note",
      ts: Date.now(),
      note: "scenarioNotFound",
      scenario: scenarioId,
    });
    await window.ade?.perf?.scenarioComplete({
      scenario: scenarioId,
      ok: false,
      smokeFailures: ["scenario not found"],
    });
    await finalizePerfRun();
    return;
  }

  const cfg = await window.ade?.perf?.getConfig?.();
  if (scenario.requiresClaude && !cfg?.allowClaude) {
    await window.ade?.perf?.scenarioComplete({
      scenario: scenarioId,
      ok: false,
      smokeFailures: ["requiresClaude but ADE_PERF_ALLOW_CLAUDE not set"],
    });
    await finalizePerfRun();
    return;
  }

  const smokeFailures: string[] = [];
  const ctx = makeContext(smokeFailures);

  window.ade?.perf?.recordEvent({
    kind: "scenarioStart",
    ts: Date.now(),
    scenario: scenarioId,
    description: scenario.description,
  });

  let ok = true;
  try {
    await scenario.run(ctx);
  } catch (err) {
    ok = false;
    smokeFailures.push(err instanceof Error ? err.message : String(err));
  }

  await window.ade?.perf?.scenarioComplete({
    scenario: scenarioId,
    ok: ok && smokeFailures.length === 0,
    smokeFailures,
  });

  // Auto-finalize so the harness script can detect summary.json appearing.
  await finalizePerfRun();
}
