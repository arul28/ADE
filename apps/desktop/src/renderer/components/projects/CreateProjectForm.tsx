import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { CircleNotch, FolderOpen, Warning } from "@phosphor-icons/react";
import type {
  CreateProjectInput,
  CreateProjectResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
} from "../../../shared/types";
import { extractError } from "../../lib/format";
import { abbreviateHome, arePathsEqual, normalizePath } from "../../lib/pathUtils";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

export type CreateProjectFormProps = {
  onCancel: () => void;
  onCreated: (result: {
    rootPath: string;
    displayName: string;
    projectId?: string;
  }) => void;
  machineName?: string;
  getDefaultParentDir?: () => Promise<string>;
  browseDirectories?: (
    input: ProjectBrowseInput,
  ) => Promise<ProjectBrowseResult>;
  chooseDirectory?:
    | ((args: {
        title: string;
        defaultPath?: string;
      }) => Promise<string | null>)
    | null;
  createProject?: (
    input: CreateProjectInput,
  ) => Promise<CreateProjectResult & { projectId?: string }>;
};

type NameValidation = { ok: true } | { ok: false; reason: string };

function validateName(rawName: string): NameValidation {
  const name = rawName.trim();
  if (name.length === 0) return { ok: false, reason: "Enter a project name" };
  if (name.length > 100)
    return { ok: false, reason: "Name must be 100 characters or fewer" };
  if (name.startsWith("."))
    return { ok: false, reason: "Name cannot start with a dot" };
  if (/[/\\]/.test(name))
    return { ok: false, reason: "Name cannot contain / or \\" };
  return { ok: true };
}

export function joinParentAndName(parent: string, name: string): string {
  const trimmedParent = parent.trim();
  const trimmedName = name.trim();
  if (!trimmedParent) return trimmedName;
  if (!trimmedName) return normalizePath(trimmedParent);
  const stripped = trimmedParent.replace(/[\\/]+$/, "");
  return normalizePath(`${stripped}/${trimmedName}`);
}

const inputStyle: CSSProperties = {
  height: 40,
  padding: "0 12px",
  fontSize: 14,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

export function CreateProjectForm({
  onCancel,
  onCreated,
  machineName,
  getDefaultParentDir,
  browseDirectories,
  chooseDirectory,
  createProject,
}: CreateProjectFormProps) {
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState<string>("");
  const [parentDirLoading, setParentDirLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathExists, setPathExists] = useState(false);
  const [pickerPending, setPickerPending] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const checkRequestRef = useRef(0);
  const loadDefaultParentDir =
    getDefaultParentDir ?? window.ade.project.getDefaultParentDir;
  const browse = browseDirectories ?? window.ade.project.browseDirectories;
  const pickDirectory =
    chooseDirectory === undefined
      ? window.ade.project.chooseDirectory
      : chooseDirectory;
  const create = createProject ?? window.ade.project.createLocal;

  useEffect(() => {
    let cancelled = false;
    void loadDefaultParentDir()
      .then((value) => {
        if (cancelled) return;
        setParentDir(value);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        setParentDirLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadDefaultParentDir]);

  const validation = useMemo(() => validateName(name), [name]);
  const trimmedName = name.trim();
  const previewPath = useMemo(
    () => (parentDir && trimmedName ? joinParentAndName(parentDir, trimmedName) : ""),
    [parentDir, trimmedName],
  );
  const locationDisplay = parentDirLoading
    ? "Finding a default folder…"
    : previewPath
      ? abbreviateHome(previewPath)
      : parentDir
        ? abbreviateHome(parentDir)
        : "Choose a folder";

  useEffect(() => {
    if (!previewPath || !validation.ok) {
      setPathExists(false);
      return;
    }
    const requestId = ++checkRequestRef.current;
    const timeout = window.setTimeout(() => {
      void browse({ partialPath: previewPath })
        .then((result) => {
          if (checkRequestRef.current !== requestId) return;
          setPathExists(
            Boolean(
              result.exactDirectoryPath &&
                arePathsEqual(result.exactDirectoryPath, previewPath),
            ),
          );
        })
        .catch(() => {
          if (checkRequestRef.current !== requestId) return;
          setPathExists(false);
        });
    }, 220);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [browse, previewPath, validation.ok]);

  const showNameError = !validation.ok && (submitAttempted || name.length > 0);
  const canSubmit =
    validation.ok &&
    parentDir.length > 0 &&
    !pathExists &&
    !pending &&
    !parentDirLoading;

  const handleChooseParent = useCallback(async () => {
    if (!pickDirectory) return;
    setPickerPending(true);
    setError(null);
    try {
      const selected = await pickDirectory({
        title: "Choose where to create the project",
        defaultPath: parentDir || undefined,
      });
      if (selected) {
        setParentDir(selected);
      }
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPickerPending(false);
    }
  }, [parentDir, pickDirectory]);

  const handleSubmit = useCallback(async () => {
    setSubmitAttempted(true);
    if (!validation.ok || !parentDir || pathExists) return;
    setPending(true);
    setError(null);
    try {
      const result = await create({
        name: trimmedName,
        parentDir,
      });
      const projectId =
        "projectId" in result && typeof result.projectId === "string"
          ? result.projectId
          : undefined;
      onCreated({
        rootPath: result.rootPath,
        displayName: trimmedName,
        projectId,
      });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPending(false);
    }
  }, [create, onCreated, parentDir, pathExists, trimmedName, validation.ok]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        width: "100%",
      }}
    >
      <Field label="Name">
        <input
          autoFocus
          type="text"
          value={name}
          placeholder="my-new-project"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          style={inputStyle}
          disabled={pending}
          aria-label="Project name"
        />
        {showNameError && !validation.ok ? (
          <InlineHint tone="danger">{validation.reason}</InlineHint>
        ) : (
          <InlineHint tone="muted">This becomes the folder name.</InlineHint>
        )}
      </Field>

      {machineName ? (
        <InlineHint tone="muted">Creating on {machineName}</InlineHint>
      ) : null}

      <Field label="Location">
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <button
            type="button"
            onClick={() => {
              void handleChooseParent();
            }}
            disabled={pickerPending || pending || !pickDirectory}
            aria-label="Change project location"
            title={previewPath || parentDir || "Choose a folder"}
            style={{
              ...inputStyle,
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              textAlign: "left",
              cursor: pickDirectory ? "pointer" : "default",
              fontFamily: MONO_FONT,
              fontSize: 12,
              color: parentDir ? COLORS.textPrimary : COLORS.textMuted,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {locationDisplay}
            </span>
          </button>
          {pickDirectory ? (
            <button
              type="button"
              style={{
                ...outlineButton({ minWidth: 108, height: 40 }),
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
              disabled={pickerPending || pending}
              onClick={() => {
                void handleChooseParent();
              }}
            >
              {pickerPending ? (
                <CircleNotch size={13} weight="bold" className="animate-spin" />
              ) : (
                <FolderOpen size={14} weight="regular" />
              )}
              Change
            </button>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            type="text"
            value={parentDir}
            onChange={(event) => setParentDir(event.target.value)}
            placeholder={parentDirLoading ? "Loading…" : "Parent folder"}
            aria-label="Parent folder"
            style={{
              ...inputStyle,
              height: 34,
              fontFamily: MONO_FONT,
              fontSize: 12,
              color: parentDir ? COLORS.textPrimary : COLORS.textMuted,
            }}
            disabled={pending || parentDirLoading}
          />
          {pathExists ? (
            <InlineHint tone="danger">A folder already exists at that path</InlineHint>
          ) : (
            <InlineHint tone="muted">
              Default is fine — Change or edit the folder if you want it somewhere else.
            </InlineHint>
          )}
        </div>
      </Field>

      {error ? <InlineHint tone="danger">{error}</InlineHint> : null}

      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 4,
        }}
      >
        <button
          type="button"
          style={outlineButton()}
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          style={primaryButton({
            opacity: canSubmit ? 1 : 0.55,
            cursor: canSubmit ? "pointer" : "not-allowed",
            minWidth: 108,
          })}
          onClick={() => {
            void handleSubmit();
          }}
          disabled={!canSubmit}
        >
          {pending ? (
            <>
              <CircleNotch size={12} weight="bold" className="animate-spin" />
              Creating…
            </>
          ) : (
            "Create and open"
          )}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span
        style={{
          ...LABEL_STYLE,
          letterSpacing: "0.04em",
          fontSize: 11,
          color: COLORS.textMuted,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function InlineHint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "danger" | "muted";
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontFamily: SANS_FONT,
        lineHeight: 1.4,
        color: tone === "danger" ? COLORS.danger : COLORS.textMuted,
      }}
    >
      {tone === "danger" ? <Warning size={12} weight="fill" /> : null}
      {children}
    </span>
  );
}
