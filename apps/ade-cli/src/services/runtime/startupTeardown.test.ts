import { describe, expect, it, vi } from "vitest";
import { createTeardownStack } from "./startupTeardown";

/**
 * These cover the failure path of `createAdeRuntime`: a throw part-way through
 * construction used to leave the native database handle open and every started
 * service running, and the sync-host retry loop leaked one runtime per attempt.
 */
describe("createTeardownStack", () => {
  it("releases in reverse acquisition order, so the store closes last", () => {
    const calls: string[] = [];
    const stack = createTeardownStack();
    // The order the runtime acquires them: database first, services after.
    stack.push(() => calls.push("db.close"));
    stack.push(() => calls.push("analyticsExporter.stop"));
    stack.push(() => calls.push("processRegistry.stop"));

    stack.drain();

    expect(calls).toEqual(["processRegistry.stop", "analyticsExporter.stop", "db.close"]);
  });

  // An async `dispose` is not awaited, and its rejection (a read of the store
  // the same drain closed) had no handler: it reached the brain as an unhandled
  // rejection (ADE-BRAIN-1V/3H).
  it.each([
    ["throws", () => { throw new Error("stop failed"); }],
    ["returns a rejected promise", () => Promise.reject(new Error("stop failed"))],
  ])("keeps draining after a release %s, and reports it instead of raising it", async (_label, failingRelease) => {
    const calls: string[] = [];
    const onReleaseError = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const stack = createTeardownStack(onReleaseError);
      stack.push(() => calls.push("db.close"));
      stack.push(failingRelease as () => void);
      stack.push(() => calls.push("processRegistry.stop"));

      expect(() => stack.drain()).not.toThrow();
      await vi.waitFor(() => expect(onReleaseError).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(calls).toEqual(["processRegistry.stop", "db.close"]);
      expect((onReleaseError.mock.calls[0]?.[0] as Error).message).toBe("stop failed");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("lets the original startup failure reach the caller unchanged", () => {
    const closed = vi.fn();
    const stack = createTeardownStack();
    const bootFailure = new Error("project db is on a cloud placeholder");

    // The same shape `createAdeRuntime` uses: acquire, fail, drain in `finally`.
    const boot = () => {
      let runtimeCreated = false;
      try {
        stack.push(closed);
        stack.push(() => {
          throw new Error("a teardown step that must not mask the boot failure");
        });
        if (stack.size() === 2) throw bootFailure;
        runtimeCreated = true;
      } finally {
        if (!runtimeCreated) stack.drain();
      }
    };

    expect(boot).toThrow(bootFailure);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("reports a release failure even when the error reporter itself throws", () => {
    const calls: string[] = [];
    const stack = createTeardownStack(() => {
      throw new Error("logger is gone");
    });
    stack.push(() => calls.push("db.close"));
    stack.push(() => {
      throw new Error("stop failed");
    });

    expect(() => stack.drain()).not.toThrow();
    expect(calls).toEqual(["db.close"]);
  });

  it("empties itself, so a second drain repeats nothing", () => {
    const release = vi.fn();
    const stack = createTeardownStack();
    stack.push(release);
    expect(stack.size()).toBe(1);

    stack.drain();
    stack.drain();

    expect(release).toHaveBeenCalledTimes(1);
    expect(stack.size()).toBe(0);
  });

  it("releases a resource registered before it exists", () => {
    // `syncService` is assigned long after its release is registered; the
    // closure has to read the variable at drain time.
    let syncService: { dispose: () => void } | null = null;
    const dispose = vi.fn();
    const stack = createTeardownStack();
    stack.push(() => syncService?.dispose());

    syncService = { dispose };
    stack.drain();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
