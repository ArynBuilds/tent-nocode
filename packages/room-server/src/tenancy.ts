import type postgres from 'postgres';
import type { HostLookup } from '@nodeloom/kernel';

// Pins tenant context: every tenant-scoped statement runs in a transaction with transaction-local GUCs.

export interface TenantContext {
  orgId: string;
  /** Set on shared-user lanes only; visitor/owner lanes leave it null. */
  projectId?: string | null;
  /** Opaque app user id of the signed-in end user; null when anonymous. */
  endUserId?: string | null;
}

export async function withTenant<T>(
  sql: postgres.Sql, ctx: TenantContext,
  /** Typed as Sql so kernel sql-first functions accept it; the value is the transaction handle. */
  fn: (tx: postgres.Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${ctx.orgId}, true),
                    set_config('app.project_id', ${ctx.projectId ?? ''}, true),
                    set_config('app.end_user_id', ${ctx.endUserId ?? ''}, true)`;
    return fn(tx as unknown as postgres.Sql);
  }) as Promise<T>;
}

/** Parse `(x-app).base.domain` → the app slug; anything else (apex, deep labels,
 * foreign hosts, ports stripped) → null. */
export function parseAppHost(host: string, baseDomain: string): string | null {
  const bare = host.toLowerCase().split(':')[0] ?? '';
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!bare.endsWith(suffix)) return null;
  const label = bare.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;
  return label;
}

export interface HostResolver {
  resolve(host: string): Promise<HostLookup | null>;
  /** Kill-switch propagation: drop a cached entry immediately (purge-on-suspend). */
  purge(appSlug: string): void;
}

/** Resolves host to (account, app) with a TTL cache; the TTL bounds kill-switch propagation. */
export function createHostResolver(
  deps: { sql: postgres.Sql; baseDomain: string; ttlMs?: number },
): HostResolver {
  const ttl = deps.ttlMs ?? 60_000;
  const cache = new Map<string, { value: HostLookup | null; expiresAt: number }>();
  return {
    async resolve(host: string): Promise<HostLookup | null> {
      const slug = parseAppHost(host, deps.baseDomain);
      if (!slug) return null;
      const hit = cache.get(slug);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const [row] = await deps.sql<Array<Record<string, unknown>>>`select * from lookup_app(${slug})`;
      const value: HostLookup | null = row
        ? {
            orgId: row['org_id'] as string, roomId: row['room_id'] as string,
            appId: row['app_id'] as string, appSlug: row['app_slug'] as string,
            currentReleaseId: (row['current_release_id'] as string | null) ?? null,
            visibility: row['visibility'] as string, roomStatus: row['room_status'] as string,
          }
        : null;
      cache.set(slug, { value, expiresAt: Date.now() + ttl });
      return value;
    },
    purge(appSlug: string): void {
      cache.delete(appSlug);
    },
  };
}
