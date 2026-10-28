import { isAdeSpotifyDevice, MUSIC_SPOTIFY_ADE_DEVICE, MUSIC_SPOTIFY_REDIRECT_URI, type MusicDevice } from "../../../shared/types/music";
import React from "react";
import { ArrowSquareOut, Check, CircleNotch, Copy } from "@phosphor-icons/react";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { friendlyMusicError, musicActions, readMusicLastError, useMusicLastError, useMusicState } from "./musicStore";
import { SpotifyBrand } from "./musicParts";
import { Banner } from "../ui/notice";
import setupConsentUrl from "./assets/spotify-setup-consent.jpg";
import setupDashboardUrl from "./assets/spotify-setup-dash.jpg";
import setupApisUrl from "./assets/spotify-setup-apis.jpg";
import setupRedirectUrl from "./assets/spotify-setup-redirect.jpg";
import setupTermsUrl from "./assets/spotify-setup-terms.jpg";
import { extractError } from "../../lib/format";

const SPOTIFY_DASHBOARD_URL = "https://developer.spotify.com/dashboard";
const isSpotifyClientId = (value: string) => /^[a-f\d]{32}$/i.test(value.trim());

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="ade-spotify-copy">
      <span className="ade-spotify-copy-label">{label}</span>
      <code>{value}</code>
      <button type="button" className="kit-btn" aria-label={`Copy ${label}`} onClick={() => {
        void copyTextToClipboard(value).then((ok) => setCopied(ok));
      }}>
        {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type SetupStep = 0 | 1 | 2 | 3 | 4;
const SETUP_STEPS = 4;

/**
 * First-time Spotify setup. Spotify only admits apps like ADE through a
 * developer app the user owns, so an intro says so and a short guide walks
 * through making one, a step at a time with pictures of Spotify's own pages,
 * and ends in Connect. Only the public Client ID enters the renderer.
 */
export function SpotifyOnboarding() {
  const redirectUri = useMusicState((state) => state?.spotify?.redirectUri ?? MUSIC_SPOTIFY_REDIRECT_URI);
  const savedClientId = useMusicState((state) => state?.spotify?.clientId ?? "");
  const lastError = useMusicLastError();
  const [step, setStep] = React.useState<SetupStep>(0);
  const [clientId, setClientId] = React.useState(savedClientId);
  const [busy, setBusy] = React.useState(false);
  const trimmed = clientId.trim();
  const valid = isSpotifyClientId(trimmed);

  if (step === 0) {
    return (
      <section className="ade-spotify-setup ade-chat-scene-plane is-intro" data-testid="spotify-setup" data-onboarding-anchor="music-setup">
        <header className="ade-spotify-setup-head">
          <SpotifyBrand />
          <h1>Connect Spotify</h1>
          <p>Search, your library and playlists, and playback, inside ADE.</p>
          <p>Spotify only lets apps like ADE in through a free developer app that you own. ADE shows you how. It takes about two minutes, once.</p>
          <span className="kit-tag">Needs Spotify Premium</span>
        </header>
        <div className="ade-spotify-intro-actions">
          <button type="button" className="kit-btn kit-btn-primary" onClick={() => setStep(1)}>Set up Spotify</button>
          <button type="button" className="kit-btn kit-btn-ghost" onClick={() => setStep(3)}>I already have a Client ID</button>
        </div>
        <details className="ade-spotify-why">
          <summary>Why does Spotify need this?</summary>
          <p>Spotify gives full access only to businesses with 250,000+ monthly users. Everyone else uses a developer app, which works for its owner and up to five people they add. ADE never sees your password, and its access stays encrypted on this computer.</p>
        </details>
      </section>
    );
  }

  const connect = () => {
    setBusy(true);
    void (async () => {
      try {
        await musicActions.configureSpotify(trimmed);
        if (readMusicLastError()) return;
        await musicActions.connect();
      } finally {
        setBusy(false);
      }
    })();
  };

  const body = (() => {
    switch (step) {
      case 1:
        return (
          <>
            <h2>Create a Spotify app</h2>
            <p>Open Spotify's developer dashboard in your browser and log in with your Spotify account.</p>
            <button type="button" className="kit-btn kit-btn-primary" onClick={() => void window.ade?.app?.openExternal(SPOTIFY_DASHBOARD_URL)}>
              Open dashboard <ArrowSquareOut size={13} />
            </button>
            <p>If Spotify shows its developer terms first, tick the box and click <b>Accept the terms</b>.</p>
            <SetupShot src={setupTermsUrl} alt="Spotify's developer terms, with the accept box and the Accept the terms button" />
            <p>Then click <b>Create app</b> at the top right.</p>
            <SetupShot src={setupDashboardUrl} alt="Spotify's developer dashboard, with the Create app button at the top right" />
          </>
        );
      case 2:
        return (
          <>
            <h2>Fill in the form</h2>
            <p>Copy each value into its field. Leave <b>Website</b> empty.</p>
            <CopyValue label="App name" value="ADE" />
            <CopyValue label="Description" value="Spotify in ADE" />
            <CopyValue label="Redirect URI" value={redirectUri} />
            <p>After pasting the redirect URI, click <b>Add</b> next to it.</p>
            <SetupShot src={setupRedirectUrl} alt="The Redirect URIs field with its Add button" />
            <p>Tick <b>Web API</b> and <b>Web Playback SDK</b>.</p>
            <SetupShot src={setupApisUrl} alt="The API checkboxes: Web API and Web Playback SDK" />
            <p>Tick the terms box at the bottom and click <b>Save</b>.</p>
          </>
        );
      case 3:
        return (
          <>
            <h2>Copy your Client ID</h2>
            <p>Spotify opens your new app after <b>Save</b>. Its <b>Client ID</b> is under <b>Basic information</b>: 32 letters and numbers. You don't need the client secret.</p>
            <input
              className="kit-input ade-spotify-client-id"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder="Paste the Client ID"
              aria-label="Spotify Client ID"
              aria-invalid={trimmed.length > 0 && !valid}
            />
            {trimmed.length > 0 ? (
              <span className={`ade-spotify-check${valid ? " is-ok" : ""}`} role="status">
                {valid ? <><Check size={12} weight="bold" /> Looks right</> : "A Client ID is 32 letters and numbers."}
              </span>
            ) : null}
          </>
        );
      default:
        return (
          <>
            <h2>Connect</h2>
            <p>Spotify opens in your browser and asks to let ADE in. Click <b>Agree</b>, then come back here.</p>
            <SetupShot src={setupConsentUrl} alt="Spotify's consent page listing what ADE may do, with the Agree button" />
            {lastError ? (
              <Banner
                layout="inline"
                model={{
                  id: "spotify-connect-error",
                  tone: "error",
                  title: lastError,
                  report: { surface: "spotify_connect" },
                  dismiss: { onDismiss: musicActions.clearError },
                }}
              />
            ) : null}
          </>
        );
    }
  })();

  return (
    <section className="ade-spotify-setup ade-chat-scene-plane" data-testid="spotify-setup" aria-label="Spotify setup">
      <header className="ade-spotify-wizard-head">
        <SpotifyBrand />
        <span className="ade-spotify-progress" aria-label={`Step ${step} of ${SETUP_STEPS}`}>
          {Array.from({ length: SETUP_STEPS }, (_, index) => (
            <i key={index} data-state={index + 1 < step ? "done" : index + 1 === step ? "current" : undefined} />
          ))}
          <span>Step {step} of {SETUP_STEPS}</span>
        </span>
      </header>
      <div className="ade-spotify-step" key={step}>{body}</div>
      <footer className="ade-spotify-wizard-foot">
        <button type="button" className="kit-btn kit-btn-ghost" disabled={busy} onClick={() => setStep((step - 1) as SetupStep)}>Back</button>
        {step < SETUP_STEPS ? (
          <button type="button" className="kit-btn kit-btn-primary" disabled={step === 3 && !valid} onClick={() => setStep((step + 1) as SetupStep)}>Next</button>
        ) : (
          <button type="button" className="kit-btn kit-btn-primary" disabled={!valid || busy} onClick={connect}>
            {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
            Connect Spotify
          </button>
        )}
      </footer>
    </section>
  );
}

function SetupShot({ src, alt }: { src: string; alt: string }) {
  return <img className="ade-spotify-shot" src={src} alt={alt} loading="lazy" decoding="async" draggable={false} />;
}

/** Public application ID only; OAuth tokens never enter the renderer. */
export function SpotifySetup() {
  const redirectUri = useMusicState((state) => state?.spotify?.redirectUri ?? MUSIC_SPOTIFY_REDIRECT_URI);
  const clientId = useMusicState((state) => state?.spotify?.clientId ?? "");
  const [value, setValue] = React.useState(clientId);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setValue(clientId), [clientId]);
  return (
    <form className="kit-card mx-auto mt-4 w-full max-w-lg text-left" onSubmit={(event) => {
      event.preventDefault();
      setSaving(true);
      void musicActions.configureSpotify(value.trim()).finally(() => setSaving(false));
    }}>
      <div className="kit-card-head">Spotify connection</div>
      <div className="kit-card-body flex flex-col gap-3">
        <p className="text-xs text-muted-fg">Enter your Spotify application's client ID. No client secret is needed.</p>
        <label className="flex flex-col gap-1 text-xs">Client ID
          <input className="kit-input" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Spotify client ID" />
        </label>
        <button className="kit-btn self-start" type="submit" disabled={saving || !/^[a-f\d]{32}$/i.test(value.trim())}>{saving ? "Saving…" : "Save client ID"}</button>
        {clientId ? <button className="kit-btn self-start" type="button" disabled={saving} onClick={() => void musicActions.configureSpotify("")}>Remove client ID</button> : null}
        <p className="text-xs text-muted-fg">Register the redirect address shown below in the Spotify developer dashboard. Development apps require Premium and an allowed account.</p>
        <code className="break-all text-xs">{redirectUri}</code>
      </div>
    </form>
  );
}

/**
 * Where Spotify plays. ADE itself by default; the menu can send it to the
 * Spotify app, a phone or a speaker instead.
 */
export function SpotifyDevices() {
  const active = useMusicState((state) => state?.spotify?.device ?? null);
  const playing = useMusicState((state) => Boolean(state?.playback.isPlaying));
  const [devices, setDevices] = React.useState<MusicDevice[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const refresh = React.useCallback(async () => {
    setError(null);
    try { setDevices(await window.ade!.music!.devices()); }
    catch (error) { setError(friendlyMusicError(extractError(error)) ?? "Couldn't load devices. Try again."); }
  }, []);
  // ADE's own player is listed once, as this computer.
  const others = (devices ?? []).filter((device) => !isAdeSpotifyDevice(device));
  const value = !active || isAdeSpotifyDevice(active) ? MUSIC_SPOTIFY_ADE_DEVICE : active.id;
  return (
    <div className="ade-spotify-device">
      <label>
        <span>Playing on</span>
        <select
          className="kit-input"
          aria-label="Spotify playback device"
          value={value}
          disabled={busy}
          onFocus={() => void refresh()}
          onPointerDown={() => { if (devices === null) void refresh(); }}
          onChange={(event) => {
            const deviceId = event.target.value;
            setBusy(true);
            void window.ade!.music!.transfer({ deviceId, play: playing }).then(async (result) => {
              if (!result.ok) setError(result.error);
              else await musicActions.refresh();
            }, () => setError("Couldn't switch devices. Try again.")).finally(() => setBusy(false));
          }}
        >
          <option value={MUSIC_SPOTIFY_ADE_DEVICE}>This computer (ADE)</option>
          {active && !isAdeSpotifyDevice(active) && !others.some((device) => device.id === active.id) ? <option value={active.id}>{active.name}</option> : null}
          {others.map((device) => <option key={device.id} value={device.id} disabled={device.isRestricted}>{device.name}{device.isRestricted ? " (restricted)" : ""}</option>)}
        </select>
      </label>
      {error ? (
        <Banner
          layout="inline"
          model={{
            id: "spotify-devices-error",
            tone: "error",
            title: error,
            report: { surface: "spotify_devices" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
    </div>
  );
}
