import type postgres from 'postgres';
import { genomeInputSchema, type GenomeInput } from '@nodeloom/core';
import { emitEvent } from '../events.js';

/** Publish an immutable new agent version in one transaction. */
export async function publishVersion(
  sql: postgres.Sql,
  agentId: string,
  genome: GenomeInput,
  opts?: { originJobId?: string },
): Promise<{ version: number }> {
  const parsed = genomeInputSchema.parse(genome);
  return sql.begin(async (tx) => {
    const agents = await tx<{ org_id: string; current_version: number }[]>`
      select org_id, current_version from agents where id = ${agentId} for update`;
    const agent = agents[0];
    if (!agent) throw new Error(`agent not found: ${agentId}`);
    const version = agent.current_version + 1;

    await tx`
      insert into agent_versions
        (agent_id, version, instructions, io_contract, test_cases, parent_version, lineage_note, created_by)
      values
        (${agentId}, ${version}, ${parsed.instructions}, ${tx.json(parsed.ioContract as unknown as postgres.JSONValue)},
         ${tx.json(parsed.testCases as unknown as postgres.JSONValue)},
         ${parsed.parentVersion ?? null}, ${parsed.lineageNote ?? null}, ${parsed.createdBy})`;

    // The capability string is frozen at v1 so later versions cannot re-key it.
    if (version === 1) {
      await tx`update agents set current_version = ${version}, status = 'active', capability = ${parsed.capability}
        where id = ${agentId}`;
    } else {
      await tx`update agents set current_version = ${version}, status = 'active' where id = ${agentId}`;
    }

    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: agent.org_id,
      actor: 'kernel.registry',
      type: 'agent.published',
      payload: { agentId, version, createdBy: parsed.createdBy, originJobId: opts?.originJobId ?? null },
    });
    return { version };
  }) as Promise<{ version: number }>;
}
