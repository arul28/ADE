import * as Dialog from "@radix-ui/react-dialog";
import { BorderBeam } from "border-beam";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../ui/Button";

export function LaneDialogShell({
  open,
  onOpenChange,
  title,
  description,
  headerExtra,
  icon: Icon,
  widthClassName,
  busy = false,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  headerExtra?: ReactNode;
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  widthClassName?: string;
  busy?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
}) {
  const width = widthClassName ?? "w-[min(720px,calc(100vw-1rem))]";
  const maxHeight = "max-h-[min(92dvh,calc(100vh-1rem))]";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy || next) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 flex ${maxHeight} ${width} -translate-x-1/2 -translate-y-1/2 overflow-hidden focus:outline-none`}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <BorderBeam size="md" colorVariant="mono" duration={25} strength={0.85} borderRadius={12}>
            <div
              className={`relative flex ${maxHeight} min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.1] shadow-float`}
              style={{ backgroundColor: "var(--color-modal-bg, var(--color-card, #1A1830))" }}
            >
              <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent" />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b border-white/[0.06] bg-white/[0.02] px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg sm:text-lg">
                        {Icon ? (
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-accent/[0.12] text-accent">
                            <Icon size={16} />
                          </span>
                        ) : null}
                        <span className="truncate">{title}</span>
                      </Dialog.Title>
                      {headerExtra ? <div className="mt-3 min-w-0">{headerExtra}</div> : null}
                      {description ? (
                        <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-fg sm:max-w-2xl">
                          {description}
                        </Dialog.Description>
                      ) : !headerExtra ? (
                        <Dialog.Description className="sr-only">
                          {title}
                        </Dialog.Description>
                      ) : null}
                    </div>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="sm" className="shrink-0" disabled={busy}>
                        Esc
                      </Button>
                    </Dialog.Close>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3 sm:px-5 sm:py-4">
                  {children}
                </div>
              </div>
            </div>
          </BorderBeam>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
