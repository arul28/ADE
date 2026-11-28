import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { LINKS } from "../../lib/links";
import { ANALYTICS_FEATURE_ATTRIBUTE, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

const UPDATED_DATE = "November 28, 2026";

/** The plain sections of the page, in order. The ads and project-docs cards follow them. */
const sections: Array<{ title: string; body: string[] }> = [
  {
    title: "Accepting these terms",
    body: [
      "By creating a DAEX account, signing in, or using DAEX's apps, DAEX Cloud or this website, you agree to these Terms and to the Privacy Policy. If you do not agree, do not use DAEX.",
    ],
  },
  {
    title: "Your account and your data",
    body: [
      "DAEX needs an account. You are responsible for what happens under your account and for keeping your sign-in methods safe.",
      "You let DAEX handle your data as the Privacy Policy describes. That includes: saving your GitHub CLI login and the logins of AI coding tools on your computers to your DAEX account so your other computers and DAEX Cloud can use them; sending short parts of your chats and terminals to the Smart decisions model; keeping the sync data and DAEX Cloud data the policy lists; sending product analytics, error reports and diagnostic reports; and, while ads are on in DAEX Cloud, sending parts of DAEX Cloud chats to Gravity for those ads.",
      "You can turn off the features that have a switch, as the Privacy Policy's “Your choices” section says, and you can delete your account at any time.",
    ],
  },
  {
    title: "Other services",
    body: [
      "DAEX works with services you choose, such as AI providers, GitHub, Linear and AI coding tools. Their own terms apply to your use of them. You are responsible for using your logins and keys with DAEX, on your computers and on DAEX Cloud, in a way those terms allow.",
    ],
  },
  {
    title: "No warranty",
    body: [
      "DAEX is provided as is, without warranties of any kind, to the extent the law allows. Agents can make mistakes and can run commands on your computers.",
    ],
  },
  {
    title: "Changes to these terms",
    body: [
      "DAEX may change these Terms. When it does, it updates the date on this page. If you keep using DAEX after a change, you accept the changed Terms.",
    ],
  },
  {
    title: "Software availability",
    body: [
      "Desktop builds are distributed via GitHub Releases. You can also build from source. Features and APIs may change as the project evolves.",
    ],
  },
  {
    title: "Responsibility",
    body: [
      "DAEX operates on your local repository and can run commands and processes. Review changes and diffs, especially those suggested by hosted or BYOK LLM providers, before applying them.",
    ],
  },
];

export function TermsPage() {
  useDocumentTitle("DAEX Terms");

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Terms</h1>
            <p className="mt-3 text-sm text-muted-fg">Updated {UPDATED_DATE}</p>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-fg">
              DAEX (formerly ADE) is under active development. These Terms and the Privacy Policy apply to your use of DAEX. The
              project’s repository holds the software license and the technical docs.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-6">
            {sections.map((section) => (
              <Reveal key={section.title}>
                <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                  <div className="text-sm font-semibold text-fg">{section.title}</div>
                  <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-fg">
                    {section.body.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
            <Reveal delay={0.08}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">DAEX Cloud: ads, age and fair use</div>
                <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-fg">
                  <p>
                    DAEX Cloud chats show ads for accounts that have ads on: an ad from Gravity (IRIS Inc.), DAEX’s ad
                    partner, labeled “Sponsored”, and an agent may suggest a sponsored tool. In the United States, except
                    California, ads start on and DAEX tells you so; in California and the other countries where DAEX offers
                    ads, they show only after you agree. You can turn them off at any time in Settings › DAEX Cloud. With ads
                    on, DAEX Cloud costs less: Small computers on Free are free, and where DAEX Cloud shows an ad price, a
                    computer uses it while you use a DAEX Cloud chat on it. With ads off, Small computers on Free use
                    credits. In apps that do not show an ad price, ads keep Small computers free only while, in the last 7
                    days, you turned them on or opened a DAEX Cloud chat from the United States; otherwise, outside the
                    United States included, they use credits until you next open one there. Chats on your own computer have
                    no ads.{" "}
                    <a className="focus-ring rounded-md text-fg underline underline-offset-2" href="/privacy#sponsored">
                      The Privacy page
                    </a>{" "}
                    lists what is shared with Gravity.
                  </p>
                  <p>DAEX Cloud is for people 18 or older.</p>
                  <p>
                    “Unlimited Small computers” is subject to fair use. DAEX may limit an account whose use is far
                    outside normal development work, for example running an always-on service, mining, or automated
                    traffic. DAEX gives notice where possible.
                  </p>
                  <p>
                    DAEX gives no rewards for viewing or clicking ads. You must not view or click ads automatically,
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
