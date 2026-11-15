import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AppWindow, Gift } from "lucide-react";

import { Badge } from "../../components/Badge";
import { CopyButton } from "../../components/CopyButton";
import { InstallBlock } from "../../components/home/Hero";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { Section } from "../../components/Section";
import {
  FREE_MONTHLY_HOURS,
  INVITE_ENTER_DAYS,
  INVITE_REWARD_HOURS,
  inviteAppLink,
  inviteCodeFrom,
  lookUpInvite,
  type InviteLookup,
} from "../../lib/invite";
import { MARKETING_CTA_POSITIONS, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

/**
 * `/invite/<code>`: an ADE account's invite to ADE Cloud. Every download
 * option, who invited you, and "Open in ADE" for a computer that already has
 * it (`ade://invite/<code>` fills the code in Settings › Account).
 *
 * Opened from the link an account shares. The code never reaches
 * analytics (the screen is `invite`, the address `/invite`), session replay
 * masks this page's text, and the ad pixel doesn't load here.
 */
export function InvitePage() {
  useDocumentTitle("You're invited to ADE");
  const params = useParams<{ code: string }>();
  const code = inviteCodeFrom(params.code);
  const [lookup, setLookup] = useState<InviteLookup | null>(code ? null : { state: "not_found" });

  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    void lookUpInvite(code, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLookup(result);
    });
    return () => controller.abort();
  }, [code]);

  const found = lookup?.state === "found";
  const invalid = lookup?.state === "not_found";
  const inviter = found && lookup.firstName ? lookup.firstName : null;

  return (
    <Page>
      <Section className="pt-20 sm:pt-24">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <Badge className="bg-card/50">
              <Gift className="h-4 w-4" />
              ADE Cloud invite
            </Badge>
          </Reveal>
          <Reveal delay={0.05}>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-5xl">
              {invalid ? "This invite isn't valid." : inviter ? `Invited by ${inviter}.` : "You're invited to ADE."}
            </h1>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-5 text-pretty text-base leading-relaxed text-muted-fg sm:text-lg">
              {invalid
                ? `You can still get ADE, with ${FREE_MONTHLY_HOURS} free cloud hours every month.`
                : `You both get ${INVITE_REWARD_HOURS} extra free cloud hours, on top of the ${FREE_MONTHLY_HOURS} free every month.`}
            </p>
          </Reveal>

          <Reveal delay={0.12}>
            <InstallBlock position={MARKETING_CTA_POSITIONS.INVITE_PAGE} />
          </Reveal>

          {code && !invalid ? (
            <Reveal delay={0.16}>
              <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card/40 p-5 text-left">
                <p className="text-sm font-medium text-fg">Already have ADE?</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-fg">
                  Open the invite in ADE, or enter the code in Settings › Account within {INVITE_ENTER_DAYS} days of signing up.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <a
                    href={inviteAppLink(code)}
                    data-ade-analytics-feature={MARKETING_FEATURES.OPEN_INVITE_IN_ADE}
                    className="focus-ring inline-flex h-10 items-center gap-2 rounded-full bg-white px-5 text-[14px] font-medium text-black transition-colors hover:bg-white/90"
                  >
                    <AppWindow className="h-4 w-4" /> Open in ADE
                  </a>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border py-1 pl-3 pr-1 font-mono text-[13px] tracking-wider text-fg">
                    {code}
                    <CopyButton value={code} compact label="Copy the invite code" analyticsFeature={MARKETING_FEATURES.COPY_INVITE_CODE} />
                  </span>
                </div>
              </div>
            </Reveal>
          ) : null}
        </div>
      </Section>
    </Page>
  );
}
