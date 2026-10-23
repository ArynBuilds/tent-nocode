import type { InspectorSubject } from '../../lib/canvas/store.js';
import { ContractForm } from './ContractForm.js';
import { WireConnection } from './WireConnection.js';
import { PropertyPanel } from '../page-edit/PropertyPanel.js';

// The inspector's one switch: a wire reads as its connection sentence, a citizen as its contract form, a
// scene selection (one element or many) as the schema-driven property panel.
export function InspectorPane({ selection }: { selection: InspectorSubject }) {
  if ('wire' in selection) return <WireConnection selection={selection} />;
  if ('citizen' in selection) return <ContractForm selection={selection} />;
  return <PropertyPanel selection={selection} />;
}
