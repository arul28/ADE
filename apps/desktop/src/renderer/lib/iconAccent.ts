// Derives a warm, project-specific accent color from a resolved icon's
// dataUrl by sampling its dominant saturated pixels. Shared by the TopBar
// project tabs and the RunPage welcome recents list so both surfaces tint
// their icon tiles with the same color the logo would suggest.

const PROJECT_ICON_ACCENT_CACHE_MAX = 48;
const projectIconAccentCache = new Map<string, string | null>();

function setProjectIconAccentCache(
  cacheKey: string,
  color: string | null,
): void {
  if (projectIconAccentCache.has(cacheKey)) {
    projectIconAccentCache.delete(cacheKey);
  } else if (projectIconAccentCache.size >= PROJECT_ICON_ACCENT_CACHE_MAX) {
    const oldestKey = projectIconAccentCache.keys().next().value;
    if (oldestKey !== undefined) projectIconAccentCache.delete(oldestKey);
  }
  projectIconAccentCache.set(cacheKey, color);
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function balancedAccentColor(red: number, green: number, blue: number): string {
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  let mixTarget = 0;
  let mixAmount = 0;
  if (luminance < 64) {
    mixTarget = 255;
    mixAmount = 0.34;
  } else if (luminance > 214) {
    mixTarget = 0;
    mixAmount = 0.22;
  }
  const mix = (channel: number) => channel + (mixTarget - channel) * mixAmount;
  return `#${toHexByte(mix(red))}${toHexByte(mix(green))}${toHexByte(mix(blue))}`;
}

export async function deriveIconAccentColor(
  dataUrl: string,
): Promise<string | null> {
  if (projectIconAccentCache.has(dataUrl))
    return projectIconAccentCache.get(dataUrl) ?? null;
  if (typeof document === "undefined" || typeof Image === "undefined")
    return null;

  const color = await new Promise<string | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const width = Math.max(
          1,
          Math.min(24, image.naturalWidth || image.width || 24),
        );
        const height = Math.max(
          1,
          Math.min(24, image.naturalHeight || image.height || 24),
        );
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        let redTotal = 0;
        let greenTotal = 0;
        let blueTotal = 0;
        let weightTotal = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3] / 255;
          if (alpha < 0.25) continue;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          const max = Math.max(red, green, blue);
          const min = Math.min(red, green, blue);
          const saturation = max === 0 ? 0 : (max - min) / max;
          const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          if (saturation < 0.08 && (luminance < 28 || luminance > 230))
            continue;
          const weight = alpha * (0.18 + saturation * 1.65);
          redTotal += red * weight;
          greenTotal += green * weight;
          blueTotal += blue * weight;
          weightTotal += weight;
        }
        if (weightTotal <= 0) {
          resolve(null);
          return;
        }
        resolve(
          balancedAccentColor(
            redTotal / weightTotal,
            greenTotal / weightTotal,
            blueTotal / weightTotal,
          ),
        );
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });

  setProjectIconAccentCache(dataUrl, color);
  return color;
}
