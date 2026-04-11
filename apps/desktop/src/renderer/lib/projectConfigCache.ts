type ProjectConfigSnapshot = Awaited<ReturnType<typeof window.ade.projectConfig.get>>;

type CacheEntry = {
  value?: ProjectConfigSnapshot;
  promise?: Promise<ProjectConfigSnapshot>;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 10_000;
const configCache = new Map<string, CacheEntry>();

function getCacheKey(projectRoot: string | null | undefined): string {
  return projectRoot?.trim() || "__no_project__";
}

export async function getProjectConfigCached(args?: {
  projectRoot?: string | null;
  force?: boolean;
  ttlMs?: number;
}): Promise<ProjectConfigSnapshot> {
  const ttlMs = args?.ttlMs ?? DEFAULT_TTL_MS;
  const key = getCacheKey(args?.projectRoot);
  const now = Date.now();

  if (!args?.force) {
    const cached = configCache.get(key);
    if (cached?.value !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.promise) {
      return cached.promise;
    }
  }

  const promise = window.ade.projectConfig.get().then((value) => {
    configCache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    return value;
  }).catch((error) => {
    const existing = configCache.get(key);
    if (existing?.promise === promise) {
      configCache.delete(key);
    }
    throw error;
  });

  configCache.set(key, {
    promise,
    expiresAt: now + ttlMs,
  });

  return promise;
}

export function invalidateProjectConfigCache(projectRoot?: string | null): void {
  if (projectRoot == null) {
    configCache.clear();
    return;
  }
  configCache.delete(getCacheKey(projectRoot));
}
