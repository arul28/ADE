import type { ComponentType, ReactNode } from "react";
import { Dialog } from "../ui/dialog";

export function LaneDialogShell({
  open,
  onOpenChange,
  title,
  titleContent,
  description,
  headerExtra,
  icon: Icon,
  width,
  height,
  busy = false,
  onCloseAutoFocus,
  children,
  footer,
  scrollBody = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Replaces the default title text while keeping `title` for the accessible name. */
  titleContent?: ReactNode;
  description?: string;
  headerExtra?: ReactNode;
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  width?: number | string;
  height?: number | string;
  busy?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * When false, the body does not scroll — the child owns the only scrollport.
   * Default stays auto so existing dialogs keep their current layout.
   */
  scrollBody?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!busy || next) onOpenChange(next); }}
      title={title}
      titleContent={titleContent}
      description={description}
      headerExtra={headerExtra}
      icon={Icon ? <Icon size={16} /> : undefined}
      width={width ?? "min(720px, calc(100vw - 1rem))"}
      height={height}
      maxHeight="min(92dvh, calc(100vh - 1rem))"
      scrollBody={scrollBody}
      dismissible={!busy}
      footer={footer}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {children}
    </Dialog>
  );
}
