/**
 * `GET /releases/latest`: the newest published ADE build on each track. Path
 * and response shape only: nothing here imports the Worker, so ADE Web can
 * import it (the phone reads the same two keys).
 *
 * Takes the account bearer. Not under `/cloud`: every signed-in account may
 * read it.
 */
export const LATEST_RELEASES_PATH = "/releases/latest";

/** A version per track, or null when that track was never read. */
export type LatestReleasesResponse = {
  stable: string | null;
  beta: string | null;
};
