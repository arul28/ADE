import { Container } from "../../components/Container";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("ADE — Not found");

  return (
    <Page>
      <section className="py-20">
        <Container>
          <Reveal>
            <div className="rounded-[26px] border border-border bg-card/60 p-10 shadow-glass-sm">
              <div className="text-sm font-semibold text-fg">404</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-fg">Page not found.</h1>
              <p className="mt-3 text-sm leading-relaxed text-muted-fg">
                The page you’re looking for doesn’t exist. Head back to the landing page or download ADE.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <LinkButton to="/" variant="secondary">
                  Home
                </LinkButton>
                <LinkButton to="/download" variant="primary">
                  Download
                </LinkButton>
              </div>
            </div>
          </Reveal>
        </Container>
      </section>
    </Page>
  );
}

