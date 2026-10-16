import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import type { JiraConnectArgs } from "../../../shared/types/jira";

export const JIRA_SITE_URL_KEY = "jira.siteUrl";
export const JIRA_EMAIL_KEY = "jira.email";
export const JIRA_API_TOKEN_KEY = "jira.apiToken";

export type JiraCredentialService = ReturnType<typeof createJiraCredentialService>;

export function createJiraCredentialService(args: {
  credentialStore: SyncCredentialStore;
}) {
  return {
    getCredentials(): JiraConnectArgs | null {
      const siteUrl = args.credentialStore.getSync(JIRA_SITE_URL_KEY)?.trim();
      const email = args.credentialStore.getSync(JIRA_EMAIL_KEY)?.trim();
      const apiToken = args.credentialStore.getSync(JIRA_API_TOKEN_KEY);
      return siteUrl && email && apiToken ? { siteUrl, email, apiToken } : null;
    },
    setCredentials(credentials: JiraConnectArgs): void {
      args.credentialStore.updateSync?.((values) => {
        values[JIRA_SITE_URL_KEY] = credentials.siteUrl;
        values[JIRA_EMAIL_KEY] = credentials.email;
        values[JIRA_API_TOKEN_KEY] = credentials.apiToken;
      });
      if (!args.credentialStore.updateSync) {
        args.credentialStore.setSync(JIRA_SITE_URL_KEY, credentials.siteUrl);
        args.credentialStore.setSync(JIRA_EMAIL_KEY, credentials.email);
        args.credentialStore.setSync(JIRA_API_TOKEN_KEY, credentials.apiToken);
      }
    },
    clearCredentials(): void {
      args.credentialStore.updateSync?.((values) => {
        delete values[JIRA_SITE_URL_KEY];
        delete values[JIRA_EMAIL_KEY];
        delete values[JIRA_API_TOKEN_KEY];
      });
      if (!args.credentialStore.updateSync) {
        args.credentialStore.deleteSync(JIRA_SITE_URL_KEY);
        args.credentialStore.deleteSync(JIRA_EMAIL_KEY);
        args.credentialStore.deleteSync(JIRA_API_TOKEN_KEY);
      }
    },
  };
}
