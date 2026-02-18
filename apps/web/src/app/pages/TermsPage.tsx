import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function TermsPage() {
  useDocumentTitle("ADE Terms");

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Terms</h1>
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
            <Reveal delay={0.1}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">Project docs</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  For licensing and detailed system behavior, refer to the repository.
                </p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm">
                  <a className="focus-ring rounded-md text-muted-fg hover:text-fg" href={LINKS.github} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                  <a className="focus-ring rounded-md text-muted-fg hover:text-fg" href={LINKS.docs} target="_blank" rel="noreferrer">
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

