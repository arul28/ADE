import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { LINKS } from "../../lib/links";
import { ANALYTICS_FEATURE_ATTRIBUTE, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

const UPDATED_DATE = "November 24, 2026";

export function TermsPage() {
  useDocumentTitle("ADE Terms");

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Terms</h1>
            <p className="mt-3 text-sm text-muted-fg">Updated {UPDATED_DATE}</p>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-fg">
              ADE is under active development. This site is informational and the project’s repository (license and docs)
              is the authoritative reference.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-6">
            <Reveal>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">Software availability</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  Desktop builds are distributed via GitHub Releases. You can also build from source. Features and APIs may
                  change as the project evolves.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.05}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">Responsibility</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  ADE operates on your local repository and can run commands and processes. Review changes and diffs,
                  especially those suggested by hosted or BYOK LLM providers, before applying them.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.08}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">ADE Cloud: ads, age and fair use</div>
                <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-fg">
                  <p>
                    The ADE Cloud Free plan is ad-supported. Chats on ADE Cloud computers may show a sponsored card from
                    Gravity (IRIS Inc.), ADE’s ad partner, labeled “Sponsored”, and an agent may suggest a sponsored
                    tool. In the United States the cards start on and ADE tells you so; elsewhere they show only after
                    you agree. You can turn them off at any time in Settings › ADE Cloud; Small computers on Free then
                    use credits. Chats on your own computer and paid plans have no ads.{" "}
                    <a className="focus-ring rounded-md text-fg underline underline-offset-2" href="/privacy#sponsored">
                      The Privacy page
                    </a>{" "}
                    lists what is shared with Gravity.
                  </p>
                  <p>ADE Cloud is for people 18 or older.</p>
                  <p>
                    “Unlimited Small computers” is subject to fair use. ADE may limit an account whose use is far
                    outside normal development work, for example running an always-on service, mining, or automated
                    traffic. ADE gives notice where possible.
                  </p>
                  <p>
                    ADE gives no rewards for viewing or clicking ads. You must not view or click ads automatically,
                    or for pay.
                  </p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">Project docs</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  For licensing and detailed system behavior, refer to the repository.
                </p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm">
                  <a className="focus-ring rounded-md text-muted-fg hover:text-fg" href={LINKS.github} {...{ [ANALYTICS_FEATURE_ATTRIBUTE]: MARKETING_FEATURES.VIEW_GITHUB }} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                  <a className="focus-ring rounded-md text-muted-fg hover:text-fg" href={LINKS.docs} {...{ [ANALYTICS_FEATURE_ATTRIBUTE]: MARKETING_FEATURES.VIEW_DOCS }} target="_blank" rel="noreferrer">
                    Docs
                  </a>
                </div>
              </div>
            </Reveal>
          </div>
        </Container>
      </section>
    </Page>
  );
}
