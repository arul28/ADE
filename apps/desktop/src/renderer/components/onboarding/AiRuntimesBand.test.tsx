import { describe, expect, it } from "vitest";
import { cursorInstallCommand } from "./AiRuntimesBand";

describe("cursorInstallCommand", () => {
  it("uses Cursor's PowerShell installer on Windows", () => {
    const command = cursorInstallCommand("win32");
    expect(command).toContain("powershell.exe");
    expect(command).toContain("cursor.com/install?win32=true");
    expect(command).not.toContain("curl");
    expect(command).not.toContain("mkdir -p");
    expect(command).not.toContain("$HOME");
  });

  it("keeps the documented POSIX one-liner elsewhere", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const command = cursorInstallCommand(platform);
      expect(command).toContain("curl https://cursor.com/install -fsS | bash");
      expect(command).not.toContain("powershell");
    }
  });
});
