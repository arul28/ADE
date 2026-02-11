import React from "react";
import { EmptyState } from "../ui/EmptyState";

export function TerminalsPage() {
  return (
    <div className="h-full">
      <EmptyState title="Terminals" description="Phase 0 implements the session list + xterm wrapper + PTY IPC." />
    </div>
  );
}

