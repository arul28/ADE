import type { MusicDevice } from "../../../shared/types/music";
import React from "react";
import { friendlyMusicError, musicActions, useMusicState } from "./musicStore";
import { useMusicProvider } from "./musicProvider";

/** The provider choice stays available even when a provider cannot load. */
export function MusicProviderPicker() {
  const provider = useMusicProvider();
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex shrink-0 items-center gap-3 px-4 py-2">
      <div className="kit-seg" data-case="sentence" role="group" aria-label="Music service">
        {(["apple", "spotify"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={provider === value} disabled={busy} onClick={() => {
            setBusy(true);
            void musicActions.selectProvider(value).finally(() => setBusy(false));
          }}>{value === "apple" ? "Apple Music" : "Spotify"}</button>
        ))}
      </div>
      {provider === "spotify" ? <span className="text-xs text-muted-fg">Playback through Spotify Connect</span> : null}
    </div>
  );
}

/** Public application ID only; OAuth tokens never enter the renderer. */
export function SpotifySetup() {
  const redirectUri = useMusicState((state) => state?.spotify?.redirectUri ?? "http://127.0.0.1/spotify/callback");
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

export function SpotifyDevices() {
  const active = useMusicState((state) => state?.spotify?.device ?? null);
  const playing = useMusicState((state) => Boolean(state?.playback.isPlaying));
  const [devices, setDevices] = React.useState<MusicDevice[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try { setDevices(await window.ade!.music!.devices()); }
    catch (error) { setError(friendlyMusicError(error instanceof Error ? error.message : String(error)) ?? "Couldn't load devices. Try again."); }
    finally { setBusy(false); }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh, active?.id]);
  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-xs">
      <label className="flex flex-col gap-1">Playback device
        <select className="kit-input w-full" aria-label="Spotify playback device" value={active?.id ?? ""} disabled={busy} onChange={(event) => {
          const deviceId = event.target.value;
          if (!deviceId) return;
          setBusy(true);
          void window.ade!.music!.transfer({ deviceId, play: playing }).then(async (result) => {
            if (!result.ok) setError(result.error);
            else { await musicActions.refresh(); await refresh(); }
          }, () => setError("Couldn't switch devices. Try again.")).finally(() => setBusy(false));
        }}>
          <option value="">{devices === null ? "Loading…" : "Choose a device"}</option>
          {active && !devices?.some((device) => device.id === active.id) ? <option value={active.id}>{active.name}</option> : null}
          {devices?.map((device) => <option key={device.id} value={device.id} disabled={device.isRestricted}>{device.name}{device.isRestricted ? " (restricted)" : ""}</option>)}
        </select>
      </label>
      {error ? <span role="status" className="text-error">{error}</span> : devices?.length === 0 ? <span className="text-muted-fg">Open Spotify and play a song to make this computer available.</span> : null}
      <div className="flex flex-wrap gap-1">
        <button type="button" className="kit-btn" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        <button type="button" className="kit-btn" disabled={busy} onClick={() => {
          setBusy(true);
          setError(null);
          void window.ade!.music!.openSpotify().then(async (result) => {
            if (!result.ok) setError(result.error);
            await refresh();
          }, () => setError("Couldn't open Spotify. Open the app and refresh devices.")).finally(() => setBusy(false));
        }}>Open Spotify</button>
      </div>
    </div>
  );
}
