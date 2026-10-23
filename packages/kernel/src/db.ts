import postgres from 'postgres';

/** Service-role Postgres client for kernel modules. Caller owns lifecycle (call sql.end()). */
export function createDb(url?: string): postgres.Sql {
  const dsn = url ?? process.env['DATABASE_URL'];
  if (!dsn) throw new Error('DATABASE_URL is not set');
  return postgres(dsn, { max: 5, onnotice: () => {} });
}
