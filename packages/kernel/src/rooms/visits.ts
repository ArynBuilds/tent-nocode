import type postgres from 'postgres';
import { ensureDataset } from '../tabs/datasets.js';

// Visit source: each page serve or app open lands one row on the visits Table.

export const VISITS_TABLE = 'visits';

const VISITS_ROW_SCHEMA: Record<string, 'string' | 'number' | 'boolean'> = {
  who: 'string',
  when: 'string',
  screen: 'string',
  source: 'string',
};

/** Caches the ensured dataset id per (org, project); a failed insert drops the entry. */
const ensuredVisits = new Map<string, string>();

export interface VisitInput {
  orgId: string;
  /** NULL = the whole-account lane; project-homed hosts pass the scene's own project. */
  projectId: string | null;
  /** NULL = not signed in; the row still lands with who empty. */
  who: string | null;
  screen: string;
  source: 'website' | 'app';
}

/** Land one visit row; never throws to the caller, and deliberately emits no event. */
export async function recordVisit(sql: postgres.Sql, input: VisitInput): Promise<void> {
  // Only the serving schema allows a null project_id; the workspace schema refuses at insert.
  const key = `${input.orgId}:${input.projectId ?? ''}`;
  const land = async (): Promise<void> => {
    let datasetId = ensuredVisits.get(key);
    if (datasetId === undefined) {
      const ensured = await ensureDataset(sql, {
        orgId: input.orgId, projectId: input.projectId, name: VISITS_TABLE,
        rowSchema: VISITS_ROW_SCHEMA, userScope: 'app',
      });
      datasetId = ensured.datasetId;
      ensuredVisits.set(key, datasetId);
    }
    const row = {
      who: input.who, when: new Date().toISOString(),
      screen: input.screen, source: input.source,
    };
    await sql`
      insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
      values (${input.orgId}, ${datasetId}, ${sql.json(row as postgres.JSONValue)}, ${null})`;
  };
  try {
    await land();
  } catch {
    // One retry through a fresh ensure (a cached id can outlive its table);
    // a second failure is swallowed whole - the serve never pays for it.
    ensuredVisits.delete(key);
    await land().catch(() => undefined);
  }
}
