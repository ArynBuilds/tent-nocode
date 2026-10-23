import type postgres from 'postgres';
import { genomeInputSchema, type GenomeInput } from '@tent-nocode/core';
import { emitEvent } from '../events.js';

/** Register a new draft agent; version content is only stored on publish. */
export async function createAgent(
  sql: postgres.Sql,
  orgId: string,
  genome: GenomeInput,
): Promise<{ agentId: string }> {
  const parsed = genomeInputSchema.parse(genome);
  const rows = await sql<{ id: string }[]>`
    insert into agents (org_id, slug, capability)
    values (${orgId}, ${parsed.slug}, ${parsed.capability})
    returning id`;
  const row = rows[0];
  if (!row) throw new Error('agent insert returned no row');
  await emitEvent(sql, {
    orgId,
    actor: 'kernel.registry',
    type: 'agent.created',
    payload: { agentId: row.id, slug: parsed.slug, createdBy: parsed.createdBy },
  });
  return { agentId: row.id };
}
