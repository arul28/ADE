/**
 * Stream a whole file's bytes via readFileRange. Each range comes back as base64
 * of an INDEPENDENT byte slice, so chunks must be decoded individually and their
 * byte arrays concatenated — joining the base64 strings first and decoding once
 * corrupts the stream (a non-final chunk whose length isn't a multiple of 3 is
 * `=`-padded, and that padding lands mid-string).
 */
export async function streamFileBytes(
  workspaceId: string,
  path: string,
  opts: { chunkLength?: number; isCancelled?: () => boolean; maxBytes?: number } = {},
): Promise<Uint8Array> {
  const chunkLength = opts.chunkLength ?? 512 * 1024;
  const parts: Uint8Array[] = [];
  let total = 0;
  let next: number | null = 0;
  let guard = 0;
  while (next != null) {
    const page = await window.ade.files.readFileRange({ workspaceId, path, offset: next, length: chunkLength });
    if (opts.isCancelled?.()) return new Uint8Array();
    if (page.content) {
      let bytes: Uint8Array;
      if (page.encoding === "base64") {
        const binary = atob(page.content);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(page.content);
      }
      if (opts.maxBytes != null && total + bytes.length > opts.maxBytes) {
        throw new Error(`File is too large to stream into memory (${opts.maxBytes} byte limit).`);
      }
      parts.push(bytes);
      total += bytes.length;
    }
    next = page.nextOffset;
    if (++guard > 100_000) break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
