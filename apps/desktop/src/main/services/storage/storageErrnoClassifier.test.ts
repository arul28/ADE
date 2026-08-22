import { describe, expect, it } from "vitest";
import { classifyStorageFault } from "./storageErrnoClassifier";

function fsError(
  message: string,
  extra: Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), extra);
}

describe("classifyStorageFault", () => {
  it("classifies the errnos that mean the bytes are unreadable", () => {
    for (const code of ["EDEADLK", "EIO", "ENXIO", "ENODEV", "ESTALE", "EHOSTDOWN", "EREMOTEIO"]) {
      const fault = classifyStorageFault(fsError("read failed", { code, syscall: "read" }));
      expect(fault?.code, code).toBe("storage_read_failed");
      expect(fault?.errno, code).toBe(code);
    }
  });

  it("classifies an errno the platform could not name, on the code or the message", () => {
    // The production shape: macOS EDEADLK reaching libuv unmapped.
    expect(classifyStorageFault(
      fsError("Unknown system error -11: Unknown system error -11, read", {
        code: "Unknown system error -11",
        errno: -11,
      }),
    )?.code).toBe("storage_read_failed");

    expect(classifyStorageFault(new Error("Unknown system error -11, read"))?.code)
      .toBe("storage_read_failed");
  });

  it("leaves ordinary failures alone", () => {
    expect(classifyStorageFault(fsError("missing", { code: "ENOENT" }))).toBeNull();
    expect(classifyStorageFault(fsError("denied", { code: "EACCES" }))).toBeNull();
    expect(classifyStorageFault(fsError("port busy", { code: "EADDRINUSE" }))).toBeNull();
    expect(classifyStorageFault(new Error("port busy"))).toBeNull();
    expect(classifyStorageFault("port busy")).toBeNull();
    expect(classifyStorageFault(null)).toBeNull();
  });

  it("treats a Windows unmapped errno as a fault only inside a cloud folder", () => {
    // OneDrive on-demand files fail with ERROR_CLOUD_FILE_* statuses that libuv
    // maps to nothing, so Node reports the catch-all UNKNOWN code.
    const onedrive = String.raw`C:\Users\Ada\OneDrive - Contoso\ADE\.ade\ade.db`;
    const fault = classifyStorageFault(
      fsError("UNKNOWN: unknown error, read", { code: "UNKNOWN", errno: -4094, path: onedrive }),
    );
    expect(fault?.code).toBe("storage_read_failed");
    expect(fault?.provider).toBe("onedrive");
    expect(fault?.message).toContain("OneDrive");

    // The same code on a local path stays unclassified: UNKNOWN is what every
    // unmapped Win32 error becomes, so it proves nothing on its own.
    expect(classifyStorageFault(
      fsError("UNKNOWN: unknown error, read", {
        code: "UNKNOWN",
        errno: -4094,
        path: String.raw`C:\Users\Ada\ADE\.ade\ade.db`,
      }),
    )).toBeNull();
  });

  it("names the file and the provider in the sentence it hands back", () => {
    const path = "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/ADE/.ade/ade.db";
    const fault = classifyStorageFault(fsError("Unknown system error -11, read", { path }));
    expect(fault?.path).toBe(path);
    expect(fault?.provider).toBe("icloud");
    expect(fault?.message).toContain(path);
    expect(fault?.message).toContain("iCloud Drive");
    expect(fault?.message).not.toContain("Unknown system error");
  });

  it("takes the caller's path when the error carries none", () => {
    const fault = classifyStorageFault(
      fsError("disk I/O error", { code: "EIO" }),
      { path: "/Users/ada/Dropbox/ADE/.ade/ade.db" },
    );
    expect(fault?.provider).toBe("dropbox");
    expect(fault?.message).toContain("Dropbox");
  });

  it("needs the filesystem to corroborate a bare errno", () => {
    // EHOSTDOWN and ESTALE are ordinary socket verdicts too. Without a syscall,
    // a path, or a caller-supplied path, nothing here says a FILE was involved,
    // and calling it a storage fault would put the machine on the slow retry
    // cadence with a sentence about its disk.
    expect(classifyStorageFault(fsError("host is down", { code: "EHOSTDOWN" }))).toBeNull();
    expect(classifyStorageFault(fsError("stale handle", { code: "ESTALE" }))).toBeNull();

    // Any one of the three is enough.
    expect(classifyStorageFault(fsError("input/output error", { code: "EIO", syscall: "read" }))?.code)
      .toBe("storage_read_failed");
    expect(classifyStorageFault(fsError("host is down", { code: "EHOSTDOWN", path: "/Volumes/nas/ade.db" }))?.code)
      .toBe("storage_read_failed");
    expect(classifyStorageFault(fsError("input/output error", { code: "EIO" }), { path: "/data/ade.db" })?.code)
      .toBe("storage_read_failed");

    // The incident's own error still classifies: an errno the platform could
    // not name is a raw filesystem failure whatever else it carries.
    expect(classifyStorageFault(fsError("Unknown system error -11: Unknown system error -11, read", {
      code: "Unknown system error -11",
      errno: -11,
      syscall: "read",
      path: "/Users/ada/ADE/.ade/ade.db",
    }))?.code).toBe("storage_read_failed");
  });

  it("still says something useful when nothing named a file", () => {
    const fault = classifyStorageFault(fsError("disk I/O error", { code: "EIO", syscall: "read" }));
    expect(fault?.path).toBeNull();
    expect(fault?.message).toContain("ADE couldn't read this computer's data.");
  });
});
