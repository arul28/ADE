/**
 * The account server's address for the website: the configured
 * `VITE_ADE_ACCOUNT_DIRECTORY_URL`, or production. Kept free of
 * `import.meta.env` so `vite.config.ts` can use it too.
 */
const DEFAULT_ACCOUNT_DIRECTORY = "https://ade-account-directory-production.arulsharma1028.workers.dev";

export function accountDirectoryBase(configured: string | undefined): string {
  return (configured?.trim() || DEFAULT_ACCOUNT_DIRECTORY).replace(/\/+$/, "");
}
