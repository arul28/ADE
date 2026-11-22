/** Errnos that mean this account may not read or write a path (permissions, read-only media). */
const ACCESS_REFUSAL_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS"]);

/** Whether `error` is the file system refusing this account access, not a missing path or a defect. */
export function isFsAccessRefusal(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && ACCESS_REFUSAL_CODES.has(code);
}
