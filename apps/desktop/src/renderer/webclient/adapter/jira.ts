import type {
  JiraComment,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraCreateMeta,
  JiraIssueDetail,
  JiraIssuePage,
  JiraListIssuesArgs,
  JiraProject,
  JiraTransition,
  JiraUpdateIssueArgs,
  JiraUser,
} from "../../../shared/types/jira";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

/** Jira calls use the selected host's machine credential through sync commands. */
export function createJiraNamespace(infra: AdapterInfra): AdeNamespace<"jira"> {
  const { commands } = infra;
  // A read carries a fallback; a mutation has none — its fallback could never
  // be resolved — so the two shapes stay disjoint at the wrapper too.
  const mutation = { idempotent: false } as const;

  function call<T>(action: string, args: Record<string, unknown>, pin: RuntimePinArg, idempotent: boolean): Promise<T> {
    assertWebRuntimePinRoutable(`jira.${action}`, pin, infra);
    const fallback = () => {
      throw new Error(`Jira action '${action}' is unavailable on the connected ADE host.`);
    };
    return idempotent
      ? commands.call<T>(`jira.${action}`, args, { fallback })
      : commands.call<T>(`jira.${action}`, args, mutation);
  }

  return {
    getConnectionStatus: (pin?: RuntimePinArg): Promise<JiraConnectionStatus> => {
      assertWebRuntimePinRoutable("jira.getConnectionStatus", pin, infra);
      return commands.call("jira.getConnectionStatus", {}, {
        fallback: {
          connected: false,
          siteUrl: null,
          email: null,
          account: null,
          error: null,
          checkedAt: null,
        },
        idempotent: true,
      });
    },
    connect: (args: JiraConnectArgs, pin?: RuntimePinArg) => call<JiraConnectionStatus>("connect", args as unknown as Record<string, unknown>, pin, false),
    disconnect: (pin?: RuntimePinArg) => call<JiraConnectionStatus>("disconnect", {}, pin, false),
    listProjects: (args: { query?: string } = {}, pin?: RuntimePinArg) => call<JiraProject[]>("listProjects", args, pin, true),
    listIssues: (args: JiraListIssuesArgs = {}, pin?: RuntimePinArg) => call<JiraIssuePage>("listIssues", args as unknown as Record<string, unknown>, pin, true),
    getIssue: (args: { key: string }, pin?: RuntimePinArg) => call<JiraIssueDetail>("getIssue", args, pin, true),
    listComments: (args: { key: string; cursor: string | null }, pin?: RuntimePinArg) =>
      call<{ comments: JiraComment[]; nextCursor: string | null }>("listComments", args, pin, true),
    addComment: (args: { key: string; body: string }, pin?: RuntimePinArg) => call<JiraComment>("addComment", args, pin, false),
    updateIssue: (args: JiraUpdateIssueArgs, pin?: RuntimePinArg) => call<void>("updateIssue", args as unknown as Record<string, unknown>, pin, false),
    listTransitions: (args: { key: string }, pin?: RuntimePinArg) => call<JiraTransition[]>("listTransitions", args, pin, true),
    transitionIssue: (args: { key: string; transitionId: string }, pin?: RuntimePinArg) => call<void>("transitionIssue", args, pin, false),
    listAssignableUsers: (args: { projectKey?: string; key?: string; query?: string } = {}, pin?: RuntimePinArg) =>
      call<JiraUser[]>("listAssignableUsers", args, pin, true),
    listLabels: (args: { query?: string } = {}, pin?: RuntimePinArg) => call<string[]>("listLabels", args, pin, true),
    getCreateMeta: (args: { projectKey: string }, pin?: RuntimePinArg) => call<JiraCreateMeta>("getCreateMeta", args, pin, true),
    createIssue: (args: JiraCreateIssueArgs, pin?: RuntimePinArg) =>
      call<JiraCreateIssueResult>("createIssue", args as unknown as Record<string, unknown>, pin, false),
  };
}
