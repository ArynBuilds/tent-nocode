import { StateNode, type PointerInfo } from '../StateNode.js';
import { wireAddressOf } from '../../store.js';

// SELECT / POINTING WIRE: a press on a landed wire selects it on the up (the Inspector speaks its sentence,
// the strip pins its verbs at the wire's mid); a drag does nothing - wires are drawn from ports.

export class PointingWire extends StateNode {
  static override id = 'pointingWire';

  private index = -1;

  override onEnter(info: PointerInfo): void {
    this.index = info.target.kind === 'wire' ? info.target.index : -1;
  }

  override onPointerUp(): void {
    const { store } = this.editor;
    const edges = store.folded.get().edges;
    const e = edges[this.index];
    if (e !== undefined) store.selectWire(wireAddressOf(e));
    this.parent.transition('idle');
  }

  override onCancel(): void { this.parent.transition('idle'); }
  override onComplete(): void { this.parent.transition('idle'); }
}
