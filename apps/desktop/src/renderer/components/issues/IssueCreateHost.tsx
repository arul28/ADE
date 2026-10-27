import React, { lazy, Suspense, useEffect, useState } from "react";
import {
  clearPendingIssueCreateRequest,
  subscribeIssueCreateRequests,
  takePendingIssueCreateRequest,
  type IssueCreateRequest,
} from "../../lib/issueCreateRequests";
// The composer (and its issue-template parsing) loads when someone first asks for it.
const IssueCreateDialog = lazy(() => import("./IssueCreateDialog").then((module) => ({ default: module.IssueCreateDialog })));

/** The "New issue" composer, mounted once in the app shell. */
export function IssueCreateHost() {
  const [request, setRequest] = useState<{ id: number; value: IssueCreateRequest } | null>(null);
  useEffect(() => {
    let next = 0;
    const pending = takePendingIssueCreateRequest();
    if (pending) setRequest({ id: (next += 1), value: pending });
    return subscribeIssueCreateRequests((value) => {
      clearPendingIssueCreateRequest();
      setRequest({ id: (next += 1), value });
    });
  }, []);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <IssueCreateDialog key={request.id} request={request.value} onClose={() => setRequest(null)} />
    </Suspense>
  );
}
