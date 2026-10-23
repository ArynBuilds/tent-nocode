import type { InspectorSubject } from '../../lib/canvas/store.js';
import { WireConnection } from './WireConnection.js';
import { PropertyPanel } from '../page-edit/PropertyPanel.js';

// The inspector's one switch: a wire reads as its connection sentence, a scene selection (one element
// or many) as the schema-driven property panel. Nodes have no inspector: their properties are the card.
export function InspectorPane({ selection }: { selection: InspectorSubject }) {
  if ('wire' in selection) return <WireConnection selection={selection} />;
  return <PropertyPanel selection={selection} />;
}
