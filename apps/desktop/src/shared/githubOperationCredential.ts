export const GITHUB_OPERATION_CREDENTIAL_PRECEDENCE = [
  "environment",
  "gh",
  "pat",
] as const;

type GithubOperationCredentialSource =
  (typeof GITHUB_OPERATION_CREDENTIAL_PRECEDENCE)[number];

type CredentialResolvers<T> = Record<
  GithubOperationCredentialSource,
  () => T | null
>;

type AsyncCredentialResolvers<T> = Record<
  GithubOperationCredentialSource,
  () => T | null | Promise<T | null>
>;

export function selectGithubOperationCredential<T>(
  resolvers: CredentialResolvers<T>,
): T | null {
  for (const source of GITHUB_OPERATION_CREDENTIAL_PRECEDENCE) {
    const credential = resolvers[source]();
    if (credential) return credential;
  }
  return null;
}

export async function selectGithubOperationCredentialAsync<T>(
  resolvers: AsyncCredentialResolvers<T>,
): Promise<T | null> {
  for (const source of GITHUB_OPERATION_CREDENTIAL_PRECEDENCE) {
    const candidate = resolvers[source]();
    const credential = candidate instanceof Promise ? await candidate : candidate;
    if (credential) return credential;
  }
  return null;
}
