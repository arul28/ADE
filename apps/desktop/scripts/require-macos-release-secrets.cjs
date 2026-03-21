#!/usr/bin/env node
"use strict";

function hasEnv(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

function formatList(values) {
  return values.map((value) => `- ${value}`).join("\n");
}

const missing = [];

for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD"]) {
  if (!hasEnv(name)) {
    missing.push(name);
  }
}

const notarizationProfiles = [
  {
    label: "App Store Connect API key",
    vars: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  },
  {
    label: "Apple ID app-specific password",
    vars: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  },
  {
    label: "notarytool keychain profile",
    vars: ["APPLE_KEYCHAIN_PROFILE"],
  },
];

const matchingProfile = notarizationProfiles.find((profile) => profile.vars.every(hasEnv));

if (!matchingProfile) {
  const providedAppleVars = notarizationProfiles.flatMap((profile) => profile.vars).filter(hasEnv);
  process.stderr.write(
    "[release:mac] Missing notarization credentials.\n" +
      "Provide one complete credential set before building a signed macOS release:\n" +
      formatList(
        notarizationProfiles.map((profile) => `${profile.label}: ${profile.vars.join(", ")}`)
      ) +
      "\n"
  );
  if (providedAppleVars.length > 0) {
    process.stderr.write(
      `[release:mac] Partial Apple credential environment detected: ${providedAppleVars.join(", ")}\n`
    );
  }
  process.exit(1);
}

if (missing.length > 0) {
  process.stderr.write(
    "[release:mac] Missing required release environment variables:\n" + formatList(missing) + "\n"
  );
  process.exit(1);
}

if (matchingProfile.vars.includes("APPLE_API_KEY") && !String(process.env.APPLE_API_KEY).startsWith("/")) {
  process.stderr.write(
    "[release:mac] APPLE_API_KEY must point to the absolute path of the App Store Connect .p8 key file.\n"
  );
  process.exit(1);
}

process.stdout.write(
  `[release:mac] macOS signing and notarization environment looks complete (${matchingProfile.label}).\n`
);
