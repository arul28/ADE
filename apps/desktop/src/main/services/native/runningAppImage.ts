/**
 * The AppImage file this process was started from, or null. An AppImage's
 * resources and executable sit in a temporary mount; this is the one durable
 * path, and the one fact the install format decisions are made from.
 */
export function runningAppImagePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "linux") return null;
  return env.APPIMAGE?.trim() || null;
}
