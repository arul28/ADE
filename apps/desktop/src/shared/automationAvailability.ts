type EnvLike = Record<string, string | undefined>;

export const AUTOMATIONS_ENABLE_ENV = "ADE_ENABLE_AUTOMATIONS";
export const AUTOMATIONS_DISABLE_ENV = "ADE_DISABLE_AUTOMATIONS";

export const AUTOMATIONS_COMING_SOON_MESSAGE =
  "Automations are disabled on this build.";

function envFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function readAutomationsEnvOverride(env: EnvLike = process.env): boolean | null {
  if (envFlagEnabled(env[AUTOMATIONS_ENABLE_ENV])) return true;
  if (envFlagEnabled(env[AUTOMATIONS_DISABLE_ENV])) return false;
  return null;
}

// Automations ship enabled in all builds; ADE_DISABLE_AUTOMATIONS remains as a
// kill switch. The packaged/dev split this signature reflects is retained so
// callers don't churn if packaged builds ever need a different default again.
export function areAutomationsEnabledForPackagedState(
  _isPackaged: boolean,
  env: EnvLike = process.env,
): boolean {
  const override = readAutomationsEnvOverride(env);
  if (override !== null) return override;
  return true;
}
