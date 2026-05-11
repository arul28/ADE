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
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
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

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const sep = parent.includes("\\") ? "\\" : "/";
  const trimmed =
    parent.endsWith("/") || parent.endsWith("\\")
      ? parent.slice(0, -1)
      : parent;
  if (!name) return trimmed;
  return `${trimmed}${sep}${name}`;
}

const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  fontSize: 13,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
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
    () => (parentDir && trimmedName ? joinPath(parentDir, trimmedName) : ""),
    [parentDir, trimmedName],
  );

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
          setPathExists(Boolean(result.exactDirectoryPath === previewPath));
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
        title: "Choose parent directory",
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
        gap: 16,
        width: "100%",
      }}
    >
      <Field label="PROJECT NAME">
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
        />
        {showNameError && !validation.ok ? (
          <InlineHint tone="danger">{validation.reason}</InlineHint>
        ) : null}
      </Field>

      {machineName ? (
        <InlineHint tone="muted">Target: {machineName}</InlineHint>
      ) : null}

      <Field label="PARENT DIRECTORY">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={parentDir}
            onChange={(event) => setParentDir(event.target.value)}
            placeholder={parentDirLoading ? "Loading…" : "Parent directory"}
            style={{
              ...inputStyle,
              fontFamily: MONO_FONT,
              fontSize: 12,
              color: parentDir ? COLORS.textPrimary : COLORS.textMuted,
              flex: 1,
            }}
            title={parentDir}
            disabled={pending || parentDirLoading}
          />
          {pickDirectory ? (
            <button
              type="button"
              style={outlineButton({ minWidth: 44 })}
              disabled={pickerPending || pending}
              onClick={() => {
                void handleChooseParent();
              }}
              aria-label="Choose parent directory"
            >
              {pickerPending ? (
                <CircleNotch size={12} weight="bold" className="animate-spin" />
              ) : (
                <FolderOpen size={12} weight="regular" />
              )}
            </button>
          ) : null}
        </div>
      </Field>

      <PathPreview path={previewPath} exists={pathExists} />

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
            "Create"
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
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          ...LABEL_STYLE,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function PathPreview({ path, exists }: { path: string; exists: boolean }) {
  if (!path) return null;
  return (
    <div
      style={cardStyle({
        padding: "10px 12px",
        borderRadius: 10,
        background: exists
          ? "color-mix(in srgb, var(--color-error) 8%, transparent)"
          : "color-mix(in srgb, var(--color-fg) 3%, transparent)",
        borderColor: exists
          ? "color-mix(in srgb, var(--color-error) 40%, var(--color-border))"
          : COLORS.border,
        backdropFilter: "none",
        WebkitBackdropFilter: "none",
      })}
    >
      <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>WILL BE CREATED AT</div>
      <div
        style={{
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: exists ? COLORS.danger : COLORS.textPrimary,
          wordBreak: "break-all",
        }}
      >
        {path}
      </div>
      {exists ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
            fontSize: 11,
            fontFamily: SANS_FONT,
            color: COLORS.danger,
          }}
        >
          <Warning size={12} weight="fill" />
          Path already exists
        </div>
      ) : null}
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
        fontSize: 11,
        fontFamily: SANS_FONT,
        color: tone === "danger" ? COLORS.danger : COLORS.textMuted,
      }}
    >
      {tone === "danger" ? <Warning size={12} weight="fill" /> : null}
      {children}
    </span>
  );
}
