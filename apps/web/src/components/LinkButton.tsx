import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/cn";
import { ANALYTICS_FEATURE_ATTRIBUTE, type MarketingFeature } from "../lib/marketingAnalytics";
import { buttonClassName } from "./Button";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

export function LinkButton({
  to,
  variant = "primary",
  size = "md",
  className,
  analyticsFeature,
  children,
  ...props
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  analyticsFeature?: MarketingFeature;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const isExternal = /^https?:\/\//.test(to);

  const classes = cn(buttonClassName(variant, size), className);
  const analyticsProps = analyticsFeature ? { [ANALYTICS_FEATURE_ATTRIBUTE]: analyticsFeature } : {};

  if (isExternal) {
    return (
      <a className={classes} href={to} {...analyticsProps} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link className={classes} to={to} {...analyticsProps} {...props}>
      {children}
    </Link>
  );
}
