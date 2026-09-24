import { CursorAgentLogo } from "../terminals/ToolLogos";
import { Banner } from "../ui/notice";

/**
 * The pill over the transcript when a Cursor chat has no Cursor runtime. It
 * links to the Cursor provider settings and the user can dismiss it.
 */
export function CursorRuntimeNotice({
  onOpenSettings,
  onDismiss,
}: {
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    // Positions the floating pill at the top center of the transcript only.
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3">
      <div data-testid="cursor-runtime-notice" style={{ display: "contents" }}>
        <Banner
          layout="floating"
          style={{ pointerEvents: "auto", maxWidth: "28rem" }}
          model={{
            id: "cursor-runtime-notice",
            tone: "warning",
            icon: <CursorAgentLogo size={13} />,
            ariaLabel: "Cursor runtime notice",
            title: (
              <>
                Cursor runtime is not available,{" "}
                <button
                  type="button"
                  className="cursor-pointer border-none bg-transparent p-0 text-inherit underline underline-offset-2"
                  onClick={onOpenSettings}
                >
                  click here
                </button>
                {" "}to setup
              </>
            ),
            dismiss: { onDismiss, label: "Dismiss Cursor runtime notice" },
          }}
        />
      </div>
    </div>
  );
}
