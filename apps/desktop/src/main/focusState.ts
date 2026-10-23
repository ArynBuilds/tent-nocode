// Holds the focused scene slug; the renderer reads it over IPC at boot and on later pushes.

let focusedSceneSlug: string | null = null;

export function setFocusedScene(slug: string | null): void {
  focusedSceneSlug = slug;
}

export function focusedScene(): string | null {
  return focusedSceneSlug;
}
