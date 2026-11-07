/**
 * Calls `connect` until it answers or `waitMs` passes. A machine that just
 * woke or signed in refuses for a few seconds before its ADE answers. `value`
 * is null when the time ran out or `stillWanted` turned false; `lastError`
 * says why it didn't connect.
 */
export async function connectWithRetry<T>(args: {
  connect: () => Promise<T | null | undefined>;
  stillWanted: () => boolean;
  waitMs: number;
  retryMs: number;
}): Promise<{ value: T | null; lastError: unknown }> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (args.stillWanted() && Date.now() - startedAt < args.waitMs) {
    try {
      const value = await args.connect();
      if (value) return { value, lastError: null };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, args.retryMs));
  }
  return { value: null, lastError };
}
