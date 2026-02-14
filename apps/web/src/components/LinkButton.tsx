import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/cn";
import { buttonClassName } from "./Button";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

export function LinkButton({
  to,
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const isExternal = /^https?:\/\//.test(to);

  const classes = cn(buttonClassName(variant, size), className);

  if (isExternal) {
    return (
      <a className={classes} href={to} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link className={classes} to={to} {...props}>
      {children}
    </Link>
  );
}
