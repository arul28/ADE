import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Container } from "./Container";

export function Section({
  id,
  className,
  containerClassName,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  id?: string;
  containerClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("relative py-16 sm:py-20", id ? "scroll-mt-24" : undefined, className)}
      {...props}
    >
      <Container className={cn(containerClassName)}>{children}</Container>
    </section>
  );
}

