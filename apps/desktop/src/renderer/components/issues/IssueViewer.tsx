import React from "react";
import { GitHubIssueViewer } from "./GitHubIssueViewer";
import type { IssueViewerProps } from "./issueViewerParts";
import { LinearIssueViewer } from "./LinearIssueViewer";
import "./issueViewer.css";

export type { IssueViewerProps } from "./issueViewerParts";

/**
 * One issue, with the chrome every issue surface shares: a 40px header
 * (provider, id, state, refresh, open on the web, copy menu), the issue view,
 * and an action dock. The Work tools pane's Issues tab and the issue sheet
 * both render this; only their containers differ.
 */
export function IssueViewer(props: IssueViewerProps) {
  if (props.issueRef.provider === "linear") {
    return <LinearIssueViewer {...props} identifier={props.issueRef.identifier} />;
  }
  return <GitHubIssueViewer {...props} githubRef={props.issueRef} />;
}
