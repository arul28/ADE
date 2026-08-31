/**
 * Compiling installed plugins' URL matchers, and running them.
 *
 * The grammar's own tests live in `urlMatchers.test.ts`. This file proves the
 * three things that only exist once matchers meet a registry and a URL: the
 * tier order, what a match is allowed to produce, and that installing,
 * enabling, disabling and switching off one contribution all change the answer
 * without anything having to be reloaded.
 */

import { describe, expect, it } from "vitest";

import { deriveSmartLinkPreview, findSmartLinks } from "../smartLinks";
import { pluginRegistrationContributionKey } from "./disabledContributions";
import {
  compileSmartLinkMatchers,
  issueProviderOwnersFromMatchers,
  matchSmartLinkMatchers,
  smartLinkPluginMatcher,
  type SmartLinkMatcherSource,
} from "./smartLinkMatchers";
import type { PluginManifestUrlMatcher } from "./urlMatchers";

const JIRA_MATCHER: PluginManifestUrlMatcher = {
  id: "issue",
  hosts: ["acme.atlassian.net"],
  pathPattern: "/browse/{key}",
  chip: { label: "JIRA {key}", icon: "JR" },
  panelId: "issue",
  entity: { kind: "issue", provider: "jira", keyFrom: "key" },
};

function source(overrides: Partial<SmartLinkMatcherSource> = {}): SmartLinkMatcherSource {
  return {
    pluginId: "acme-jira",
    enabled: true,
    urlMatchers: [JIRA_MATCHER],
    tabs: [{ panelId: "issue" }],
    ...overrides,
  };
}

/** Match one URL through the compiled set, the way the parser's tier does. */
function match(url: string, sources: readonly SmartLinkMatcherSource[]) {
  return matchSmartLinkMatchers(new URL(url), url, compileSmartLinkMatchers(sources));
}

describe("compiling a registry", () => {
  it("produces a chip, a deeplink and an issue ref from one match", () => {
    const preview = match("https://acme.atlassian.net/browse/ACME-12", [source()]);
    expect(preview).toEqual({
      url: "https://acme.atlassian.net/browse/ACME-12",
      provider: "plugin:acme-jira",
      kind: "plugin_entity",
      label: "JIRA ACME-12",
      glyph: "JR",
      plugin: {
        pluginId: "acme-jira",
        matcherId: "issue",
        // Built by `buildDeeplink`, so the context is percent-encoded exactly
        // once — the same bytes `ade link --ctx` and iOS mint.
        deeplink: "ade://plugin/acme-jira/issue?ctx="
          + "%7B%22issue%22%3A%7B%22provider%22%3A%22jira%22%2C%22key%22%3A%22ACME-12%22%7D%7D",
        issue: { provider: "jira", key: "ACME-12" },
      },
    });
  });

  it("declines a URL whose host it does not claim", () => {
    expect(match("https://other.example.com/browse/ACME-12", [source()])).toBeNull();
    expect(match("https://acme.atlassian.net/projects/ACME", [source()])).toBeNull();
  });

  it("applies the wildcard host rule the network guard uses", () => {
    const wildcard = [source({ urlMatchers: [{ ...JIRA_MATCHER, hosts: ["*.atlassian.net"] }] })];
    expect(match("https://acme.atlassian.net/browse/A-1", wildcard)).not.toBeNull();
    expect(match("https://a.b.atlassian.net/browse/A-1", wildcard)).not.toBeNull();
    // The wildcard does not cover the apex, and `evilatlassian.net` cannot
    // borrow the suffix.
    expect(match("https://atlassian.net/browse/A-1", wildcard)).toBeNull();
    expect(match("https://evilatlassian.net/browse/A-1", wildcard)).toBeNull();
  });

  it("declines rather than drawing an empty chip", () => {
    // Every capture the template named rendered to nothing. A box the user
    // cannot read is worse than the plain link, so the generic tier gets it.
    const blank = [source({
      urlMatchers: [{ ...JIRA_MATCHER, chip: { label: "{key}" } }],
    })];
    const preview = matchSmartLinkMatchers(
      new URL("https://acme.atlassian.net/browse/%00"),
      "https://acme.atlassian.net/browse/%00",
      compileSmartLinkMatchers(blank),
    );
    expect(preview).toBeNull();
  });

  it("omits the issue ref when the matcher declares no entity", () => {
    const noEntity = [source({
      urlMatchers: [{ id: "doc", hosts: ["acme.example.com"], pathPattern: "/d/{slug}", chip: { label: "Doc {slug}" } }],
    })];
    const preview = match("https://acme.example.com/d/plan", noEntity);
    expect(preview?.plugin?.issue).toBeUndefined();
    expect(preview?.plugin?.deeplink).toBe("ade://plugin/acme-jira/issue");
  });

  it("falls back to a panel the plugin publishes when the matcher names none", () => {
    const noPanel = [source({
      urlMatchers: [{ ...JIRA_MATCHER, panelId: undefined }],
      tabs: [{ panelId: "board" }],
    })];
    expect(match("https://acme.atlassian.net/browse/A-1", noPanel)?.plugin?.deeplink)
      .toContain("/acme-jira/board");
  });

  it("drops a matcher that no longer compiles rather than throwing", () => {
    // The manifest parser already refused it with a reason. Refusing it a second
    // time here, inside a render, would turn a bad manifest into a blank composer.
    const broken = [source({
      urlMatchers: [{ ...JIRA_MATCHER, pathPattern: "/browse/(.*)" }, JIRA_MATCHER],
    })];
    const compiled = compileSmartLinkMatchers(broken);
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.matcherId).toBe("issue");
  });
});

describe("ordering", () => {
  it("gives the first match within the plugin tier, over a stable sort", () => {
    // Sorted by plugin id, not by install order: the registry's order differs
    // between two machines with the same plugins, and a chip that reads
    // differently on a laptop than on a desktop is unreproducible.
    const both: SmartLinkMatcherSource[] = [
      source({
        pluginId: "zeta",
        urlMatchers: [{ ...JIRA_MATCHER, chip: { label: "Z {key}" } }],
      }),
      source({
        pluginId: "alpha",
        urlMatchers: [{ ...JIRA_MATCHER, chip: { label: "A {key}" } }],
      }),
    ];
    expect(match("https://acme.atlassian.net/browse/A-1", both)?.label).toBe("A A-1");
    expect(match("https://acme.atlassian.net/browse/A-1", [...both].reverse())?.label).toBe("A A-1");
  });

  it("lets core win ahead of the whole plugin tier", () => {
    // The manifest parser refuses a core-owned host, so a matcher for
    // `github.com` cannot exist. This proves the second half of the same
    // guarantee, enforced where the match actually happens.
    const impostor = [source({
      urlMatchers: [{
        id: "gh",
        hosts: ["github.com"],
        pathPattern: "/{owner}/{repo}/pull/{number}",
        chip: { label: "MINE {number}" },
      }],
    })];
    const options = { matchPlugin: smartLinkPluginMatcher(compileSmartLinkMatchers(impostor)) };
    const preview = deriveSmartLinkPreview("https://github.com/ade/ade/pull/7", options);
    expect(preview?.provider).toBe("github");
    expect(preview?.label).toBe("ade/ade#7");
  });

  it("runs ahead of the generic fallback, which would otherwise claim everything", () => {
    const options = { matchPlugin: smartLinkPluginMatcher(compileSmartLinkMatchers([source()])) };
    const url = "https://acme.atlassian.net/browse/ACME-12";
    expect(deriveSmartLinkPreview(url)?.provider).toBe("generic");
    expect(deriveSmartLinkPreview(url, options)?.provider).toBe("plugin:acme-jira");
  });

  it("never lets a throwing matcher reach the caller", () => {
    // Compiled from an untrusted manifest, and run inside a keystroke handler.
    const options = {
      matchPlugin: () => {
        throw new Error("boom");
      },
    };
    expect(deriveSmartLinkPreview("https://example.com/x", options)?.provider).toBe("generic");
    expect(findSmartLinks("see https://example.com/x", 12, options)).toHaveLength(1);
  });

  it("finds plugin links inside a sentence, with their spans", () => {
    const options = { matchPlugin: smartLinkPluginMatcher(compileSmartLinkMatchers([source()])) };
    const text = "fixing https://acme.atlassian.net/browse/ACME-12 today";
    const [found] = findSmartLinks(text, 12, options);
    expect(found?.label).toBe("JIRA ACME-12");
    expect(text.slice(found!.start, found!.end)).toBe("https://acme.atlassian.net/browse/ACME-12");
  });
});

describe("live registry changes", () => {
  const url = "https://acme.atlassian.net/browse/ACME-12";

  it("stops matching when the plugin is disabled", () => {
    expect(match(url, [source({ enabled: true })])).not.toBeNull();
    expect(match(url, [source({ enabled: false })])).toBeNull();
  });

  it("stops matching when the user switches off that one contribution", () => {
    const off = source({
      disabledContributions: [pluginRegistrationContributionKey("urlMatcher", "issue")],
    });
    expect(match(url, [off])).toBeNull();
    // A different matcher's key does not switch this one off.
    const other = source({
      disabledContributions: [pluginRegistrationContributionKey("urlMatcher", "other")],
    });
    expect(match(url, [other])).not.toBeNull();
  });

  it("matches nothing at all when no plugin is installed", () => {
    expect(compileSmartLinkMatchers([])).toEqual([]);
    expect(matchSmartLinkMatchers(new URL(url), url, [])).toBeNull();
  });
});

describe("tracker ownership", () => {
  it("names the plugin that declared the provider, and the panel that draws it", () => {
    expect(issueProviderOwnersFromMatchers([source()])).toEqual([
      { provider: "jira", pluginId: "acme-jira", panelId: "issue" },
    ]);
  });

  it("ignores a matcher that declares no entity", () => {
    const noEntity = source({
      urlMatchers: [{ id: "doc", hosts: ["a.example.com"], pathPattern: "/d/{s}", chip: { label: "{s}" } }],
    });
    expect(issueProviderOwnersFromMatchers([noEntity])).toEqual([]);
  });

  it("resolves two plugins claiming one tracker the same way on every machine", () => {
    const contenders: SmartLinkMatcherSource[] = [
      source({ pluginId: "zeta" }),
      source({ pluginId: "alpha" }),
    ];
    expect(issueProviderOwnersFromMatchers(contenders)).toHaveLength(1);
    expect(issueProviderOwnersFromMatchers(contenders)[0]?.pluginId).toBe("alpha");
    expect(issueProviderOwnersFromMatchers([...contenders].reverse())[0]?.pluginId).toBe("alpha");
  });

  it("keeps a disabled plugin's claim, so the refusal can name it", () => {
    // Ownership and chip-drawing are different questions. A disabled plugin must
    // not draw chips, but it is still what the reader installed for this
    // tracker; hiding it turns "Jira is switched off" into "nothing reads jira".
    expect(issueProviderOwnersFromMatchers([source({ enabled: false })])).toEqual([
      { provider: "jira", pluginId: "acme-jira", panelId: "issue" },
    ]);
  });

  it("never lets a disabled plugin block an enabled one on the same tracker", () => {
    const contenders: SmartLinkMatcherSource[] = [
      source({ pluginId: "alpha", enabled: false }),
      source({ pluginId: "zeta", enabled: true }),
    ];
    expect(issueProviderOwnersFromMatchers(contenders)[0]?.pluginId).toBe("zeta");
    expect(issueProviderOwnersFromMatchers([...contenders].reverse())[0]?.pluginId).toBe("zeta");
  });

  it("drops a claim the user switched off in the contributions rail", () => {
    const off = source({
      disabledContributions: [pluginRegistrationContributionKey("urlMatcher", "issue")],
    });
    expect(issueProviderOwnersFromMatchers([off])).toEqual([]);
  });
});
