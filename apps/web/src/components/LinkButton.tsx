import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/cn";
import {
  ANALYTICS_CTA_ATTRIBUTE,
  ANALYTICS_CTA_POSITION_ATTRIBUTE,
  ANALYTICS_FEATURE_ATTRIBUTE,
  type MarketingCtaLabel,
  type MarketingCtaPosition,
  type MarketingFeature,
} from "../lib/marketingAnalytics";
import { buttonClassName } from "./Button";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

export function LinkButton({
  to,
  variant = "primary",
  size = "md",
  className,
  analyticsFeature,
  analyticsCta,
  analyticsPosition,
  children,
  ...props
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  analyticsFeature?: MarketingFeature;
  analyticsCta?: MarketingCtaLabel;
  analyticsPosition?: MarketingCtaPosition;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const isExternal = /^https?:\/\//.test(to);

  const classes = cn(buttonClassName(variant, size), className);
  const analyticsProps = analyticsFeature ? { [ANALYTICS_FEATURE_ATTRIBUTE]: analyticsFeature } : {};
  const ctaProps = analyticsCta && analyticsPosition
    ? {
        [ANALYTICS_CTA_ATTRIBUTE]: analyticsCta,
        [ANALYTICS_CTA_POSITION_ATTRIBUTE]: analyticsPosition,
      }
    : {};

  if (isExternal) {
    return (
      <a className={classes} href={to} {...analyticsProps} {...ctaProps} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link className={classes} to={to} {...analyticsProps} {...ctaProps} {...props}>
      {children}
    </Link>
  );
}
