import { useCallback, useEffect, useState } from "react";
import {
  BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX,
  BUILT_IN_BROWSER_SEARCH_ENGINES,
  BUILT_IN_BROWSER_SETTINGS_DEFAULTS,
  BUILT_IN_BROWSER_TAB_LIMIT_MAX,
  BUILT_IN_BROWSER_TAB_LIMIT_MIN,
  isValidBrowserSearchTemplate,
  type BuiltInBrowserSearchEngineId,
  type BuiltInBrowserTrustedCertificate,
} from "../../../shared/types/builtInBrowser";
import { browserSettingsActions, useBrowserSettings, useBrowserSettingsStatus } from "../chat/browser/browserSettings";
import {
  ModernRow,
  ModernRows,
  ModernSection,
  SettingsNumber,
  SettingsSelect,
  SettingsTextField,
  SettingsToggle,
} from "./primitives";
import { useSettingsAction } from "./useSettingsAction";
import { Banner } from "../ui/notice";
import "./machineSettings.css";

const SEARCH_ENGINE_OPTIONS: readonly { value: BuiltInBrowserSearchEngineId; label: string }[] = [
  ...BUILT_IN_BROWSER_SEARCH_ENGINES.map((engine) => ({ value: engine.id, label: engine.label })),
  { value: "custom", label: "Custom…" },
];

/** Tab limit, download folder, address bar search, trusted local certificates. */
export function BrowserSettingsSection() {
  return (
    <>
      <BrowserBehaviourSection />
      <BrowserTrustedCertificatesSection />
    </>
  );
}

function BrowserBehaviourSection() {
  const snapshot = useBrowserSettings();
  const loadStatus = useBrowserSettingsStatus();
  const settings = snapshot ?? BUILT_IN_BROWSER_SETTINGS_DEFAULTS;
  const { busy, error, run } = useSettingsAction();
  // One row's save at a time; a string key keeps the shared hook's shape.
  const act = (work: () => Promise<void>) => run("browser-settings", work);
  // The limit is committed on blur/Enter: saving every keystroke turned "25"
  // into 2 (the field disables while saving), and an empty field into 1.
  const [draftLimit, setDraftLimit] = useState<number | null>(null);
  useEffect(() => setDraftLimit(null), [settings.tabLimit]);
  const commitLimit = () => {
    // SettingsNumber reports 0 for an emptied field. Revert rather than clamp
    // that to 1: leaving the field empty must not silently change the limit.
    if (draftLimit == null || draftLimit < BUILT_IN_BROWSER_TAB_LIMIT_MIN) {
      setDraftLimit(null);
      return;
    }
    const next = Math.max(BUILT_IN_BROWSER_TAB_LIMIT_MIN, Math.min(BUILT_IN_BROWSER_TAB_LIMIT_MAX, Math.trunc(draftLimit)));
    setDraftLimit(null);
    if (next !== settings.tabLimit) void act(() => browserSettingsActions.set({ tabLimit: next }));
  };

  // The custom URL is committed on blur/Enter like the tab limit, so a URL
  // half typed is never saved, and the warning describes what is saved.
  const [draftCustomUrl, setDraftCustomUrl] = useState<string | null>(null);
  useEffect(() => setDraftCustomUrl(null), [settings.customSearchUrl]);
  const commitCustomUrl = () => {
    if (draftCustomUrl == null) return;
    const next = draftCustomUrl.trim().slice(0, BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX) || null;
    setDraftCustomUrl(null);
    if (next !== settings.customSearchUrl) void act(() => browserSettingsActions.set({ customSearchUrl: next }));
  };
  const customInvalid = settings.searchEngine === "custom" && !isValidBrowserSearchTemplate(settings.customSearchUrl);
  const defaultEngineLabel = BUILT_IN_BROWSER_SEARCH_ENGINES[0].label;

  const chooseFolder = async () => {
    const chosen = await window.ade.project.chooseDirectory({
      title: "Choose where ADE browser downloads go",
      defaultPath: settings.downloadDir ?? undefined,
    });
    if (!chosen) return;
    await browserSettingsActions.set({ downloadDir: chosen });
  };

  return (
    <ModernSection
      group="ADE browser"
      anchor="browser-settings"
      title="Browser behaviour"
      hint="Machine-wide, like the browser profile itself."
    >
      {loadStatus === "failed" ? (
        <p className="ade-modern-error" role="alert">
          Couldn't load browser settings.{" "}
          <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => browserSettingsActions.reload()}>
            Retry
          </button>
        </p>
      ) : null}
      <ModernRows>
        <ModernRow
          anchor="browser-tab-limit"
          title="Tabs per browser"
          hint={`How many tabs it keeps open, ${BUILT_IN_BROWSER_TAB_LIMIT_MIN}–${BUILT_IN_BROWSER_TAB_LIMIT_MAX}. Agents close their own.`}
          control={(
            <span
              onBlur={commitLimit}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLElement).blur();
              }}
            >
              <SettingsNumber
                ariaLabel="Tabs per browser"
                value={draftLimit ?? settings.tabLimit}
                min={BUILT_IN_BROWSER_TAB_LIMIT_MIN}
                max={BUILT_IN_BROWSER_TAB_LIMIT_MAX}
                disabled={busy != null || !snapshot}
                onChange={setDraftLimit}
              />
            </span>
          )}
        />
        <ModernRow
          anchor="browser-download-folder"
          title="Download folder"
          hint={settings.downloadDir ?? "Your Downloads folder."}
          control={(
            <span className="ade-modern-inline-actions">
              <button
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                disabled={busy != null || !snapshot}
                onClick={() => void act(chooseFolder)}
              >
                Choose…
              </button>
              {settings.downloadDir ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={busy != null || !snapshot}
                  onClick={() => void act(() => browserSettingsActions.set({ downloadDir: null }))}
                >
                  Use Downloads
                </button>
              ) : null}
            </span>
          )}
        />
        <ModernRow
          anchor="browser-search-engine"
          title="Search engine"
          hint="What the address bar searches with when you type words instead of an address. Used by this computer's ADE browser."
          control={(
            <SettingsSelect
              ariaLabel="Search engine"
              value={settings.searchEngine}
              options={SEARCH_ENGINE_OPTIONS}
              disabled={busy != null || !snapshot}
              onChange={(next) => void act(() => browserSettingsActions.set({ searchEngine: next }))}
            />
          )}
        />
        {settings.searchEngine === "custom" ? (
          <ModernRow
            anchor="browser-custom-search-url"
            title="Custom search URL"
            hint={customInvalid ? (
              <span style={{ color: "var(--kit-warn)" }} role="status">
                {settings.customSearchUrl
                  ? "This URL can't be used. It needs http:// or https:// and %s after the site's address."
                  : "Enter a search URL with %s where the words go."}
                {` Searches use ${defaultEngineLabel} until it's fixed.`}
              </span>
            ) : "Put %s where the words go, for example https://search.example.com/?q=%s."}
          >
            <span
              onBlur={commitCustomUrl}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLElement).blur();
              }}
            >
              <SettingsTextField
                ariaLabel="Custom search URL"
                type="url"
                mono
                spellCheck={false}
                autoComplete="off"
                placeholder="https://search.example.com/?q=%s"
                value={draftCustomUrl ?? settings.customSearchUrl ?? ""}
                disabled={busy != null || !snapshot}
                onChange={setDraftCustomUrl}
              />
            </span>
          </ModernRow>
        ) : null}
      </ModernRows>
      {error ? <p className="ade-modern-error" role="alert">{error}</p> : null}
    </ModernSection>
  );
}

type TrustedCertificatesApi = {
  listTrustedCertificates: () => Promise<{ certificates: BuiltInBrowserTrustedCertificate[] }>;
  revokeTrustedCertificates: (args?: { id?: string | null }) => Promise<{ certificates: BuiltInBrowserTrustedCertificate[] }>;
};

function trustedCertificatesApi(): TrustedCertificatesApi | null {
  const candidate = (typeof window === "undefined" ? null : window.ade?.builtInBrowser) as
    | Partial<TrustedCertificatesApi>
    | null
    | undefined;
  return candidate
    && typeof candidate.listTrustedCertificates === "function"
    && typeof candidate.revokeTrustedCertificates === "function"
    ? (candidate as TrustedCertificatesApi)
    : null;
}

function certificateEndpoint(certificate: BuiltInBrowserTrustedCertificate): string {
  const host = certificate.host.includes(":") ? `[${certificate.host}]` : certificate.host;
  return certificate.port === 443 ? host : `${host}:${certificate.port}`;
}

/**
 * Local HTTPS certificates the person chose to trust from the browser's
 * "isn't trusted" banner, and the way to take that back.
 * Read when Settings opens and after each change; nothing polls.
 */
function BrowserTrustedCertificatesSection() {
  const api = trustedCertificatesApi();
  const [certificates, setCertificates] = useState<BuiltInBrowserTrustedCertificate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const { busy, error, run } = useSettingsAction();
  const load = useCallback(() => {
    if (!api) return;
    setLoadFailed(false);
    api.listTrustedCertificates()
      .then((result) => setCertificates(Array.isArray(result?.certificates) ? result.certificates : []))
      .catch(() => setLoadFailed(true));
  }, [api]);
  useEffect(load, [load]);
  if (!api) return null;
  const revoke = (id?: string) => run("browser-certificates", async () => {
    const result = await api.revokeTrustedCertificates(id ? { id } : {});
    setCertificates(result.certificates);
  });

  return (
    <ModernSection
      group="ADE browser"
      anchor="browser-trusted-certificates"
      title="Trusted local certificates"
      hint="Self-signed HTTPS certificates you trusted for a local or private address. A site whose certificate changes asks again."
    >
      {loadFailed ? (
        <Banner
          layout="inline"
          model={{
            id: "browser-certificates-load-failed",
            tone: "error",
            title: "Couldn't load trusted certificates",
            actions: [{ label: "Try again", onClick: load }],
          }}
        />
      ) : null}
      {certificates && certificates.length > 0 ? (
        <ModernRows>
          {certificates.map((certificate) => (
            <ModernRow
              key={certificate.id}
              title={certificateEndpoint(certificate)}
              hint={(
                <>
                  <span className="ade-modern-path" title={certificate.fingerprint}>
                    SHA-256 {certificate.fingerprintHex}
                  </span>
                  <br />
                  {certificate.profile === "isolated"
                    ? "An agent's throwaway sign-in, until its tabs close."
                    : "Shared browser profile."}
                  {` Trusted ${new Date(certificate.trustedAt).toLocaleString()}.`}
                </>
              )}
              control={(
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  disabled={busy != null}
                  onClick={() => void revoke(certificate.id)}
                >
                  Remove
                </button>
              )}
            />
          ))}
        </ModernRows>
      ) : certificates ? (
        <p className="ade-modern-muted">
          None. When a local HTTPS page's certificate isn't trusted, the ADE browser offers to trust it above the page.
        </p>
      ) : null}
      {certificates && certificates.length > 1 ? (
        <span className="ade-modern-inline-actions">
          <button
            type="button"
            className="ade-modern-btn"
            data-size="sm"
            data-variant="ghost"
            disabled={busy != null}
            onClick={() => void revoke()}
          >
            Remove all
          </button>
        </span>
      ) : null}
      {error ? <p className="ade-modern-error" role="alert">{error}</p> : null}
    </ModernSection>
  );
}

/**
 * Standing permission grants for agent-driven tabs.
 *
 * Off by default, and each switch says what it lets a site do. A saved per-site
 * Block still wins, and a combined camera+microphone request needs both
 * switches — never the microphone because only camera was enabled.
 */
export function BrowserAutoGrantSection() {
  const snapshot = useBrowserSettings();
  const settings = snapshot ?? BUILT_IN_BROWSER_SETTINGS_DEFAULTS;
  const { busy, error, run } = useSettingsAction();
  // One row's save at a time; a string key keeps the shared hook's shape.
  const act = (work: () => Promise<void>) => run("browser-settings", work);
  const rows = [
    {
      key: "camera" as const,
      anchor: "browser-auto-camera",
      title: "Camera",
      hint: "Let a site an agent opens use your camera without asking. Only enable this while testing a video feature.",
    },
    {
      key: "microphone" as const,
      anchor: "browser-auto-microphone",
      title: "Microphone",
      hint: "Let a site an agent opens use your microphone without asking. Only enable this while testing audio.",
    },
    {
      key: "geolocation" as const,
      anchor: "browser-auto-geolocation",
      title: "Location",
      hint: "Let a site an agent opens read your approximate location without asking.",
    },
  ];

  return (
    <ModernSection
      group="ADE browser"
      anchor="browser-auto-grant"
      title="Let agents approve these without asking"
      hint="All off by default. Sites you blocked stay blocked."
    >
      <ModernRows>
        {rows.map((row) => (
          <ModernRow
            key={row.key}
            anchor={row.anchor}
            title={row.title}
            hint={row.hint}
            control={(
              <SettingsToggle
                label={`Auto-approve ${row.title.toLowerCase()} for agents`}
                checked={settings.autoGrant[row.key]}
                disabled={busy != null || !snapshot}
                onChange={(next) => void act(() => browserSettingsActions.set({
                  autoGrant: { [row.key]: next },
                }))}
              />
            )}
          />
        ))}
      </ModernRows>
      {error ? <p className="ade-modern-error" role="alert">{error}</p> : null}
      {settings.autoGrant.camera || settings.autoGrant.microphone
        ? <p className="ade-modern-muted">Camera and microphone also need the operating system's permission for ADE.</p>
        : null}
    </ModernSection>
  );
}
