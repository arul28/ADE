/**
 * The product's public names: what a person sees, types or links to.
 *
 * The product was called ADE and is now Daex. Copy, CLI help, links and
 * install commands read these names from here. Internal identifiers (bundle
 * IDs, keychain services, `.ade/`, `ADE_*` env names, `window.ade`, wire
 * strings, Worker names) keep the old name on purpose; the list and the
 * reasons are in docs/brand/README.md. The iOS copy is
 * apps/ios/ADE/Shared/Brand.swift; change both together.
 *
 * No imports: the CLI, the web client, the marketing site and build configs
 * import this file directly.
 */

const NAME = "Daex";
const FORMER_NAME = "ADE";

export const BRAND = Object.freeze({
  /** Display name. Always "Daex", never "DAEX". */
  NAME,
  /** The name the product had before; for "formerly ADE" notes and search. */
  FORMER_NAME,
  /** First mention in onboarding, release notes and the site. */
  INTRO_NAME: (NAME as string) === FORMER_NAME ? NAME : `${NAME} (formerly ${FORMER_NAME})`,

  /** Primary CLI command. */
  CLI: "daex",
  /** The old command; stays installed as a permanent alias. */
  LEGACY_CLI: "ade",

  DOMAIN: "daex.dev",
  /** Old domain. Sign-in and API hosts stay here while released clients call them. */
  LEGACY_DOMAIN: "ade-app.dev",
  SITE_URL: "https://daex.dev",

  /** Deep link scheme for new links (`daex://`). */
  URL_SCHEME: "daex",
  /** Old deep link scheme; accepted forever (`ade://`). */
  LEGACY_URL_SCHEME: "ade",

  NPM_SCOPE: "@daex-dev",
  LEGACY_NPM_SCOPE: "@ade-dev",

  /** Feature names. */
  CLOUD_NAME: `${NAME} Cloud`,
  BETA_NAME: `${NAME} Beta`,
} as const);

export type Brand = typeof BRAND;
