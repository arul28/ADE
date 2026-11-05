import { describe, expect, it } from "vitest";
import {
  androidEmulatorMemoryNeedMb,
  androidMemoryShortfall,
  readHostAvailableMemoryMb,
  reserveAndroidBootMemory,
} from "./androidMemoryGuard";

const GB = 1024 * 1024 * 1024;

describe("androidMemoryGuard", () => {
  it("counts the boots already in flight, so two starts at once cannot both fit the same free memory", () => {
    const freeMb = 9_000;
    const needMb = androidEmulatorMemoryNeedMb(4_096);
    const first = reserveAndroidBootMemory(needMb);
    const second = reserveAndroidBootMemory(needMb);
    try {
      // Alone, either start fits; together they do not.
      expect(androidMemoryShortfall({ needMb, availableMb: freeMb - first.earlierMb() })).toBeNull();
      expect(androidMemoryShortfall({ needMb, availableMb: freeMb - second.earlierMb() })).toEqual({
        needMb,
        availableMb: freeMb - needMb,
      });
      // The first boot ended (booted, failed or refused): the next start no longer counts it.
      first.release();
      first.release();
      expect(second.earlierMb()).toBe(0);
      const third = reserveAndroidBootMemory(needMb);
      expect(third.earlierMb()).toBe(needMb);
      third.release();
    } finally {
      first.release();
      second.release();
    }
  });

  it.each([
    { platform: "darwin" as const, level: 40, expected: Math.round((16 * GB * 0.4) / (1024 * 1024)) },
    // macOS without its gauge: unknown, so the caller skips the guard rather than refuse a start that fits.
    { platform: "darwin" as const, level: null, expected: null },
    { platform: "win32" as const, level: null, expected: 3 * 1024 },
    { platform: "linux" as const, level: null, expected: 3 * 1024 },
  ])("reads the memory $platform can give without swapping (level $level)", async ({ platform, level, expected }) => {
    await expect(readHostAvailableMemoryMb({
      platform,
      totalBytes: 16 * GB,
      freeBytes: 3 * GB,
      readLevel: async () => level,
    })).resolves.toBe(expected);
  });
});
