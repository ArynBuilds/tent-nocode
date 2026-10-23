import { Workspace } from './Workspace.js';
import { desk } from '../../lib/desk.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';

// Mounts workspace at focused project; switching focus re-keys the mount.

export function WorkspacePane() {
  const { orgId } = useOrg();
  const { focusedProjectId } = useFocusedProject();
  const projectsQuery = useQuery(`map-projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  const project = (projectsQuery.data ?? []).find((p) => p.id === focusedProjectId) ?? null;
  // Zero projects (or one unresolved beat): the birth flow owns the center — nothing here.
  if (project === null) return null;
  return (
    <Workspace
      key={`bench:${orgId}:${project.id}`}
      // Bench identity is the project title.
      cluster={{ title: project.name }}
    />
  );
}
