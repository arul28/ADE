/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubAppUserAuthStatus } from "../../shared/types";
import {
  refreshGithubAppUserAuth,
  resetGithubAppUserAuthForTests,
  useGithubAppUserAuth,
} from "./useGithubAppUserAuth";
import { makeAppAuth } from "./githubIntegrationStatus.testFixtures";

type Deferred = {
  promise: Promise<GitHubAppUserAuthStatus>;
  resolve: (status: GitHubAppUserAuthStatus) => void;
};

function deferred(): Deferred {
  let resolve!: (status: GitHubAppUserAuthStatus) => void;
  const promise = new Promise<GitHubAppUserAuthStatus>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Answers each successive read with the next deferred in the list. */
function setReads(reads: Deferred[]): void {
  let index = 0;
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      github: {
        getAppUserAuthStatus: vi.fn(() => {
          const read = reads[index];
          index += 1;
          return read.promise;
        }),
      },
    },
  });
}

afterEach(() => {
  cleanup();
  resetGithubAppUserAuthForTests();
});

/**
 * `force` exists so a caller that just performed an action reads the state from
 * AFTER it. The forced read runs BESIDE the older one it replaces, and settle
 * order is not guaranteed — so the older read could publish the pre-action
 * status last and win, which is exactly the staleness `force` removes.
 */
describe("refreshGithubAppUserAuth publication order", () => {
  it("keeps the forced read's answer when the older read settles after it", async () => {
    const older = deferred();
    const forced = deferred();
    setReads([older, forced]);

    // The hook's own mount read is the first one; the forced read is the second.
    const { result } = renderHook(() => useGithubAppUserAuth());
    let forcedRead: Promise<unknown> | null = null;
    await act(async () => {
      forcedRead = refreshGithubAppUserAuth({ force: true });
      forced.resolve(makeAppAuth({ userLogin: "after-the-action" }));
      await forcedRead;
    });

    expect(result.current.appAuth?.userLogin).toBe("after-the-action");

    await act(async () => {
      older.resolve(makeAppAuth({ userLogin: "before-the-action" }));
      await older.promise;
    });

    expect(result.current.appAuth?.userLogin).toBe("after-the-action");
  });

  it("lets a read started later replace an earlier answer", async () => {
    const first = deferred();
    const second = deferred();
    setReads([first, second]);

    const { result } = renderHook(() => useGithubAppUserAuth());
    await act(async () => {
      first.resolve(makeAppAuth({ userLogin: "first" }));
      await first.promise;
    });
    expect(result.current.appAuth?.userLogin).toBe("first");

    await act(async () => {
      const later = refreshGithubAppUserAuth({ force: true });
      second.resolve(makeAppAuth({ userLogin: "second" }));
      await later;
    });
    expect(result.current.appAuth?.userLogin).toBe("second");
  });

  it("keeps a status an action published over a read that started before it", async () => {
    const inFlight = deferred();
    setReads([inFlight]);

    const { result } = renderHook(() => useGithubAppUserAuth());
    act(() => {
      result.current.set(makeAppAuth({ userLogin: "returned-by-the-action" }));
    });

    await act(async () => {
      inFlight.resolve(makeAppAuth({ userLogin: "read-from-before" }));
      await inFlight.promise;
    });

    expect(result.current.appAuth?.userLogin).toBe("returned-by-the-action");
  });
});
