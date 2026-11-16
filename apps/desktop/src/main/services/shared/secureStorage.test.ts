import type { SafeStorage } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A synchronous safeStorage call can wait on a Keychain prompt and hold the
// main process. Until the asynchronous check answers, and after it says no,
// nothing may make one.
describe("secure storage check", () => {
  let gate: typeof import("./secureStorage");

  beforeEach(async () => {
    vi.resetModules();
    gate = await import("./secureStorage");
  });

  const fakeStorage = () => {
    let answer!: (available: boolean) => void;
    let fail!: (error: Error) => void;
    const storage = {
      syncCalls: 0,
      isAsyncEncryptionAvailable: () => new Promise<boolean>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
      isEncryptionAvailable() {
        storage.syncCalls += 1;
        return true;
      },
      getSelectedStorageBackend: () => "gnome_libsecret" as const,
    };
    return {
      storage,
      safeStorage: storage as unknown as SafeStorage,
      answer: (available: boolean) => answer(available),
      fail: (error: Error) => fail(error),
    };
  };

  it.each([
    ["allows", true, true, 1],
    ["refuses", false, false, 0],
  ])("makes no synchronous call while pending, then follows what the OS %s", async (_label, answer, expected, syncCalls) => {
    const fake = fakeStorage();
    const answered = vi.fn();
    gate.onSecureStorageAnswered(answered);
    gate.startSecureStorageCheck(fake.safeStorage);

    expect(gate.isSecureStorageCheckPending()).toBe(true);
    expect(gate.isSecureStorageAvailable(fake.safeStorage)).toBe(false);
    expect(fake.storage.syncCalls).toBe(0);

    fake.answer(answer);
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
    expect(gate.isSecureStorageCheckPending()).toBe(false);
    expect(gate.isSecureStorageAvailable(fake.safeStorage)).toBe(expected);
    // A "no" is kept: the main thread never asks again.
    expect(fake.storage.syncCalls).toBe(syncCalls);
  });

  it("lets the synchronous call decide when the asynchronous check fails", async () => {
    const fake = fakeStorage();
    const answered = vi.fn();
    gate.onSecureStorageAnswered(answered);
    gate.startSecureStorageCheck(fake.safeStorage);
    fake.fail(new Error("no async encryptor"));
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
    expect(gate.isSecureStorageAvailable(fake.safeStorage)).toBe(true);
    expect(fake.storage.syncCalls).toBe(1);
  });
});
