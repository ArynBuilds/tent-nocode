import type postgres from 'postgres';
import type { GenomeInput } from '@tent-nocode/core';
import { charterText } from '../charters/charter.js';
import { ensureReservedGenome } from './reserved.js';

// Reserved slug for the org's voice agent; the internal slug never migrates.
export const DESK_SLUG = 'desk';

// The charter lives in charters/charter.ts; ensureDeskAgent version-bumps existing orgs when its text changes.

/** The one charter with its token resolved from the registry - always current, never hand-typed. */
export function deskInstructions(): string {
  return charterText();
}

function deskGenome(): GenomeInput {
  return {
    slug: DESK_SLUG,
    capability: 'Conversational operator: triages chat messages, answers directly from context, and proposes work only when the user clearly wants agentic action',
    instructions: deskInstructions(),
    ioContract: {
      inputs: [{ name: 'userMessage', description: 'the latest chat message text' }],
      outputs: [{ name: 'reply', description: "the desk's reply text — prose to the user; orchestration happens through its tools, never inside the text" }],
    },
    // The voice's read-only posture lives in voiceTurnRules, not here.
    testCases: [],
    createdBy: 'human',
  };
}

// Idempotent create+publish of the org's desk agent, version-bumping on instruction drift.
export async function ensureDeskAgent(sql: postgres.Sql, orgId: string): Promise<{ agentId: string }> {
  return ensureReservedGenome(sql, orgId, deskGenome(), 'voice');
}
