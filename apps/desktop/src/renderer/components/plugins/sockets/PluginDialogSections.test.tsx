/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES } from "../../../../shared/plugins/sdk";
import type { PluginDialogField, PluginDialogKind } from "../../../../shared/plugins/sockets";
import type { LaneSummary } from "../../../../shared/types";
import { CreateLaneDialog } from "../../lanes/CreateLaneDialog";
import { ManageLaneDialog } from "../../lanes/ManageLaneDialog";
import { PluginDialogSections } from "./PluginDialogSections";
import { resetPluginDialogTargets } from "./dialogTarget";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 64,
        size: 64,
        end: (index + 1) * 64,
        key: index,
        lane: 0,
      })),
    measureElement: () => undefined,
  }),
}));

/**
 * The dialog socket end to end: a manifest declaration, a panel button, and the
 * one verb that reaches back into ADE's own form.
 *
 * The load-bearing assertions are the two that make `{dialog:{setField}}` safe
 * to have at all — that a value lands in CONTROLLED state the user can still
 * edit, and that nothing a plugin can return reaches the dialog's confirmation.
 */

const invoked: { pluginId: string; action: string; args: unknown }[] = [];

let invokeResult: unknown = {};

const PANEL_SCHEMA = {
  v: 1,
  fallback: { title: "Issues", text: "Open the plugin to see this." },
  body: [{ component: "button", label: "Fill it in", onPress: { action: "fill" } }],
};

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    // Manage-lane reads risk previews on open; none of it is what these tests
    // are about, so it answers with the shape and nothing more.
    lanes: {
      getDeleteRisk: async () => null,
      getReclaimRisk: async () => null,
      onDeleteEvent: () => () => {},
      reparent: async () => undefined,
      rename: async () => undefined,
      updateAppearance: async () => undefined,
    },
    plugins: {
      list: async () => [
        {
          pluginId: "issues",
          displayName: "Issues",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "issues",
        version: "1.0.0",
        sockets: [
          {
            socket: "dialog-section",
            surface: "lanes",
            id: "on-create",
            dialog: "create-lane",
            label: "Pick an issue",
            panelId: "picker",
          },
          {
            socket: "dialog-section",
            surface: "lanes",
            id: "on-manage",
            dialog: "manage-lane",
            label: "Move this lane",
            panelId: "restack",
          },
          {
            socket: "dialog-section",
            surface: "prs",
            id: "on-pr",
            dialog: "create-pr",
            label: "Draft the description",
            panelId: "describe",
          },
        ],
      }),
      listContributions: async () => [],
      getPanel: async ({ pluginId, panelId }: { pluginId: string; panelId: string }) => ({
        pluginId,
        panelId,
        title: null,
        schema: PANEL_SCHEMA,
        vocabVersion: 1,
        updatedAt: null,
      }),
      getCollection: async () => [],
      invoke: async (args: { pluginId: string; action: string; args: unknown }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
        return invokeResult;
      },
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
  invokeResult = {};
  resetPluginDialogTargets();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  resetPluginDialogTargets();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

/**
 * A dialog reduced to what the socket contract touches: controlled fields, and
 * a Create button that only its own `onClick` can reach.
 */
function DialogHarness({
  dialog,
  laneName: initialLaneName = "",
  onSubmit,
  reject,
}: {
  dialog: PluginDialogKind;
  laneName?: string;
  onSubmit?: () => void;
  /** Fields the "control" refuses, standing in for a closed list. */
  reject?: readonly string[];
}) {
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [laneName, setLaneName] = React.useState(initialLaneName);

  const setField = React.useCallback((field: PluginDialogField, value: string) => {
    if (reject?.includes(field)) return false;
    setFields((previous) => ({ ...previous, [field]: value }));
    if (field === "name") setLaneName(value);
    return true;
  }, [reject]);

  return (
    <div>
      <input aria-label="Lane name" value={laneName} onChange={(e) => setLaneName(e.target.value)} />
      <div data-testid="fields">{JSON.stringify(fields)}</div>
      <PluginDialogSections
        dialog={dialog}
        laneId="lane-1"
        laneName={laneName}
        branch="refs/heads/feature"
        onSetField={setField}
      />
      <button type="button" onClick={() => onSubmit?.()}>Create</button>
    </div>
  );
}

async function pressPluginButton() {
  const button = await screen.findByText("Fill it in");
  await act(async () => {
    fireEvent.click(button);
  });
}

describe("contributed dialog sections", () => {
  it("draws the section declared for this dialog and no other", async () => {
    render(<DialogHarness dialog="create-lane" />);

    expect(await screen.findByText("Pick an issue")).toBeTruthy();
    // Same surface, different dialog — the payload's `dialog` is what separates
    // create-lane from manage-lane, and it has to.
    expect(screen.queryByText("Move this lane")).toBeNull();
    // Another surface entirely.
    expect(screen.queryByText("Draft the description")).toBeNull();
  });

  it("draws the manage-lane and create-pr sections on their own dialogs", async () => {
    const manage = render(<DialogHarness dialog="manage-lane" />);
    expect(await screen.findByText("Move this lane")).toBeTruthy();
    expect(screen.queryByText("Pick an issue")).toBeNull();
    manage.unmount();

    render(<DialogHarness dialog="create-pr" />);
    expect(await screen.findByText("Draft the description")).toBeTruthy();
  });

  it("invokes with the dialog's values as they read at click time", async () => {
    render(<DialogHarness dialog="manage-lane" laneName="old name" />);
    await screen.findByText("Move this lane");

    // The user renames before pressing the plugin's button.
    fireEvent.change(screen.getByLabelText("Lane name"), { target: { value: "renamed" } });
    await pressPluginButton();

    expect(invoked).toHaveLength(1);
    expect((invoked[0]?.args as { context: unknown }).context).toEqual({
      kind: "dialog",
      dialog: "manage-lane",
      laneId: "lane-1",
      laneName: "renamed",
      // `refs/heads/` is stripped by the shared context builder.
      branch: "feature",
      projectKey: null,
    });
  });

  it("writes an allowlisted field into the dialog's controlled state", async () => {
    invokeResult = { dialog: { setField: { field: "name", value: "ADE-42 refresh tokens" } } };
    render(<DialogHarness dialog="create-lane" />);
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    // The value is in the input, not merely recorded: the user sees it land and
    // can still edit it before pressing Create.
    await waitFor(() => {
      expect((screen.getByLabelText("Lane name") as HTMLInputElement).value)
        .toBe("ADE-42 refresh tokens");
    });
    fireEvent.change(screen.getByLabelText("Lane name"), { target: { value: "my own name" } });
    expect((screen.getByLabelText("Lane name") as HTMLInputElement).value).toBe("my own name");
  });

  it("refuses a field the dialog does not advertise", async () => {
    // `body` is create-PR's, and this is create-lane.
    invokeResult = { dialog: { setField: { field: "body", value: "## Summary" } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<DialogHarness dialog="create-lane" />);
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    expect(await screen.findByText("This plugin couldn’t fill in a field here.")).toBeTruthy();
    expect(screen.getByTestId("fields").textContent).toBe("{}");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accepts on one dialog what it refuses on another", async () => {
    invokeResult = { dialog: { setField: { field: "body", value: "## Summary" } } };
    render(<DialogHarness dialog="create-pr" />);
    await screen.findByText("Draft the description");

    await pressPluginButton();

    await waitFor(() => {
      expect(screen.getByTestId("fields").textContent).toBe(JSON.stringify({ body: "## Summary" }));
    });
  });

  it("drops a value over the per-field ceiling rather than truncating it", async () => {
    const oversize = "x".repeat(PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES + 1);
    invokeResult = { dialog: { setField: { field: "body", value: oversize } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<DialogHarness dialog="create-pr" />);
    await screen.findByText("Draft the description");

    await pressPluginButton();

    expect(await screen.findByText("This plugin couldn’t fill in a field here.")).toBeTruthy();
    // Nothing partial landed — a half-written PR body that then gets created is
    // worse than a field that stayed empty.
    expect(screen.getByTestId("fields").textContent).toBe("{}");
    warn.mockRestore();
  });

  it("says so quietly when the control itself refuses the value", async () => {
    invokeResult = { dialog: { setField: { field: "parentLaneId", value: "not-a-lane" } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<DialogHarness dialog="create-lane" reject={["parentLaneId"]} />);
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    expect(await screen.findByText("This plugin couldn’t fill in a field here.")).toBeTruthy();
    expect(screen.getByTestId("fields").textContent).toBe("{}");
    warn.mockRestore();
  });

  /**
   * The invariant the whole allowlist exists to protect. A response may fill the
   * form in; pressing Create stays the user's, so no combination of verbs may
   * reach the dialog's confirmation.
   */
  it("never submits the dialog, whatever the action responds with", async () => {
    const onSubmit = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeResult = {
      dialog: { setField: { field: "name", value: "filled" } },
      navigate: { panelId: "picker" },
      composer: { replaceText: "not a composer" },
      submit: true,
      confirm: true,
    };
    render(<DialogHarness dialog="create-lane" onSubmit={onSubmit} />);
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    await waitFor(() => {
      expect((screen.getByLabelText("Lane name") as HTMLInputElement).value).toBe("filled");
    });
    expect(onSubmit).not.toHaveBeenCalled();
    // The navigation it also asked for is refused out loud, not silently: a
    // modal form the user is filling in is not a place to be taken away from.
    expect(warn).toHaveBeenCalledWith(
      "[plugin dialog] a dialog section cannot navigate",
      "issues",
      "picker",
    );
    warn.mockRestore();
  });
});

/**
 * The same verb against the real Create-lane dialog, which is where the two
 * halves the harness cannot show meet: the section is mounted after the
 * dialog's own fields, and each field's arm writes the state its own control
 * writes — or refuses, when the control is a closed list.
 */
describe("the create-lane dialog's own fields", () => {
  type DialogProps = Parameters<typeof CreateLaneDialog>[0];

  const lanes = [
    { id: "lane-parent", name: "Parent", branchRef: "refs/heads/parent", laneType: "primary", status: { dirty: false } },
  ] as unknown as DialogProps["lanes"];

  function renderDialog(overrides: Partial<DialogProps> = {}) {
    const props: DialogProps = {
      open: true,
      onOpenChange: vi.fn(),
      createLaneName: "",
      setCreateLaneName: vi.fn(),
      createMode: "primary",
      setCreateMode: vi.fn(),
      createParentLaneId: "",
      setCreateParentLaneId: vi.fn(),
      createBaseSource: "remote",
      setCreateBaseSource: vi.fn(),
      createBaseBranch: "origin/main",
      setCreateBaseBranch: vi.fn(),
      createImportBranch: "",
      setCreateImportBranch: vi.fn(),
      createChildBaseBranch: "",
      setCreateChildBaseBranch: vi.fn(),
      createBranches: [
        {
          name: "main",
          isRemote: false,
          isCurrent: true,
          upstream: "origin/main",
          lastCommitAuthor: "x",
          lastCommitDate: "",
        },
      ] as unknown as DialogProps["createBranches"],
      lanes,
      onSubmit: vi.fn(),
      busy: false,
      error: null,
      envInitProgress: null,
      setupSteps: [],
      templates: [],
      selectedTemplateId: "",
      setSelectedTemplateId: vi.fn(),
      selectedColor: "#999",
      setSelectedColor: vi.fn(),
      selectedLinearIssue: null,
      setSelectedLinearIssue: vi.fn(),
      branchPullRequests: [],
      currentGitUserName: "tester",
      loadingBranches: false,
      loadingBranchPullRequests: false,
      ...overrides,
    };
    render(<CreateLaneDialog {...props} />);
    return props;
  }

  it("mounts the section below the dialog's own fields and fills the lane name", async () => {
    invokeResult = { dialog: { setField: { field: "name", value: "ADE-42 refresh tokens" } } };
    const props = renderDialog();

    expect(await screen.findByText("Pick an issue")).toBeTruthy();
    await pressPluginButton();

    await waitFor(() => {
      expect(props.setCreateLaneName).toHaveBeenCalledWith("ADE-42 refresh tokens");
    });
    // Filling a field is not creating a lane.
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("takes a base branch the select offers and refuses one it does not", async () => {
    invokeResult = { dialog: { setField: { field: "baseBranch", value: "origin/does-not-exist" } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = renderDialog();
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    // A `<select>` handed an option it does not have renders blank, so an
    // unknown ref would EMPTY the control the plugin meant to fill.
    expect(await screen.findByText("This plugin couldn’t fill in a field here.")).toBeTruthy();
    expect(props.setCreateBaseBranch).not.toHaveBeenCalled();

    invokeResult = { dialog: { setField: { field: "baseBranch", value: "origin/main" } } };
    await pressPluginButton();
    await waitFor(() => expect(props.setCreateBaseBranch).toHaveBeenCalledWith("origin/main"));
    warn.mockRestore();
  });

  it("switches to child mode when a parent lane is prefilled", async () => {
    invokeResult = { dialog: { setField: { field: "parentLaneId", value: "lane-parent" } } };
    const props = renderDialog();
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    // The parent select exists only in child mode; setting one without the mode
    // would be a write nothing on screen reflects.
    await waitFor(() => expect(props.setCreateParentLaneId).toHaveBeenCalledWith("lane-parent"));
    expect(props.setCreateMode).toHaveBeenCalledWith("child");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("refuses every field while the lane is being created", async () => {
    invokeResult = { dialog: { setField: { field: "name", value: "too late" } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = renderDialog({ busy: true });
    await screen.findByText("Pick an issue");

    await pressPluginButton();

    expect(await screen.findByText("This plugin couldn’t fill in a field here.")).toBeTruthy();
    expect(props.setCreateLaneName).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * Manage-lane is the awkward one: its writable fields live behind tabs, so a
 * value for a control that is not mounted has to open the tab that holds it and
 * land there. Without that, prefilling a base branch would silently do nothing
 * whenever the user happened to be on the Delete tab — which is the tab it
 * opens on.
 */
describe("the manage-lane dialog's own fields", () => {
  type DialogProps = Parameters<typeof ManageLaneDialog>[0];

  const lane = {
    id: "lane-1",
    name: "Manage tabs",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/manage-tabs",
    worktreePath: "/tmp/ade/manage-tabs",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-05-27T12:00:00.000Z",
    archivedAt: null,
  } as unknown as LaneSummary;

  const primary = {
    ...lane,
    id: "lane-primary",
    name: "Primary",
    laneType: "primary",
    branchRef: "main",
  } as LaneSummary;

  function renderDialog() {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      managedLane: lane,
      allLanes: [primary, lane],
      deleteSelection: { worktree: false, localBranch: false, remoteBranch: false },
      setDeleteSelection: vi.fn(),
      deleteForce: true,
      setDeleteForce: vi.fn(),
      laneActionBusy: false,
      laneActionStatus: null,
      laneActionError: null,
      onArchive: vi.fn(),
      onDelete: vi.fn(),
    } as unknown as DialogProps;
    render(<ManageLaneDialog {...props} />);
    return props;
  }

  function selectedTabLabel(): string | null {
    return screen
      .getAllByRole("tab")
      .find((tab) => tab.getAttribute("aria-selected") === "true")
      ?.textContent ?? null;
  }

  it("opens the tab that holds the field and fills it there", async () => {
    invokeResult = { dialog: { setField: { field: "baseBranch", value: "release/2026-08" } } };
    const props = renderDialog();
    await screen.findByText("Move this lane");
    expect(selectedTabLabel()).toBe("Delete");

    await pressPluginButton();

    await waitFor(() => expect(selectedTabLabel()).toBe("Restack"));
    const input = await waitFor(() => {
      const found = screen.getByPlaceholderText("main") as HTMLInputElement;
      if (found.value !== "release/2026-08") throw new Error("waiting for the queued value");
      return found;
    });
    // Controlled and still the user's: Apply is a separate press.
    fireEvent.change(input, { target: { value: "main" } });
    expect(input.value).toBe("main");
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("refuses a parent lane the restack select is not offering", async () => {
    invokeResult = { dialog: { setField: { field: "parentLaneId", value: "lane-not-here" } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderDialog();
    await screen.findByText("Move this lane");

    await pressPluginButton();

    expect(await screen.findByText("This plugin couldn’t fill in a field here.")).toBeTruthy();
    warn.mockRestore();
  });
});
