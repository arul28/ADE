/**
 * A render's contact sheet, shared by the Apple and Android Render sheets.
 */

/** Tile labelled shots into one PNG, for PR descriptions. */
export async function deviceRenderContactSheet(shots: Array<{ dataUrl: string; label: string }>): Promise<string | null> {
  if (!shots.length) return null;
  const images = await Promise.all(shots.map((shot) => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = shot.dataUrl;
  })));
  const columns = Math.min(3, images.length);
  const rows = Math.ceil(images.length / columns);
  const cell = 520;
  const label = 36;
  const canvas = document.createElement("canvas");
  canvas.width = columns * cell;
  canvas.height = rows * (cell + label);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#16161b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((image, index) => {
    const x = (index % columns) * cell;
    const y = Math.floor(index / columns) * (cell + label);
    const scale = Math.min(cell / image.width, cell / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, x + (cell - w) / 2, y + (cell - h) / 2, w, h);
    ctx.fillStyle = "#c9c9d2";
    ctx.font = "500 18px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(shots[index]!.label, x + cell / 2, y + cell + 24);
  });
  return canvas.toDataURL("image/png");
}
