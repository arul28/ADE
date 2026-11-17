import type { CtoLinearQuickView, CtoLinearQuickViewProject, CtoLinearQuickViewTeam } from "../../../shared/types";
import type { IssueTrackerIssueSearchQuery, IssueTrackerIssueSearchResult } from "./issueTracker";
import { isRecord, toOptionalString as asString, asArray } from "../shared/utils";
import type { LinearRequest } from "./linearClientShared";
import { mapLinearQuickViewProject, mapLinearQuickViewTeam } from "../../../shared/linearIssueNormalize";

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
    return asArray(data.projects?.nodes).filter(isRecord).map(mapLinearQuickViewProject);
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
    return asArray(data.teams?.nodes).filter(isRecord).map(mapLinearQuickViewTeam);
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
