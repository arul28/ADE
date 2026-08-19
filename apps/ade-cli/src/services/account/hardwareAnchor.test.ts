import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalWindowsPath } from "../projects/machineLayout";
import {
  canonicalAdeHomePath,
  HARDWARE_ANCHOR_DOMAIN,
  hardwareAnchorId,
  LINUX_MACHINE_ID_PATHS,
  normalizeHardwareAnchorUuid,
  parseIoregPlatformUuid,
  parseWindowsMachineGuid,
  probeHardwareAnchorUuid,
  readAccountHardwareId,
  readHardwareAnchorUuid,
  resetHardwareAnchorCacheForTests,
} from "./hardwareAnchor";

/**
 * The ADE home every install-agnostic assertion below anchors against, already
 * in canonical form so the expected digests are the same on Windows (where
 * canonicalisation lowercases) as on POSIX.
 */
const ADE_HOME = canonicalAdeHomePath("/home/ada/.ade");

/**
 * Captured from `ioreg -rd1 -c IOPlatformExpertDevice` on Apple silicon. Kept
 * verbatim — the surrounding keys and indentation are exactly what a parser
 * written against the format rather than the pair would trip over.
 */
const IOREG_OUTPUT = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000268, registered, matched, active, busy 0 (0 ms), retain 12>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "IOPlatformSerialNumber" = "H2XYZ1234567"
      "IOPlatformUUID" = "8F4E2C1A-9B3D-5E6F-A7B8-C9D0E1F2A3B4"
      "platform-name" = <"t6000">
      "target-type" = <"J316s">
    }
`;

/** Captured from `reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid`. */
const REG_OUTPUT = "\r\n"
  + "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n"
  + "    MachineGuid    REG_SZ    4a9e1f52-3f4b-4c1d-9a70-1f2e3d4c5b6a\r\n"
  + "\r\n";

const LINUX_MACHINE_ID = "b7d3f0a1c2e94d5f8a6b0c1d2e3f4a5b\n";

/**
 * The real `spawnSync`, counted rather than replaced.
 *
 * `readHardwareAnchorUuid` deliberately has no dependency seam — that is the
 * point of it — so the only way to prove its cache is to watch the syscall
 * underneath. `vi.spyOn` cannot patch a node builtin's namespace ("Cannot
 * redefine property"), so the module is mocked as a pass-through instead.
 */
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const mocked = { ...actual, spawnSync: vi.fn(actual.spawnSync) };
  return { ...mocked, default: mocked };
});

afterEach(() => {
  resetHardwareAnchorCacheForTests();
  vi.restoreAllMocks();
});

describe("hardware anchor parsers", () => {
  it("reads IOPlatformUUID out of real ioreg output", () => {
    expect(parseIoregPlatformUuid(IOREG_OUTPUT)).toBe("8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4");
  });

  it("reads MachineGuid out of real reg query output", () => {
    expect(parseWindowsMachineGuid(REG_OUTPUT)).toBe("4a9e1f52-3f4b-4c1d-9a70-1f2e3d4c5b6a");
  });

  it("matches the value line by name and type, not by position", () => {
    // A `/s`-style answer with siblings, and a decoy line naming the value in
    // prose. Taking "the last token of the third line" would pick either.
    const noisy = "\r\n"
      + "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n"
      + "    MachineGuidBackup    REG_SZ    00000000-0000-0000-0000-000000000000\r\n"
      + "    MachineGuid    REG_SZ    4a9e1f52-3f4b-4c1d-9a70-1f2e3d4c5b6a\r\n";
    expect(parseWindowsMachineGuid(noisy)).toBe("4a9e1f52-3f4b-4c1d-9a70-1f2e3d4c5b6a");
  });

  it.each([
    ["absent property", '"IOPlatformSerialNumber" = "H2XYZ1234567"'],
    ["empty property", '"IOPlatformUUID" = ""'],
    ["all-zero sentinel", '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"'],
  ])("returns null for %s", (_label, output) => {
    expect(parseIoregPlatformUuid(output)).toBeNull();
  });

  it.each([
    ["a value the query did not return", "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n"],
    ["an error page", "ERROR: The system was unable to find the specified registry key or value.\r\n"],
  ])("returns null for %s", (_label, output) => {
    expect(parseWindowsMachineGuid(output)).toBeNull();
  });

  it("accepts a bare-hex machine-id and a brace-wrapped guid, rejects junk", () => {
    expect(normalizeHardwareAnchorUuid(LINUX_MACHINE_ID)).toBe("b7d3f0a1c2e94d5f8a6b0c1d2e3f4a5b");
    expect(normalizeHardwareAnchorUuid("{4A9E1F52-3F4B-4C1D-9A70-1F2E3D4C5B6A}"))
      .toBe("4a9e1f52-3f4b-4c1d-9a70-1f2e3d4c5b6a");
    expect(normalizeHardwareAnchorUuid("uninitialized")).toBeNull();
    expect(normalizeHardwareAnchorUuid("00000000000000000000000000000000")).toBeNull();
    expect(normalizeHardwareAnchorUuid("deadbeef")).toBeNull();
    expect(normalizeHardwareAnchorUuid(null)).toBeNull();
  });
});

describe("hardware anchor lookup", () => {
  it("runs ioreg without a shell on macOS", () => {
    const runCommand = vi.fn(() => IOREG_OUTPUT);
    expect(probeHardwareAnchorUuid({ platform: "darwin", runCommand }))
      .toBe("8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4");
    expect(runCommand).toHaveBeenCalledWith("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  });

  it("queries the Cryptography key on Windows", () => {
    const runCommand = vi.fn(() => REG_OUTPUT);
    expect(probeHardwareAnchorUuid({ platform: "win32", runCommand }))
      .toBe("4a9e1f52-3f4b-4c1d-9a70-1f2e3d4c5b6a");
    const [command, args] = runCommand.mock.calls[0] as unknown as [string, string[]];
    // Resolved through the trusted-tool path, never a bare "reg" off PATH.
    expect(command.toLowerCase()).toContain("reg.exe");
    expect(args).toEqual([
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
  });

  it("falls back to the dbus machine-id on Linux", () => {
    const readFile = vi.fn((filePath: string) =>
      filePath === LINUX_MACHINE_ID_PATHS[1] ? LINUX_MACHINE_ID : null);
    expect(probeHardwareAnchorUuid({ platform: "linux", readFile }))
      .toBe("b7d3f0a1c2e94d5f8a6b0c1d2e3f4a5b");
    expect(readFile).toHaveBeenCalledWith(LINUX_MACHINE_ID_PATHS[0]);
  });

  it("returns null when the probe fails instead of throwing", () => {
    // A sandbox that refuses to spawn, a VM with no platform UUID, a hardened
    // image with no machine-id: all of them are "no anchor", never an error.
    expect(probeHardwareAnchorUuid({ platform: "darwin", runCommand: () => null })).toBeNull();
    expect(probeHardwareAnchorUuid({
      platform: "darwin",
      runCommand: () => {
        throw new Error("EPERM");
      },
    })).toBeNull();
    expect(probeHardwareAnchorUuid({ platform: "linux", readFile: () => null })).toBeNull();
  });
});

describe("account hardware id", () => {
  /** The raw identifier a macOS probe would return, without touching the cache. */
  const macUuid = (): string | null =>
    probeHardwareAnchorUuid({ platform: "darwin", runCommand: () => IOREG_OUTPUT });

  it("hashes with the versioned domain, the account salt, and the install path", () => {
    const expected = createHash("sha256")
      .update(
        `${HARDWARE_ANCHOR_DOMAIN}:user_1:8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4:${ADE_HOME}`,
      )
      .digest("hex");

    expect(hardwareAnchorId("user_1", "8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4", ADE_HOME))
      .toBe(expected);
    expect(readAccountHardwareId("user_1", ADE_HOME, macUuid)).toBe(expected);
  });

  it("never puts the raw identifier on the wire", () => {
    const id = readAccountHardwareId("user_1", ADE_HOME, macUuid);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain("8f4e2c1a");
  });

  it("gives two accounts on one machine unrelated values", () => {
    // The point of the per-account salt: the directory can dedup within an
    // account and cannot join across accounts.
    expect(readAccountHardwareId("user_1", ADE_HOME, macUuid))
      .not.toBe(readAccountHardwareId("user_2", ADE_HOME, macUuid));
  });

  it("separates two ADE installs that share one platform UUID", () => {
    // Stable and Beta on one Mac, and a second OS user's `~/.ade`: the probe
    // underneath returns the SAME identifier for all three, which is exactly
    // why the hash cannot be built from it alone — they were superseding each
    // other's directory row.
    const stable = readAccountHardwareId("user_1", "/home/ada/.ade", macUuid);
    const beta = readAccountHardwareId("user_1", "/home/ada/.ade-beta", macUuid);
    const otherUser = readAccountHardwareId("user_1", "/home/bo/.ade", macUuid);
    expect(new Set([stable, beta, otherUser]).size).toBe(3);
  });

  it("reproduces one install's anchor across a wipe and reinstall", () => {
    // The north star: `~/.ade` is deleted and recreated, every secret in it is
    // minted afresh, and the anchor still names the same machine.
    expect(readAccountHardwareId("user_1", "/home/ada/.ade/", macUuid))
      .toBe(readAccountHardwareId("user_1", "/home/ada/./.ade", macUuid));
  });

  it("treats a Windows home path case-insensitively and a POSIX one exactly", () => {
    // NTFS is case-insensitive, so one directory must not hash as two installs.
    expect(canonicalAdeHomePath("C:\\Users\\Ada\\.ade", "win32"))
      .toBe(canonicalAdeHomePath("c:\\users\\ada\\.ade", "win32"));
    expect(canonicalAdeHomePath("/home/Ada/.ade", "linux"))
      .not.toBe(canonicalAdeHomePath("/home/ada/.ade", "linux"));
  });

  it("folds a Windows home path the same way the runtime pipe identity does", () => {
    // Routed through `canonicalWindowsPath`, not a bare `path.resolve`: that is
    // what makes `realpath` — and so 8.3 short names and junction casing —
    // collapse to one spelling. Forward slashes are the part of that fold this
    // test can prove off Windows; `path.resolve` on a POSIX host would not even
    // recognise the drive letter and would join both spellings onto its cwd.
    expect(canonicalAdeHomePath("C:/Users/Ada/.ade", "win32"))
      .toBe(canonicalAdeHomePath("C:\\Users\\Ada\\.ade", "win32"));
    expect(canonicalAdeHomePath("C:\\Users\\Ada\\.ade", "win32"))
      .toBe(canonicalWindowsPath("C:\\Users\\Ada\\.ade").toLowerCase());
  });

  it("returns null with no account id and with no anchor", () => {
    expect(readAccountHardwareId(null, ADE_HOME, macUuid)).toBeNull();
    expect(readAccountHardwareId("   ", ADE_HOME, macUuid)).toBeNull();
    expect(readAccountHardwareId("user_1", ADE_HOME, () => null)).toBeNull();
  });
});

describe("hardware anchor cache", () => {
  it("probes once and answers every later read without touching the host", () => {
    // The cache is unconditional now: it used to switch itself off whenever the
    // caller passed any argument at all, which made "is this cached?" depend on
    // how the call happened to be spelled.
    //
    // Counted at the real seams rather than compared as return values. There is
    // no dependency seam on `readHardwareAnchorUuid`, so two equal answers prove
    // nothing — an implementation that re-probed on every call would produce
    // them, and on a host with no anchor at all both would simply be null.
    resetHardwareAnchorCacheForTests();
    const spawnSpy = vi.mocked(childProcess.spawnSync);
    spawnSpy.mockClear();
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    const probeCalls = (): number => spawnSpy.mock.calls.length + readFileSpy.mock.calls.length;

    const first = readHardwareAnchorUuid();
    // Whichever probe this host uses — `ioreg` / `reg` through spawnSync, or
    // `/etc/machine-id` through fs — the first read really did reach it. Without
    // this the count assertion below would hold for a spy that intercepted
    // nothing, which is the vacuous-assertion trap itself.
    const afterFirstProbe = probeCalls();
    expect(afterFirstProbe).toBeGreaterThan(0);

    expect(readHardwareAnchorUuid()).toBe(first);
    expect(readHardwareAnchorUuid()).toBe(first);
    // Including a null first answer: a machine with no anchor must not respawn
    // `ioreg` twice a minute forever to keep learning the same thing.
    expect(probeCalls()).toBe(afterFirstProbe);
  });

  it("leaves the explicit probe uncached", () => {
    const runCommand = vi.fn(() => IOREG_OUTPUT);
    probeHardwareAnchorUuid({ platform: "darwin", runCommand });
    probeHardwareAnchorUuid({ platform: "darwin", runCommand });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("memoizes the canonical home and clears that memo on reset too", () => {
    // The Windows fold is the half with real work behind it: a `realpath` walk
    // that can BLOCK on a stalled network home, on the 30-second publish path.
    const nativeSpy = vi.spyOn(fs.realpathSync, "native");
    const home = "C:\\Users\\Ada\\.ade-memo-probe";

    const canonical = canonicalAdeHomePath(home, "win32");
    const afterFirst = nativeSpy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(canonicalAdeHomePath(home, "win32")).toBe(canonical);
    expect(nativeSpy.mock.calls.length).toBe(afterFirst);

    // The reset seam owns BOTH process-lifetime caches. Clearing only the anchor
    // uuid would leave a test reading a canonicalisation computed under the
    // previous test's cwd or platform stub.
    resetHardwareAnchorCacheForTests();
    expect(canonicalAdeHomePath(home, "win32")).toBe(canonical);
    expect(nativeSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
