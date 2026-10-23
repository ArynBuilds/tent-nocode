import { useState } from 'react';
import type { ReactNode } from 'react';
import { importFormatFor } from '@tent-nocode/core';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';

/** Drop target: import files onto the canvas through registered formats. */

export function DropTarget({ children, onQuiet, onComponentDrop, projectId, projectName }: {
  children: ReactNode;
  /** Sentence feedback for the import. */
  onQuiet: (sentence: string) => void;
  /** Component drop creates view seeded with it at the drop point; null if no layer. */
  onComponentDrop?: (componentRef: string, at: { x: number; y: number } | null) => void;
  /** Drop lands in this project; defaults to focused project. */
  projectId?: string;
  /** Project name for the landing sentence. */
  projectName?: string;
}) {
  const { orgId } = useOrg();
  const [over, setOver] = useState(false);

  /** Convert client px to canvas units through the engine layer; scoped to this mount. */
  function canvasPointAt(host: HTMLElement, clientX: number, clientY: number): { x: number; y: number } | null {
    const layer = host.querySelector('[data-canvas-layer]');
    if (!(layer instanceof HTMLElement) || layer.offsetWidth === 0) return null;
    const rect = layer.getBoundingClientRect();
    const zoom = rect.width / layer.offsetWidth;
    if (zoom <= 0) return null;
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>): Promise<void> {
    e.preventDefault();
    setOver(false);
    const ref = e.dataTransfer.getData('tent-nocode/component');
    if (ref !== '') {
      onComponentDrop?.(ref, canvasPointAt(e.currentTarget, e.clientX, e.clientY));
      return;
    }
    const files = [...e.dataTransfer.files].filter((f) => importFormatFor(f.name) !== null);
    if (files.length === 0) return; // nothing importable — nothing to say
    const bridge = (window as unknown as { desk?: { getPathForFile?: (f: File) => string } }).desk;
    if (files.length === 1) {
      const file = files[0]!;
      const path = bridge?.getPathForFile?.(file);
      if (path === undefined || path === '') {
        onQuiet('this file has no path the app can read');
        return;
      }
      const res = await desk.humanImportFile(orgId, path, projectId);
      if (!res.ok) {
        onQuiet(res.error);
        return;
      }
      if (res.data?.lane === 'rows') {
        onQuiet(`importing ${res.data.table} — the table lands shortly`);
        return;
      }
      onQuiet(res.data?.alreadyImported === true
        ? 'already imported — nothing new'
        : `landed in ${projectName ?? 'this project'}`);
      return;
    }
    // Many files, one gesture: every registered file imports; ONE aggregate sentence.
    let tables = 0;
    let packages = 0;
    const refusals: string[] = [];
    for (const file of files) {
      const path = bridge?.getPathForFile?.(file);
      if (path === undefined || path === '') {
        refusals.push(`${file.name} has no path the app can read`);
        continue;
      }
      const res = await desk.humanImportFile(orgId, path, projectId);
      if (!res.ok) {
        refusals.push(`${file.name}: ${res.error}`);
        continue;
      }
      if (res.data?.lane === 'rows') tables += 1;
      else packages += 1;
    }
    const parts: string[] = [];
    if (tables > 0) parts.push(`importing ${tables} ${tables === 1 ? 'table' : 'tables'} - they land shortly`);
    if (packages > 0) parts.push(`landed in ${projectName ?? 'this project'}`);
    if (refusals.length > 0) parts.push(`${refusals.length} refused - ${refusals[0]!}`);
    onQuiet(parts.join(' · '));
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, outline: over ? '1px dashed var(--border2)' : 'none', outlineOffset: -2 }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => void onDrop(e)}
    >
      {children}
    </div>
  );
}
