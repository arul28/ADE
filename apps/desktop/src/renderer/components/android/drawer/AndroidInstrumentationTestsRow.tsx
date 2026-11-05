import { useEffect, useState, useSyncExternalStore } from "react";
import type { AndroidInstrumentationTestResult } from "../../../../shared/types/androidEmulator";
import { showToast } from "../../app/toast/toastStore";
import { cn } from "../../ui/cn";
import { DRAWER_BUTTON, DRAWER_INPUT, Subhead } from "../../ui/drawerPrimitives";
import { Banner } from "../../ui/notice";
import { Spinner } from "../../ui/Spinner";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * P3: "Run tests" in the App group. It runs the lane app's instrumentation
 * tests on the lane's emulator (`runInstrumentationTests`, Gradle's
 * `connectedDebugAndroidTest`) and shows the counts and the first failures
 * inline. A run takes minutes, so it has its own running state and does not
 * hold the drawer's other actions. The App group unmounts when it closes, so
 * the run and its last result live here, per lane and machine, and come back
 * when the group opens again.
 */

type TestRun = { running: boolean; result: AndroidInstrumentationTestResult | null; error: unknown };

const runs = new Map<string, TestRun>();
const listeners = new Set<() => void>();
const EMPTY: TestRun = { running: false, result: null, error: null };

function setRun(key: string, run: TestRun) {
  runs.set(key, run);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How many failures the row names; the rest are counted. */
const SHOWN_FAILURES = 3;

function summary(result: AndroidInstrumentationTestResult): string {
  if (result.total === 0) return "No tests ran";
  if (result.failed > 0) return `${result.failed} of ${result.total} tests failed`;
  return `${result.passed} of ${result.total} tests passed${result.skipped ? ` · ${result.skipped} skipped` : ""}`;
}

export function AndroidInstrumentationTestsRow({ ctx }: { ctx: AndroidDrawerContext }) {
  const { laneId, pinRef, actions } = ctx;
  const key = `${pinRef.current?.key ?? "local"}:${laneId}`;
  const run = useSyncExternalStore(subscribe, () => runs.get(key) ?? EMPTY);
  const [className, setClassName] = useState("");
  const reportError = actions.reportError;

  // A refusal (not booted, a run already going) goes to the drawer's error strip once.
  useEffect(() => {
    if (!run.error) return;
    reportError(run.error);
    setRun(key, { ...run, error: null });
  }, [key, reportError, run]);

  const start = () => {
    const pin = pinRef.current;
    const filter = className.trim();
    setRun(key, { running: true, result: runs.get(key)?.result ?? null, error: null });
    void window.ade.androidEmulator
      .runInstrumentationTests({ laneId, gradle: {}, ...(filter ? { className: filter } : {}) }, pin)
      .then((result) => {
        setRun(key, { running: false, result, error: null });
        showToast({
          id: `android-tests-${laneId}`,
          tone: result.ok ? "success" : "warning",
          title: summary(result),
          message: result.gradleTask,
        });
      })
      .catch((cause: unknown) => setRun(key, { running: false, result: runs.get(key)?.result ?? null, error: cause }));
  };

  const result = run.result;
  const failures = result?.failures.slice(0, SHOWN_FAILURES) ?? [];
  const more = result ? result.failed - failures.length : 0;
  return (
    <>
      <Subhead label="Tests" />
      <div className="flex min-h-7 items-center gap-1.5">
        <input
          className={cn(DRAWER_INPUT, "min-w-0 flex-1 font-mono")}
          placeholder="All tests, or com.example.MyTest"
          aria-label="Test class"
          value={className}
          disabled={run.running}
          onChange={(event) => setClassName(event.target.value)}
        />
        <button
          type="button"
          className={DRAWER_BUTTON}
          disabled={run.running || actions.disabled}
          title="Build the app and its tests with Gradle, then run them on this lane's emulator"
          data-testid="android-drawer-run-tests"
          onClick={start}
        >
          {run.running ? <Spinner /> : null}
          {run.running ? "Running…" : "Run tests"}
        </button>
      </div>
      {result ? (
        <Banner
          layout="inline"
          model={{
            id: "android-drawer-tests",
            tone: result.ok ? "success" : "warning",
            title: summary(result),
            detail: failures.length ? (
              <span className="flex min-w-0 flex-col" data-testid="android-drawer-test-failures">
                {failures.map((failure) => (
                  <span key={`${failure.className}#${failure.name}`} className="min-w-0 break-words font-mono text-[11px]">
                    {`${failure.className.split(".").pop() ?? failure.className}.${failure.name}: ${failure.message[0] ?? "failed"}`}
                  </span>
                ))}
                {more > 0 ? <span>{`${more} more failed`}</span> : null}
              </span>
            ) : `${result.gradleTask} · ${Math.max(1, Math.round(result.durationMs / 1000))} s`,
            // The failures are the app's, not ADE's.
            report: false,
          }}
        />
      ) : null}
    </>
  );
}
