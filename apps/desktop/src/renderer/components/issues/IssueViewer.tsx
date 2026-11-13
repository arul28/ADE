import React from "react";
import { GitHubIssueViewer } from "./GitHubIssueViewer";
import { JiraIssueViewer } from "./JiraIssueViewer";
import type { IssueViewerProps } from "./issueViewerParts";
import { LinearIssueViewer } from "./LinearIssueViewer";
import { useActiveRepositoryReader } from "../../state/repositoryScope";
import "./issueViewer.css";

export type { IssueViewerProps } from "./issueViewerParts";

/**
 * One issue, with the chrome every issue surface shares: a 40px header
 * (provider, id, state, refresh, open on the web, copy menu), the issue view,
 * and an action dock. The Work tools pane's Issues tab and the issue sheet
 * both render this; only their containers differ.
 */
export function IssueViewer(props: IssueViewerProps) {
  // Jira answers through one machine's connection: the chat's machine when
  // the issue came from a chat there, else the repository reader. Null means
  // no machine is online.
  const readerPin = useActiveRepositoryReader();
  if (props.issueRef.provider === "linear") {
    return <LinearIssueViewer {...props} identifier={props.issueRef.identifier} />;
  }
  if (props.issueRef.provider === "github") {
    return <GitHubIssueViewer {...props} githubRef={props.issueRef} />;
  }
  // Keyed by machine: a viewer opened for the same issue from another machine
  // starts clean, and a read still in flight for the old one cannot land here.
  const jiraPin = props.pin ?? readerPin;
  return <JiraIssueViewer key={jiraPin?.key ?? "none"} {...props} pin={jiraPin} jiraRef={props.issueRef} />;
}
