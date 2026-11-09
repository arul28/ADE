import { LINKS } from "./links";
import { MARKETING_CTA_LABELS, MARKETING_FEATURES } from "./marketingAnalytics";
import type { MarketingCtaLabel, MarketingFeature } from "./marketingAnalytics";

/**
 * Everything the install dialog says, per platform, in one place.
 *
 * The Windows release contract test reads this module to pin the wording of
 * the Windows install path, so the copy here is a contract, not decoration.
 * Nothing auto-detects OS or architecture anywhere in this flow — visitors
 * pick their own machine.
 */
export type InstallPlatform = "mac" | "windows" | "linux";

export type InstallDownload = {
  /** Endpoint that resolves the versioned asset server-side. */
  href: string;
  label: string;
  /** Small line under the label, e.g. the chip family. */
  detail: string;
  analyticsCta: MarketingCtaLabel;
};

export type InstallTarget = {
  platform: InstallPlatform;
  /** Dialog heading. */
  title: string;
  /** One line under the heading, when there is one. */
  subtitle?: string;
  terminal: {
    heading: string;
    command: string;
    blurb?: string;
    analyticsFeature: MarketingFeature;
  };
  /** Absent for Linux — there is no ADE desktop app for Linux. */
  downloads?: {
    heading: string;
    blurb?: string;
    options: InstallDownload[];
  };
  /**
   * OS prompts ADE cannot suppress, and what to click. Windows only today: the
   * app installs per user with no elevation, so it can neither buy its way past
   * SmartScreen's first-run warning nor pre-create a firewall rule (Windows has
   * no per-user firewall rule store). Telling people up front is the fix that
   * does not cost them a UAC prompt on every install.
   */
  prompts?: {
    heading: string;
    items: string[];
  };
  footnote: {
    text?: string;
    /** Copyable command rendered inside the footnote, when there is one. */
    command?: string;
    commandAnalyticsFeature?: MarketingFeature;
  };
  openAnalyticsFeature: MarketingFeature;
};

export const MAC_INSTALL_COMMAND = "curl -fsSL https://ade-app.dev/install.sh | sh";
export const WINDOWS_INSTALL_COMMAND = "irm https://ade-app.dev/install.ps1 | iex";
export const LINUX_INSTALL_COMMAND = MAC_INSTALL_COMMAND;
export const BREW_INSTALL_COMMAND = "brew install --cask arul28/ade/ade";

export const INSTALL_TARGETS: Readonly<Record<InstallPlatform, InstallTarget>> = Object.freeze({
  mac: {
    platform: "mac",
    title: "Get ADE for Mac",
    terminal: {
      heading: "Install from your terminal",
      command: MAC_INSTALL_COMMAND,
      analyticsFeature: MARKETING_FEATURES.COPY_INSTALL_COMMAND_MAC,
    },
    downloads: {
      heading: "or Download from file",
      options: [
        {
          href: LINKS.downloadMacArm64,
          label: "Apple Silicon",
          detail: "M1 and later",
          analyticsCta: MARKETING_CTA_LABELS.DOWNLOAD_MAC_ARM64,
        },
        {
          href: LINKS.downloadMacX64,
          label: "Intel",
          detail: "x86_64 Macs",
          analyticsCta: MARKETING_CTA_LABELS.DOWNLOAD_MAC_X64,
        },
      ],
    },
    footnote: {
      text: "Homebrew, if you prefer:",
      command: BREW_INSTALL_COMMAND,
      commandAnalyticsFeature: MARKETING_FEATURES.COPY_BREW_COMMAND,
    },
    openAnalyticsFeature: MARKETING_FEATURES.INSTALL_DIALOG_MAC,
  },
  windows: {
    platform: "windows",
    title: "Get ADE for Windows",
    terminal: {
      heading: "Install from your terminal",
      command: WINDOWS_INSTALL_COMMAND,
      analyticsFeature: MARKETING_FEATURES.COPY_INSTALL_COMMAND_WINDOWS,
    },
    downloads: {
      heading: "or Download from file",
      options: [
        {
          href: LINKS.downloadWindows,
          label: "Windows installer",
          detail: "x64",
          analyticsCta: MARKETING_CTA_LABELS.DOWNLOAD_WINDOWS_X64,
        },
      ],
    },
    prompts: {
      heading: "Two Windows prompts to expect",
      items: [
        "SmartScreen may say “Windows protected your PC”. Choose More info, then Run anyway.",
        "Windows Firewall asks to allow ADE the first time you sync over your network. Allow it on private networks. A per-user install cannot pre-approve that rule.",
      ],
    },
    footnote: {
      text: "Per-user installer — no administrator rights. Windows 10/11, x64.",
    },
    openAnalyticsFeature: MARKETING_FEATURES.INSTALL_DIALOG_WINDOWS,
  },
  linux: {
    platform: "linux",
    title: "Run the ADE brain on Linux",
    terminal: {
      heading: "Install from your terminal",
      command: LINUX_INSTALL_COMMAND,
      blurb:
        "Run the brain on any Linux box and control it from ADE on your Mac, Windows, phone, or the web.",
      analyticsFeature: MARKETING_FEATURES.COPY_INSTALL_COMMAND_LINUX,
    },
    footnote: {},
    openAnalyticsFeature: MARKETING_FEATURES.INSTALL_DIALOG_LINUX,
  },
});
