import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";

/** The registry's non-default Claude and Codex account homes; none when it cannot be read. */
function registeredAccountHomes(): Array<{ provider: "claude" | "codex"; configHome: string }> {
  const homes: Array<{ provider: "claude" | "codex"; configHome: string }> = [];
  for (const provider of ["claude", "codex"] as const) {
    try {
      for (const instance of getMachineProviderInstanceStore().list(provider)) {
        if (!instance.isDefault && instance.configHome.trim()) homes.push({ provider, configHome: instance.configHome });
      }
    } catch {
      // An unreadable registry still leaves the provider-homes folders to scan.
    }
  }
  return homes;
}

/**
 * Every config home on this machine that holds Claude or Codex history besides
 * the provider's default: each account home in the instance registry, and
 * every directory ADE owns under `<adeHome>/provider-homes/` (accounts,
 * presets, credentials, routes), including ones whose registry entry is gone,
 * because the usage they recorded still happened.
 *
 * A home's provider comes from its namespace (`provider-homes/claude/…`) or
 * registry entry; a preset, credential or route home is identified by the
 * CLI's own files (`.claude.json`; Codex's `config.toml` / `auth.json`).
 * Claude keeps a `sessions/` folder too, so the folder alone would hand every
 * Claude home to the Codex scan.
 */
export function adeProviderUsageHomes(adeDir: string = resolveMachineAdeDir()): { claude: string[]; codex: string[] } {
  const childDirs = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  };
  const exists = (home: string, child: string) => fs.existsSync(path.join(home, child));
  const claude = new Set<string>();
  const codex = new Set<string>();
  const root = path.join(adeDir, "provider-homes");
  for (const namespaceDir of childDirs(root)) {
    const namespace = path.basename(namespaceDir).toLowerCase();
    for (const home of childDirs(namespaceDir)) {
      const isClaude = namespace === "claude" || (namespace !== "codex" && exists(home, ".claude.json"));
      const isCodex = !isClaude && (namespace === "codex" || exists(home, "config.toml") || exists(home, "auth.json"));
      if (isClaude) claude.add(home);
      if (isCodex) codex.add(home);
    }
  }
  for (const instance of registeredAccountHomes()) {
    if (instance.provider === "claude") claude.add(instance.configHome);
    else codex.add(instance.configHome);
  }
  return {
    claude: [...claude].filter((home) => exists(home, "projects")).sort(),
    codex: [...codex].filter((home) => exists(home, "sessions") || exists(home, "archived_sessions")).sort(),
  };
}

/**
 * `adeProviderUsageHomes` plus each CLI's own default home (`~/.claude`,
 * `~/.codex`). A brain or `ade` started from an agent's shell inherits that
 * agent's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and the scanners treat those as
 * the default, so without this the machine's main history silently dropped out
 * of every total that process reported. The scanners dedupe by path.
 */
export function machineProviderUsageHomes(): { claude: string[]; codex: string[] } {
  const homes = adeProviderUsageHomes();
  const ifPresent = (home: string, child: string) => (fs.existsSync(path.join(home, child)) ? [home] : []);
  return {
    claude: [...ifPresent(path.join(os.homedir(), ".claude"), "projects"), ...homes.claude],
    codex: [...ifPresent(path.join(os.homedir(), ".codex"), "sessions"), ...homes.codex],
  };
}
