import type postgres from 'postgres';
import type { GenomeInput } from '@nodeloom/core';
import { createAgent } from '../registry/create.js';
import { publishVersion } from '../registry/publish.js';

// The app's own genome role; only this kernel code stamps it, never a GenomeInput field.
export type ReservedRole = 'voice';

// Idempotent create+publish of a reserved genome, version-bumping on instruction drift.
export async function ensureReservedGenome(
  sql: postgres.Sql,
  orgId: string,
  genome: GenomeInput,
  role: ReservedRole,
): Promise<{ agentId: string }> {
  const existing = await sql<{ id: string; instructions: string | null }[]>`
    select a.id, v.instructions from agents a
    left join agent_versions v on v.agent_id = a.id and v.version = a.current_version
    where a.org_id = ${orgId} and a.slug = ${genome.slug}`;
  const existingAgent = existing[0];
  if (existingAgent) {
    if (existingAgent.instructions !== genome.instructions) {
      await publishVersion(sql, existingAgent.id, genome);
    }
    await sql`update agents set reserved = ${role} where id = ${existingAgent.id} and reserved is distinct from ${role}`;
    // Reserved genomes also sync capability text on drift.
    await sql`update agents set capability = ${genome.capability}
      where id = ${existingAgent.id} and reserved is not null and capability is distinct from ${genome.capability}`;
    return { agentId: existingAgent.id };
  }
  const { agentId } = await createAgent(sql, orgId, genome);
  await publishVersion(sql, agentId, genome);
  await sql`update agents set reserved = ${role} where id = ${agentId}`;
  return { agentId };
}
