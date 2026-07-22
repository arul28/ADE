export function markActiveHostProjectOpen<T extends { id: string; isOpen: boolean }>(
  projects: T[],
  activeHostProjectId: string | null,
): T[] {
  return projects.map((project) => {
    const isOpen = project.id === activeHostProjectId;
    return project.isOpen === isOpen ? project : { ...project, isOpen };
  });
}
