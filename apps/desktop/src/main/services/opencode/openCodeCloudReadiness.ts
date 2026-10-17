import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenCodeCloudReadiness } from "../../../shared/types/config";

/**
 * Whether this machine has the login an OpenCode cloud sign-in points at.
 *
 * A cloud sign-in (OpenCode's `external` method) stores no token: it tells
 * OpenCode to use the machine's own gcloud Application Default Credentials or
 * an AWS profile, which their CLIs refresh themselves. So the same sign-in can
 * work on one machine and not another, and OpenCode does not check when it is
 * saved. ADE checks the files those CLIs read, the same ones OpenCode reads,
 * and names the command that fixes a missing one. A file that exists can still
 * hold an expired session; this answers "is there a login here", not "will
 * the next request succeed".
 */

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** gcloud's configuration directory: `CLOUDSDK_CONFIG`, else the per-platform default. */
function gcloudConfigDir(): string {
  const configured = process.env.CLOUDSDK_CONFIG?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "gcloud");
  }
  return path.join(os.homedir(), ".config", "gcloud");
}

function googleAdcReadiness(): OpenCodeCloudReadiness {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicit && fileExists(explicit)) {
    return { state: "ready", detail: "Using GOOGLE_APPLICATION_CREDENTIALS." };
  }
  if (fileExists(path.join(gcloudConfigDir(), "application_default_credentials.json"))) {
    return { state: "ready", detail: "Signed in with gcloud application-default credentials." };
  }
  return {
    state: "needs_login",
    detail: "No Google Cloud application-default login on this computer.",
    command: "gcloud auth application-default login",
  };
}

/** Profile names in an AWS config (`[profile x]`, `[default]`) or credentials (`[x]`) file. */
function awsProfilesIn(text: string | null, kind: "config" | "credentials"): Set<string> {
  const names = new Set<string>();
  if (!text) return names;
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(raw);
    if (!match) continue;
    const section = match[1]!;
    if (kind === "credentials") names.add(section);
    else if (section === "default") names.add("default");
    else if (section.startsWith("profile ")) names.add(section.slice("profile ".length).trim());
  }
  return names;
}

function awsProfileReadiness(profile: string | undefined): OpenCodeCloudReadiness {
  const name = profile?.trim();
  if (!name) return { state: "unknown" };
  const awsDir = path.join(os.homedir(), ".aws");
  const configFile = process.env.AWS_CONFIG_FILE?.trim() || path.join(awsDir, "config");
  const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || path.join(awsDir, "credentials");
  const known = new Set([
    ...awsProfilesIn(readFileOrNull(configFile), "config"),
    ...awsProfilesIn(readFileOrNull(credentialsFile), "credentials"),
  ]);
  if (known.has(name)) return { state: "ready", detail: `AWS profile ${name} is set up on this computer.` };
  return {
    state: "needs_login",
    detail: `AWS profile ${name} is not set up on this computer.`,
    command: `aws configure sso --profile ${name}`,
  };
}

/** Readiness for one cloud sign-in, by OpenCode method id and the answers it was saved with. */
export function openCodeCloudReadiness(methodId: string, details: Record<string, string>): OpenCodeCloudReadiness {
  if (methodId === "google-adc") return googleAdcReadiness();
  if (methodId === "aws-profile") return awsProfileReadiness(details.profile);
  return { state: "unknown" };
}
