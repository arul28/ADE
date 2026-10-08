/**
 * Names for Now Playing sources: the player behind an OS media session, and
 * the service behind a browser tab. The icons come from the source itself
 * (the app's own icon, the site's own favicon), so ADE ships no third-party
 * marks; these are only the words beside them.
 */

const APP_NAMES: Array<[RegExp, string]> = [
  [/spotify/i, "Spotify"],
  [/appleinc\.applemusic|applemusic|apple\.music/i, "Apple Music"],
  [/^com\.apple\.music$/i, "Music"],
  [/itunes/i, "iTunes"],
  [/zunemusic|zunevideo|media\.?player|wmplayer/i, "Media Player"],
  [/msedge/i, "Microsoft Edge"],
  [/chrome/i, "Chrome"],
  [/firefox|^308046B0AF4A39CB$/i, "Firefox"],
  [/brave/i, "Brave"],
  [/opera/i, "Opera"],
  [/vivaldi/i, "Vivaldi"],
  [/arc\b|thebrowsercompany/i, "Arc"],
  [/vlc/i, "VLC"],
  [/foobar2000/i, "foobar2000"],
  [/musicbee/i, "MusicBee"],
  [/winamp/i, "Winamp"],
  [/aimp/i, "AIMP"],
  [/tidal/i, "TIDAL"],
  [/deezer/i, "Deezer"],
  [/amazon.*music/i, "Amazon Music"],
  [/discord/i, "Discord"],
  [/plex/i, "Plex"],
  [/mpv/i, "mpv"],
  [/^com\.google\.chrome/i, "Chrome"],
  [/^com\.apple\.safari/i, "Safari"],
  [/^com\.apple\.podcasts/i, "Podcasts"],
  [/^com\.apple\.tv/i, "TV"],
];

/** The player behind an OS session id (a Windows AppUserModelId or a macOS bundle id). */
export function appSourceName(id: string | null | undefined, shellName?: string | null): string | null {
  if (!id) return shellName?.trim() || null;
  for (const [pattern, name] of APP_NAMES) {
    if (pattern.test(id)) return name;
  }
  if (shellName?.trim()) return shellName.trim();
  // "Publisher.App_hash!App" or "app.exe": the readable middle.
  const base = id.split("!")[0]!.split("_")[0]!.replace(/\.exe$/i, "");
  return base.split(".").at(-1) || base;
}

const SITE_NAMES: Array<[RegExp, string]> = [
  [/(^|\.)music\.youtube\.com$/i, "YouTube Music"],
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, "YouTube"],
  [/(^|\.)soundcloud\.com$/i, "SoundCloud"],
  [/(^|\.)spotify\.com$/i, "Spotify"],
  [/(^|\.)twitch\.tv$/i, "Twitch"],
  [/(^|\.)music\.apple\.com$/i, "Apple Music"],
  [/(^|\.)podcasts\.apple\.com$/i, "Apple Podcasts"],
  [/(^|\.)bandcamp\.com$/i, "Bandcamp"],
  [/(^|\.)vimeo\.com$/i, "Vimeo"],
  [/(^|\.)tidal\.com$/i, "TIDAL"],
  [/(^|\.)deezer\.com$/i, "Deezer"],
  [/(^|\.)mixcloud\.com$/i, "Mixcloud"],
  [/(^|\.)music\.amazon\.[a-z.]+$/i, "Amazon Music"],
  [/(^|\.)pandora\.com$/i, "Pandora"],
  [/(^|\.)kick\.com$/i, "Kick"],
  [/(^|\.)netflix\.com$/i, "Netflix"],
  [/(^|\.)nts\.live$/i, "NTS"],
  [/(^|\.)lofi\.cafe$/i, "lofi.cafe"],
];

/** The service behind a page, by host: "YouTube Music", else the bare host name. */
export function siteSourceName(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  for (const [pattern, name] of SITE_NAMES) {
    if (pattern.test(host)) return name;
  }
  return host.replace(/^www\./i, "");
}

/**
 * A tab title as a track title: "(3) Song - YouTube" → "Song". Strips an
 * unread-count prefix and a " - Site" / " | Site" suffix naming the service.
 */
export function cleanTabTitle(title: string, siteName: string | null): string {
  let next = title.replace(/^\(\d+\+?\)\s*/, "").trim();
  if (siteName) {
    const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\s*[-–—|·]\\s*${escaped}\\s*$`, "i"), "").trim();
  }
  return next;
}
