import type { CtoLinearQuickView, CtoLinearQuickViewProject, CtoLinearQuickViewTeam } from "../../../shared/types";
import type { IssueTrackerIssueSearchQuery, IssueTrackerIssueSearchResult } from "./issueTracker";
import { isRecord, toOptionalString as asString, asArray } from "../shared/utils";
import type { LinearRequest } from "./linearClientShared";

/** The Linear pane's overview: viewer, organization, projects, teams, and recent/assigned issues. */
export function createLinearQuickView({ request, searchIssues }: {
  request: LinearRequest;
  searchIssues: (params: IssueTrackerIssueSearchQuery) => Promise<IssueTrackerIssueSearchResult>;
}) {
  // One raw query per surface with every field selected inline. The SDK's
  // lazy relations (project.status / lead / teams) cost a request each, which
  // was ~150 requests for 50 projects.
  const fetchQuickViewProjects = async (): Promise<CtoLinearQuickViewProject[]> => {
    const data = await request<{ projects?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query QuickViewProjects {
          projects(first: 50, includeArchived: false) {
            nodes {
              id
              name
              slugId
              url
              color
              icon
              description
              health
              progress
              scope
              priority
              priorityLabel
              startDate
              targetDate
              issueCountHistory
              completedIssueCountHistory
              status { name type }
              lead { id name displayName }
              teams(first: 4) { nodes { key name } }
            }
          }
        }
      `,
      maxRetries: 2,
    });
    return asArray(data.projects?.nodes).filter(isRecord).map((project) => {
      const status = isRecord(project.status) ? project.status : null;
      const lead = isRecord(project.lead) ? project.lead : null;
      const teamNodes = asArray(isRecord(project.teams) ? project.teams.nodes : []).filter(isRecord);
      const teamName = teamNodes
        .map((team) => asString(team.name))
        .find((entry): entry is string => Boolean(entry?.trim())) ?? "Unassigned";
      const teamKey = teamNodes
        .map((team) => asString(team.key))
        .find((entry): entry is string => Boolean(entry?.trim())) ?? null;
      return {
        id: String(project.id ?? ""),
        name: String(project.name ?? "Untitled project"),
        slug: String(project.slugId ?? ""),
        teamName,
        ...(teamKey ? { teamKey } : {}),
        url: asString(project.url),
        color: asString(project.color),
        icon: asString(project.icon),
        description: asString(project.description),
        statusName: status ? asString(status.name) : null,
        statusType: status ? asString(status.type) : null,
        health: asString(project.health),
        progress: typeof project.progress === "number" ? project.progress : null,
        scope: typeof project.scope === "number" ? project.scope : null,
        priority: typeof project.priority === "number" ? project.priority : null,
        priorityLabel: asString(project.priorityLabel),
        // Weekly snapshot, not a live count. Live counts come from countIssues.
        issueCount: Array.isArray(project.issueCountHistory) ? Number(project.issueCountHistory.at(-1) ?? 0) : null,
        completedIssueCount: Array.isArray(project.completedIssueCountHistory)
          ? Number(project.completedIssueCountHistory.at(-1) ?? 0)
          : null,
        startDate: asString(project.startDate),
        targetDate: asString(project.targetDate),
        leadName: lead ? (asString(lead.displayName) ?? asString(lead.name)) : null,
        teamKeys: teamNodes.map((team) => asString(team.key)).filter((entry): entry is string => Boolean(entry)),
      };
    });
  };

  const fetchQuickViewTeams = async (): Promise<CtoLinearQuickViewTeam[]> => {
    const data = await request<{ teams?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query QuickViewTeams {
          teams(first: 8, includeArchived: false) {
            nodes { id key name displayName color issueCount cyclesEnabled private }
          }
        }
      `,
      maxRetries: 2,
    });
    return asArray(data.teams?.nodes).filter(isRecord).map((team) => ({
      id: String(team.id ?? ""),
      key: String(team.key ?? ""),
      name: String(team.name ?? "Team"),
      displayName: String(team.displayName ?? team.name ?? "Team"),
      color: asString(team.color),
      issueCount: typeof team.issueCount === "number" ? team.issueCount : null,
      cyclesEnabled: typeof team.cyclesEnabled === "boolean" ? team.cyclesEnabled : null,
      private: typeof team.private === "boolean" ? team.private : null,
    }));
  };

  const getQuickView = async (connection: CtoLinearQuickView["connection"]): Promise<CtoLinearQuickView> => {
    const [viewerData, organizationData, projects, teams, recentIssuesResult, assignedIssuesResult] = await Promise.all([
      request<{ viewer?: Record<string, unknown> }>({
        query: `query QuickViewViewer { viewer { id name displayName email avatarUrl admin guest url } }`,
        maxRetries: 2,
      }),
      request<{ organization?: Record<string, unknown> }>({
        query: `
          query QuickViewOrganization {
            organization {
              id name urlKey logoUrl gitBranchFormat createdIssueCount
              roadmapEnabled customersEnabled releasesEnabled
            }
          }
        `,
        maxRetries: 1,
      }).catch(() => null),
      fetchQuickViewProjects().catch(() => [] as CtoLinearQuickViewProject[]),
      fetchQuickViewTeams().catch(() => [] as CtoLinearQuickViewTeam[]),
      searchIssues({ first: 12, includeArchived: false }).catch(() => null),
      searchIssues({ first: 12, includeArchived: false, assignedToViewer: true }).catch(() => null),
    ]);
    const viewer = isRecord(viewerData.viewer) ? viewerData.viewer : {};
    const organization = isRecord(organizationData?.organization) ? organizationData.organization : null;

    return {
      connection,
      organization: organization ? {
        id: String(organization.id ?? ""),
        name: String(organization.name ?? "Linear"),
        urlKey: asString(organization.urlKey),
        logoUrl: asString(organization.logoUrl),
        gitBranchFormat: asString(organization.gitBranchFormat),
        createdIssueCount: typeof organization.createdIssueCount === "number" ? organization.createdIssueCount : null,
        roadmapEnabled: typeof organization.roadmapEnabled === "boolean" ? organization.roadmapEnabled : null,
        customersEnabled: typeof organization.customersEnabled === "boolean" ? organization.customersEnabled : null,
        releasesEnabled: typeof organization.releasesEnabled === "boolean" ? organization.releasesEnabled : null,
      } : null,
      viewer: {
        id: String(viewer.id ?? ""),
        name: String(viewer.name ?? viewer.displayName ?? "Linear user"),
        displayName: String(viewer.displayName ?? viewer.name ?? "Linear user"),
        email: asString(viewer.email),
        avatarUrl: asString(viewer.avatarUrl),
        admin: typeof viewer.admin === "boolean" ? viewer.admin : null,
        guest: typeof viewer.guest === "boolean" ? viewer.guest : null,
        url: asString(viewer.url),
      },
      projects: projects.filter((project) => project.id && project.slug),
      teams: teams.filter((team) => team.id && team.key),
      assignedIssues: assignedIssuesResult?.issues ?? [],
      recentIssues: recentIssuesResult?.issues ?? [],
      fetchedAt: new Date().toISOString(),
      sdk: {
        packageName: "@linear/sdk",
        surfaces: [
          "viewer",
          "organization",
          "projects",
          "teams",
          "assignedIssues",
          "issues",
          "project.status",
          "project.lead",
        ],
      },
    };
  };

  return { getQuickView };
}
