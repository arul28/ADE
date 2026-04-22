import { Container } from "../../components/Container";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function PrivacyPage() {
  useDocumentTitle("ADE Privacy");

  return (
    <Page>
      <section className="py-16 sm:py-20">
        <Container>
          <Reveal>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Privacy</h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-fg">
              This page is a practical summary of ADE’s privacy posture based on the project documentation. For the source
              of truth, see the security and architecture docs in the repository.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-6">
            <Reveal>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">Local-first by design</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  ADE’s core capabilities (worktrees, git operations, terminals, processes, tests) run locally. The Electron
                  main process is the trusted component with filesystem and process access; the UI is isolated and uses
                  typed IPC calls.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.05}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">Hosted agent is read-only</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  When you enable ADE Cloud features, the hosted side mirrors content and produces narratives and patch
                  proposals. It never mutates your repository; it returns diffs that you review and apply locally.
                </p>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="rounded-[22px] border border-border bg-card/60 p-6 shadow-glass-sm">
                <div className="text-sm font-semibold text-fg">More details</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-fg">
                  See the repository docs for implementation details (trust boundaries, data model, hosted mirror
                  protocol, and security considerations).
                </p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm">
                  <a className="focus-ring rounded-md text-muted-fg hover:text-fg" href={LINKS.docs} target="_blank" rel="noreferrer">
                    Docs
                  </a>
                  <a className="focus-ring rounded-md text-muted-fg hover:text-fg" href={LINKS.prd} target="_blank" rel="noreferrer">
                    PRD
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

