import { StateNode, type PointerInfo, type StateNodeCtor } from '../StateNode.js';
import { Drawing } from './Drawing.js';

// CREATE / IDLE: the crosshair rests; a press starts the draw (armed or not - an unarmed draw asks at the
// release); the middle button pans; a right-click on the ground opens the palette.

export class Idle extends StateNode {
  static override id = 'idle';

  override onEnter(): void {
    this.editor.store.setGesture({ cursor: 'crosshair', createGhost: null });
  }

  override onExit(): void {
    this.editor.store.setGesture({ cursor: null, createGhost: null });
  }

  override onPointerDown(info: PointerInfo): void {
    if (info.button === 1) { this.parent.parent.transition('hand', { temporary: true, from: 'create' }); return; }
    if (info.button !== 0) return;
    this.parent.transition('drawing', info);
  }

  override onRightClick(info: PointerInfo): void {
    const { store, doors } = this.editor;
    if (info.target.kind === 'node') { const n = store.node(info.target.id); if (n !== undefined) doors.nodeContext(n, info.client); return; }
    doors.canvasContext(info.world, info.client);
  }
}

/** THE CREATE TOOL: the crosshair and the draw. */
export class CreateTool extends StateNode {
  static override id = 'create';
  static override initial = 'idle';
  static override children(): StateNodeCtor[] { return [Idle, Drawing]; }
}

// ---- The fresh tool draft: a hand-written script is born as a version 1 operation through the registration door.

export const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface OpDraft {
  name: string;
  runtime: 'wasm';
  code: string;
  ioContract: {
    inputs: Record<string, { type: 'dataset' | 'param'; description: string; valueType?: 'string' | 'number' | 'boolean' }>;
    outputs: Record<string, { kind: 'array'; description: string }>;
  };
}

/** Template draft: one dataset in, one array out. */
export function freshDraft(name: string): OpDraft {
  return {
    name,
    runtime: 'wasm',
    code: [
      '# ' + name + ' - runs sealed on this machine (no network, no model).',
      '# inputs arrive as files beside this script; outputs register by writing them.',
      'import numpy as np',
      '',
      'def run(rows):',
      '    # rows: the wired table as a list of dicts',
      '    values = np.array([1.0 for _ in rows])',
      '    return values',
      '',
    ].join('\n'),
    ioContract: {
      inputs: { rows: { type: 'dataset', description: 'the table this tool reads' } },
      outputs: { result: { kind: 'array', description: 'one value per row' } },
    },
  };
}

export function draftNameValid(name: string): boolean {
  return KEBAB_RE.test(name) && name.length >= 2 && name.length <= 64;
}
