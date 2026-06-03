type EnvLike = Record<string, string | undefined>;

export const AUTOMATIONS_ENABLE_ENV = "ADE_ENABLE_AUTOMATIONS";
export const AUTOMATIONS_DISABLE_ENV = "ADE_DISABLE_AUTOMATIONS";
export const MACOS_VM_ENABLE_ENV = "ADE_ENABLE_MACOS_VM";
export const MACOS_VM_DISABLE_ENV = "ADE_DISABLE_MACOS_VM";

export const AUTOMATIONS_COMING_SOON_MESSAGE =
  "Automations are coming soon in production builds.";
export const MACOS_VM_COMING_SOON_MESSAGE =
  "Mac VM is coming soon in production builds.";

function envFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function readAutomationsEnvOverride(env: EnvLike = process.env): boolean | null {
  if (envFlagEnabled(env[AUTOMATIONS_ENABLE_ENV])) return true;
  if (envFlagEnabled(env[AUTOMATIONS_DISABLE_ENV])) return false;
  return null;
}

export function areAutomationsEnabledForPackagedState(
  isPackaged: boolean,
  env: EnvLike = process.env,
): boolean {
  const override = readAutomationsEnvOverride(env);
  if (override !== null) return override;
  return !isPackaged;
}

export function readMacosVmEnvOverride(env: EnvLike = process.env): boolean | null {
  if (envFlagEnabled(env[MACOS_VM_ENABLE_ENV])) return true;
  if (envFlagEnabled(env[MACOS_VM_DISABLE_ENV])) return false;
  return null;
}

export function isMacosVmEnabledForPackagedState(
  isPackaged: boolean,
  env: EnvLike = process.env,
): boolean {
  const override = readMacosVmEnvOverride(env);
  if (override !== null) return override;
  return !isPackaged;
}
