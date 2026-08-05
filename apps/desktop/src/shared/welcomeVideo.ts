export const ADE_WELCOME_VIDEO_ID = "64E0pViEiB8";
export const ADE_WELCOME_VIDEO_VERSION = 1;
export const ADE_WELCOME_VIDEO_REPLAY_EVENT = "ade:welcome-video:replay";

export const ADE_WELCOME_VIDEO_WATCH_URL = `https://www.youtube.com/watch?v=${ADE_WELCOME_VIDEO_ID}`;
// The packaged app loads its shell from a file:// URL, which YouTube's embed
// player rejects as an unrecognized/unauthorized origin (error 153). So we
// don't embed a player at all -- just show its thumbnail and hand off to the
// system browser, which has a real https origin.
export const ADE_WELCOME_VIDEO_THUMBNAIL_URL =
  `https://img.youtube.com/vi/${ADE_WELCOME_VIDEO_ID}/maxresdefault.jpg`;
