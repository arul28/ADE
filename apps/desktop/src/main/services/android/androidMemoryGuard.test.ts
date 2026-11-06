import { describe, expect, it } from "vitest";
import type { AndroidAvd } from "../../../shared/types/androidEmulator";
import { expectedErrorKind } from "../../../shared/expectedError";
import { readHostMemorySignals, type HostMemorySignals } from "../machineStats/hostMemorySignals";
import {
  androidEmulatorStartCost,
  decideAndroidMemoryStart,
  reserveAndroidBootMemory,
  reserveAndroidMemoryForStart,
  type AndroidMemoryFacts,
} from "./androidMemoryGuard";

const GB = 1024 * 1024 * 1024;

/** A 36 GB machine with nothing running and nothing wrong: the base every row below changes one thing in. */
const calm: AndroidMemoryFacts = {
  totalMb: 36_864,
  availableMb: 20_000,
  pressure: "normal",
  pagingOutMbPerSec: 0,
  emulatorsMb: 0,
  emulatorCount: 0,
  earlierBootsMb: 0,
  earlierBootCount: 0,
  costMb: 5_632,
};

describe("androidMemoryGuard", () => {
  it("counts the boots already in flight, so two starts at once cannot both fit the same free memory", () => {
    const needMb = androidEmulatorStartCost({ guestRamMb: 4_096 }).costMb;
    // A big machine, so only the free memory decides.
    const facts = { ...calm, totalMb: 131_072, availableMb: needMb * 2 };
    const first = reserveAndroidBootMemory(needMb);
    const second = reserveAndroidBootMemory(needMb);
    try {
      // Alone, either start fits; together they do not.
      expect(decideAndroidMemoryStart({ ...facts, costMb: needMb, earlierBootsMb: first.earlierMb() }).refusal).toBeNull();
      expect(decideAndroidMemoryStart({ ...facts, costMb: needMb, earlierBootsMb: second.earlierMb(), earlierBootCount: 1 }).refusal)
        .toBe("available");
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

  // The 2026-11-06 freeze: five emulators, swap nearly full, and the old
  // free-memory gauge still read 41%. Any one of these signals refuses.
  it.each<[string, Partial<AndroidMemoryFacts>, ReturnType<typeof decideAndroidMemoryStart>["refusal"]]>([
    ["a calm machine", {}, null],
    ["the OS's pressure at warn, though 41% reads free", { pressure: "warn", availableMb: 15_000 }, "pressure"],
    ["the OS's pressure critical", { pressure: "critical" }, "pressure"],
    ["active swap-out paging", { pagingOutMbPerSec: 12.5 }, "paging"],
    ["a trickle of paging below the limit", { pagingOutMbPerSec: 1.2 }, null],
    ["running emulators plus this one past half of RAM", { emulatorsMb: 14_300, emulatorCount: 2 }, "budget"],
    ["another brain's boot in flight counted toward the budget", { emulatorsMb: 8_400, emulatorCount: 1, earlierBootsMb: 5_632, earlierBootCount: 1 }, "budget"],
    ["the first emulator on a small machine is judged by the other rules only", { totalMb: 8_192, availableMb: 7_000 }, null],
    ["too little left after the start", { availableMb: 6_000 }, "available"],
    ["no signal readable at all", { availableMb: null, pressure: null, pagingOutMbPerSec: null }, null],
  ])("decides %s", (_label, change, refusal) => {
    expect(decideAndroidMemoryStart({ ...calm, ...change }).refusal).toBe(refusal);
  });

  it("refuses with an expected, plain-language ANDROID_LOW_MEMORY that names the numbers, and gives its reservation back", async () => {
    const avd = { name: "ade_lane_pixel", displayName: "Pixel 9", ramMb: 2_048 } as AndroidAvd;
    const signals: HostMemorySignals = {
      platform: "darwin",
      totalMb: 36_864,
      availableMb: 15_000,
      pressure: "normal",
      swapTotalMb: 16_384,
      swapUsedMb: 15_200,
      commitUsedMb: null,
      commitLimitMb: null,
      psiSomeAvg10: null,
      pagingOutMbPerSec: 0,
    };
    const start = () => reserveAndroidMemoryForStart({
      laneId: "lane-1",
      avd,
      force: false,
      platform: "darwin",
      logger: null,
      readers: {
        signals: async () => signals,
        // Two emulators the user started outside ADE count like any other.
        emulators: async () => [{ pid: 101, name: "qemu-system-aarch64-headless", mb: 8_357 }, { pid: 102, name: "qemu-system-aarch64", mb: 5_941 }],
      },
    });
    const refused = await start().catch((error: unknown) => error as Error & { code?: string });
    expect(refused).toBeInstanceOf(Error);
    expect((refused as { code?: string }).code).toBe("ANDROID_LOW_MEMORY");
    expect(expectedErrorKind(refused)).toBe("environment");
    const sentence = (refused as Error).message.replace(/^ANDROID_LOW_MEMORY: /u, "");
    expect(sentence.length).toBeLessThanOrEqual(140);
    expect(sentence).toContain("14.0 GB");
    expect(sentence).toContain("Stop an emulator first.");
    // The refused start holds nothing: the next one does not count it.
    const next = reserveAndroidBootMemory(1);
    expect(next.earlierMb()).toBe(0);
    next.release();
    // Start anyway still boots, and holds its memory for the next start.
    const forced = await reserveAndroidMemoryForStart({ laneId: "lane-1", avd, force: true, platform: "darwin", logger: null });
    const after = reserveAndroidBootMemory(1);
    expect(after.earlierMb()).toBe(forced.cost.costMb);
    after.release();
    forced.release();
  });

  it.each([
    {
      platform: "darwin" as const,
      run: (command: string, round: number) => command.endsWith("sysctl")
        ? "kern.memorystatus_level: 41\nkern.memorystatus_vm_pressure_level: 2\nvm.swapusage: total = 16384.00M  used = 15257.50M  free = 1126.50M  (encrypted)\n"
        : `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapouts:                                   ${12_000 + round * 640}.\n`,
      files: {},
      expected: { availableMb: Math.round(36_864 * 0.41), pressure: "warn", swapUsedMb: 15_258, pagingOutMbPerSec: 5 },
    },
    {
      platform: "linux" as const,
      run: () => null,
      files: {
        "/proc/meminfo": "MemTotal:       16384000 kB\nMemAvailable:    3072000 kB\nSwapTotal:       8192000 kB\nSwapFree:        1024000 kB\n",
        "/proc/pressure/memory": "some avg10=14.20 avg60=6.00 avg300=1.00 total=1\nfull avg10=2.00 avg60=1.00 avg300=0.00 total=1\n",
        "/proc/vmstat:0": "pgpgin 1\npswpout 1000\n",
        "/proc/vmstat:1": "pgpgin 1\npswpout 3560\n",
      },
      expected: { availableMb: 3_000, pressure: "warn", swapUsedMb: 7_000, pagingOutMbPerSec: 5 },
    },
    {
      platform: "win32" as const,
      run: () => JSON.stringify({
        totalKb: 16 * 1024 * 1024,
        freeKb: 3 * 1024 * 1024,
        commitLimitKb: 24 * 1024 * 1024,
        commitFreeKb: 1024 * 1024,
        pagingTotalKb: 8 * 1024 * 1024,
        pagingFreeKb: 2 * 1024 * 1024,
        pagesOut0: 100,
        pagesOut1: 100 + 2_560,
      }),
      files: {},
      // 23 of 24 GB committed: past 90% of the commit limit.
      expected: { availableMb: 3_072, pressure: "warn", swapUsedMb: 6_144, pagingOutMbPerSec: 5 },
    },
  ])("reads $platform's pressure, swap and paging as the OS reports them", async ({ platform, run, files: fileTexts, expected }) => {
    const files: Record<string, string | undefined> = fileTexts;
    let rounds = 0;
    let vmstatReads = 0;
    const signals = await readHostMemorySignals({
      platform,
      pagingSampleMs: 2_000,
      deps: {
        totalBytes: 36 * GB,
        run: async (command) => (command.endsWith("vm_stat") ? run(command, rounds++) : run(command, 0)),
        readFile: async (filePath) => (filePath === "/proc/vmstat" ? files[`/proc/vmstat:${vmstatReads++}`] : files[filePath]) ?? null,
        wait: async () => undefined,
      },
    });
    expect({
      availableMb: signals.availableMb,
      pressure: signals.pressure,
      swapUsedMb: signals.swapUsedMb,
      pagingOutMbPerSec: signals.pagingOutMbPerSec,
    }).toEqual(expected);
  });
});
