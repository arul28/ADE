#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function hasEnv(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

function formatList(values) {
  return values.map((value) => `- ${value}`).join("\n");
}

const missing = [];

const hasImportedCertificate = ["CSC_LINK", "CSC_KEY_PASSWORD"].every(hasEnv);
const hasInstalledIdentity = hasEnv("CSC_NAME");
const cscLink = hasEnv("CSC_LINK") ? String(process.env.CSC_LINK).trim() : "";
const cscLinkIsAbsolutePath = cscLink.startsWith("/");
const cscLinkPathExists = !cscLinkIsAbsolutePath || fs.existsSync(cscLink);

if (hasImportedCertificate && cscLinkIsAbsolutePath && !cscLinkPathExists && !hasInstalledIdentity) {
  missing.push(`CSC_LINK points to a missing certificate file: ${cscLink}`);
  missing.push("Provide a valid CSC_LINK + CSC_KEY_PASSWORD pair or set CSC_NAME to an installed Developer ID identity");
} else if (!hasImportedCertificate && !hasInstalledIdentity) {
  missing.push("Provide either CSC_LINK + CSC_KEY_PASSWORD or CSC_NAME");
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

if (hasImportedCertificate && cscLinkIsAbsolutePath && !cscLinkPathExists && hasInstalledIdentity) {
  process.stdout.write(
    `[release:mac] CSC_LINK points to a missing file (${cscLink}); continuing with installed identity ${process.env.CSC_NAME}.\n`
  );
}

process.stdout.write(
  `[release:mac] macOS signing and notarization environment looks complete (` +
    `${hasImportedCertificate && (!cscLinkIsAbsolutePath || cscLinkPathExists)
      ? "imported Developer ID certificate"
      : `installed identity ${process.env.CSC_NAME}`}, ` +
    `${matchingProfile.label}).\n`
);
