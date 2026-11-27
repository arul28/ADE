import { findAndReplace } from "mdast-util-find-and-replace";
import { buildDeeplink } from "../../../../shared/deeplinks";
import { proseIssueKeyPattern } from "../../../../shared/issueRefs";

type MarkdownRoot = Parameters<typeof findAndReplace>[0];

/** `ADE` for `ADE-123`. */
export function linearTeamOf(identifier: string): string {
  return identifier.slice(0, identifier.lastIndexOf("-"));
}

/** Links `#123` to this repo's PR, `@user` to the profile, and the workspace's Linear keys to the issue. */
export function remarkPrAutolinks({
  repoOwner,
  repoName,
  linearTeamKeys,
}: {
  repoOwner: string;
  repoName: string;
  linearTeamKeys: readonly string[];
}) {
  const teams = new Set(linearTeamKeys);
  return (tree: MarkdownRoot) => {
    findAndReplace(
      tree,
      [
        [
          /(^|[\s(\[{>])#(\d+)\b/g,
          (_full: string, prefix: string, num: string) =>
            [
              { type: "text", value: prefix },
              {
                type: "link",
                url: `https://github.com/${repoOwner}/${repoName}/pull/${num}`,
                children: [{ type: "text", value: `#${num}` }],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
        ],
        [
          /(^|[\s(\[{>])@([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/g,
          (_full: string, prefix: string, user: string) =>
            [
              { type: "text", value: prefix },
              {
                type: "link",
                url: `https://github.com/${user}`,
                children: [{ type: "text", value: `@${user}` }],
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
        ],
        [
          // Only the workspace's own team keys link, so `UTF-8` and `SHA-256`
          // stay text. An ADE link: it opens ADE's issue viewer here, and ADE
          // from anywhere it is copied to.
          proseIssueKeyPattern(),
          (full: string) =>
            teams.has(linearTeamOf(full))
              ? ({
                type: "link",
                url: buildDeeplink({ kind: "linear-issue", issueIdentifier: full }),
                children: [{ type: "text", value: full }],
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any)
              : false,
        ],
      ],
      { ignore: ["link", "linkReference", "code", "inlineCode"] },
    );
  };
}
