import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HARDWARE_ANCHOR_DOMAIN,
  hardwareAnchorId,
  LINUX_MACHINE_ID_PATHS,
  normalizeHardwareAnchorUuid,
  parseIoregPlatformUuid,
  parseWindowsMachineGuid,
  readAccountHardwareId,
  readHardwareAnchorUuid,
  resetHardwareAnchorCacheForTests,
} from "./hardwareAnchor";

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
    expect(readHardwareAnchorUuid({ platform: "darwin", runCommand }))
      .toBe("8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4");
    expect(runCommand).toHaveBeenCalledWith("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  });

  it("queries the Cryptography key on Windows", () => {
    const runCommand = vi.fn(() => REG_OUTPUT);
    expect(readHardwareAnchorUuid({ platform: "win32", runCommand }))
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
    expect(readHardwareAnchorUuid({ platform: "linux", readFile }))
      .toBe("b7d3f0a1c2e94d5f8a6b0c1d2e3f4a5b");
    expect(readFile).toHaveBeenCalledWith(LINUX_MACHINE_ID_PATHS[0]);
  });

  it("returns null when the probe fails instead of throwing", () => {
    // A sandbox that refuses to spawn, a VM with no platform UUID, a hardened
    // image with no machine-id: all of them are "no anchor", never an error.
    expect(readHardwareAnchorUuid({ platform: "darwin", runCommand: () => null })).toBeNull();
    expect(readHardwareAnchorUuid({
      platform: "darwin",
      runCommand: () => {
        throw new Error("EPERM");
      },
    })).toBeNull();
    expect(readHardwareAnchorUuid({ platform: "linux", readFile: () => null })).toBeNull();
  });
});

describe("account hardware id", () => {
  it("hashes with the versioned domain and the account salt", () => {
    const expected = createHash("sha256")
      .update(`${HARDWARE_ANCHOR_DOMAIN}:user_1:8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4`)
      .digest("hex");

    expect(hardwareAnchorId("user_1", "8f4e2c1a-9b3d-5e6f-a7b8-c9d0e1f2a3b4")).toBe(expected);
    expect(readAccountHardwareId("user_1", {
      platform: "darwin",
      runCommand: () => IOREG_OUTPUT,
    })).toBe(expected);
  });

  it("never puts the raw identifier on the wire", () => {
    const id = readAccountHardwareId("user_1", {
      platform: "darwin",
      runCommand: () => IOREG_OUTPUT,
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain("8f4e2c1a");
  });

  it("gives two accounts on one machine unrelated values", () => {
    const deps = { platform: "darwin" as const, runCommand: () => IOREG_OUTPUT };
    // The point of the per-account salt: the directory can dedup within an
    // account and cannot join across accounts.
    expect(readAccountHardwareId("user_1", deps)).not.toBe(readAccountHardwareId("user_2", deps));
  });

  it("returns null with no account id and with no anchor", () => {
    expect(readAccountHardwareId(null, { platform: "darwin", runCommand: () => IOREG_OUTPUT })).toBeNull();
    expect(readAccountHardwareId("   ", { platform: "darwin", runCommand: () => IOREG_OUTPUT })).toBeNull();
    expect(readAccountHardwareId("user_1", { platform: "linux", readFile: () => null })).toBeNull();
  });
});
