/** Strip the `refs/heads/` prefix so lane refs and PR head branches compare directly. */
export function branchNameFromRef(ref: string | null | undefined): string {
  return String(ref ?? "").replace(/^refs\/heads\//, "").trim();
}
