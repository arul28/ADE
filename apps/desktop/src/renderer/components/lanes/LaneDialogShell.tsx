import * as Dialog from "@radix-ui/react-dialog";
import { BorderBeam } from "border-beam";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../ui/Button";

export function LaneDialogShell({
  open,
  onOpenChange,
  title,
  description,
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
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  widthClassName?: string;
  busy?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy || next) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={`fixed left-1/2 top-[14%] z-50 -translate-x-1/2 focus:outline-none ${widthClassName ?? "w-[min(680px,calc(100vw-24px))]"}`}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <BorderBeam size="md" colorVariant="mono" duration={25} strength={0.85} borderRadius={12}>
            <div className="relative rounded-xl border border-white/[0.06] bg-bg/80 p-4 shadow-float backdrop-blur-xl">
              <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-fg">
                    {Icon ? (
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-accent">
                        <Icon size={16} />
                      </span>
                    ) : null}
                    <span className="truncate">{title}</span>
                  </Dialog.Title>
                  {description ? (
                    <Dialog.Description className="mt-2 max-w-2xl text-sm leading-6 text-muted-fg">
                      {description}
                    </Dialog.Description>
                  ) : (
                    <Dialog.Description className="sr-only">
                      {title}
                    </Dialog.Description>
                  )}
                </div>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm" disabled={busy}>
                    Esc
                  </Button>
                </Dialog.Close>
              </div>
              {children}
            </div>
          </BorderBeam>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
