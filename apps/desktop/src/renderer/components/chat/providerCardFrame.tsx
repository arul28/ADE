import type { KeyboardEvent, ReactNode, Ref } from "react";
import { providerBrand, providerThemeVars } from "../settings/providers/providerBrand";
import { SignInBrandLogo } from "../settings/providers/signInSheetParts";
import "./integrationConnectCard.css";

/**
 * A provider's card above the prompt box (the sign-in card, the Claude pass
 * card, the account-switch card): the provider's banner with its art, its
 * logo (`turn` spins it once, the success moment), the heading and the
 * banner's tools, then the body.
 */
export function ProviderCardFrame({
  brandId,
  heading,
  turn = false,
  art = true,
  tools,
  onKeyDown,
  testId,
  provider,
  signInCard = false,
  rootRef,
  children,
}: {
  /** The `providerBrand` id. */
  brandId: string;
  heading: string;
  turn?: boolean;
  /** Draw the brand's banner art (the account-switch card has none). */
  art?: boolean;
  /** The banner's right end: chips, then the buttons. */
  tools: ReactNode;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  testId: string;
  /** `data-provider`, when the card is about one provider's sign-in. */
  provider?: string;
  /** `data-sign-in-card`: the card asks for a sign-in. */
  signInCard?: boolean;
  rootRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const brand = providerBrand(brandId);
  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={heading}
      data-testid={testId}
      data-provider={provider}
      data-sign-in-card={signInCard ? "true" : undefined}
      className="ade-icc"
      data-light={brand.lightBanner ? "true" : undefined}
      style={{ ...providerThemeVars(brand), ["--ig-accent" as string]: brand.accent }}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="ade-icc-banner" style={brand.banner}>
        {art && brand.bannerArt ? (
          <img className="ade-icc-banner-art ade-psc-banner-art" src={brand.bannerArt.src} alt="" draggable={false} style={{ opacity: brand.bannerArt.opacity ?? 1 }} />
        ) : null}
        <div className="ade-icc-banner-shade" aria-hidden />
        <span className="ade-icc-logo"><SignInBrandLogo providerId={brandId} size={25} turn={turn} /></span>
        <span className="ade-icc-heading">
          <span className="ade-icc-heading-text"><span className="ade-icc-title">{heading}</span></span>
        </span>
        <span className="ade-icc-banner-tools">{tools}</span>
      </div>
      <div className="ade-icc-body">{children}</div>
    </div>
  );
}
