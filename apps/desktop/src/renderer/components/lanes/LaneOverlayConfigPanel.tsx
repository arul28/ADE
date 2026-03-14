import { useEffect, useState } from "react";
import type { LaneOverlayOverrides } from "../../../shared/types";

export function LaneOverlayConfigPanel({ laneId }: { laneId: string }) {
  const [overlay, setOverlay] = useState<LaneOverlayOverrides | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.ade.lanes
      .getOverlay({ laneId })
      .then((result) => {
        if (!cancelled) setOverlay(result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [laneId]);

  if (loading) return <div className="text-xs text-muted-fg p-2">Loading overlay...</div>;

  if (!overlay) {
    return (
      <div className="text-xs text-muted-fg/60 p-2">
        No overlay policies applied to this lane.
      </div>
    );
  }

  const envKeys = overlay.env ? Object.keys(overlay.env) : [];
  const hasOverrides =
    envKeys.length > 0 ||
    overlay.cwd ||
    overlay.portRange ||
    overlay.proxyHostname ||
    overlay.computeBackend ||
    overlay.processIds ||
    overlay.testSuiteIds ||
    overlay.envInit;

  if (!hasOverrides) {
    return (
      <div className="text-xs text-muted-fg/60 p-2">
        No overlay policies applied to this lane.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-2">
      <div className="text-xs font-medium">Active Overlay</div>

      {overlay.portRange && (
        <div className="text-xs">
          <span className="text-muted-fg">Port range:</span>{" "}
          <span className="font-mono">{overlay.portRange.start}\u2013{overlay.portRange.end}</span>
        </div>
      )}

      {overlay.proxyHostname && (
        <div className="text-xs">
          <span className="text-muted-fg">Hostname:</span>{" "}
          <span className="font-mono">{overlay.proxyHostname}</span>
        </div>
      )}

      {overlay.computeBackend && (
        <div className="text-xs">
          <span className="text-muted-fg">Backend:</span>{" "}
          <span className="capitalize">{overlay.computeBackend}</span>
        </div>
      )}

      {overlay.cwd && (
        <div className="text-xs">
          <span className="text-muted-fg">CWD:</span>{" "}
          <span className="font-mono truncate">{overlay.cwd}</span>
        </div>
      )}

      {envKeys.length > 0 && (
        <div className="text-xs">
          <div className="text-muted-fg mb-1">Environment ({envKeys.length}):</div>
          <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
            {Object.entries(overlay.env!).map(([key, value]) => (
              <div key={key} className="font-mono text-[11px] flex gap-1">
                <span className="text-muted-fg">{key}=</span>
                <span className="truncate">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {overlay.envInit && (
        <div className="text-xs">
          <div className="text-muted-fg mb-1">Env init config:</div>
          {overlay.envInit.envFiles && overlay.envInit.envFiles.length > 0 && (
            <div className="text-[11px] text-muted-fg">
              {overlay.envInit.envFiles.length} env file(s)
            </div>
          )}
          {overlay.envInit.docker && (
            <div className="text-[11px] text-muted-fg">Docker compose configured</div>
          )}
          {overlay.envInit.dependencies && overlay.envInit.dependencies.length > 0 && (
            <div className="text-[11px] text-muted-fg">
              {overlay.envInit.dependencies.length} install command(s)
            </div>
          )}
          {overlay.envInit.mountPoints && overlay.envInit.mountPoints.length > 0 && (
            <div className="text-[11px] text-muted-fg">
              {overlay.envInit.mountPoints.length} mount point(s)
            </div>
          )}
        </div>
      )}

      {overlay.processIds && overlay.processIds.length > 0 && (
        <div className="text-xs">
          <span className="text-muted-fg">Processes:</span> {overlay.processIds.join(", ")}
        </div>
      )}

      {overlay.testSuiteIds && overlay.testSuiteIds.length > 0 && (
        <div className="text-xs">
          <span className="text-muted-fg">Test suites:</span> {overlay.testSuiteIds.join(", ")}
        </div>
      )}
    </div>
  );
}
