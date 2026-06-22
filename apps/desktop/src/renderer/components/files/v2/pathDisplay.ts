import { isWindowsAbsolutePath } from "../../../lib/pathUtils";

export function joinDisplayPath(rootPath: string, relativePath: string): string {
  if (!relativePath) return rootPath;
  if (!rootPath) return relativePath;
  if (rootPath.endsWith("/") || rootPath.endsWith("\\")) return `${rootPath}${relativePath}`;
  const separator = rootPath.includes("\\") || (isWindowsAbsolutePath(rootPath) && relativePath.includes("\\"))
    ? "\\"
    : "/";
  return `${rootPath}${separator}${relativePath}`;
}
