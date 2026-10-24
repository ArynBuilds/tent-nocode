import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { importPackage, validateLsgPackage, type ImportResult } from '@nodeloom/kernel';
import type { LsgPackage } from '@nodeloom/core';

/** Provision is the owner's act: renders closure verbatim, requires consent by hash, never bare --yes. */

export interface ProvisionIo {
  out: (line: string) => void;
  /** Asks the ONE y/N; absent means non-interactive (accept-by-hash only). */
  confirm?: (question: string) => Promise<boolean>;
}

export type ProvisionResult =
  | { ok: true; packageHash: string; import: ImportResult }
  | { ok: false; refusal: string; denied?: boolean };

/** Renders closure verbatim: one line per fact, plain words. */
export function renderClosure(pkg: LsgPackage): string[] {
  const lines: string[] = [];
  const m = pkg.manifest;
  lines.push(`Package ${pkg.packageHash.slice(0, 12)}… — exported by ${m.provenance.org} (app ${m.provenance.appVersion}, ${m.provenance.exportedAt})`);
  lines.push(`License: ${m.license}`);
  lines.push(`This package contains ${pkg.entries.length} ${pkg.entries.length === 1 ? 'entry' : 'entries'}:`);
  for (const entry of pkg.entries) {
    switch (entry.kind) {
      case 'project':
        lines.push(`  project "${entry.projectName}"${entry.projectKind !== undefined ? ` (${entry.projectKind})` : ''}${entry.theme !== undefined ? ', with its theme' : ''}`);
        break;
      case 'screen':
        lines.push(`  screen "${entry.title}" (${entry.name}, ${entry.role}) — ${Object.keys(entry.document.nodes).length} nodes${entry.actions && entry.actions.length > 0 ? `, ${entry.actions.length} declared action(s)` : ''}`);
        break;
      case 'library-item':
        lines.push(`  library item ${entry.name} (${entry.role})`);
        break;
      case 'flow':
        lines.push(`  flow ${entry.name} (${entry.role})`);
        break;
      case 'trigger':
        lines.push(`  trigger ${entry.name} (${entry.role}) — lands disabled`);
        break;
      case 'service':
        lines.push(`  service ${entry.integration} "${entry.label}" (${entry.role}) — no secret travels; connect it with your own key`);
        break;
      case 'operation': {
        const contract = (entry.registration as { contract?: { input?: unknown; output?: unknown } }).contract;
        const io = contract ? ` — io: ${JSON.stringify(contract.input ?? null)} -> ${JSON.stringify(contract.output ?? null)}` : '';
        lines.push(`  OPERATION ${entry.name} (${entry.role}) — arrives CAGED; runs only after your consent${io}`);
        break;
      }
      case 'table':
        lines.push(`  table ${entry.name} (${entry.role})${entry.rows !== undefined ? ` — ${entry.rows.length} row(s) INLINED` : entry.rowChunks !== undefined ? ` — ${entry.rowChunks.reduce((n, c) => n + c.rows, 0)} row(s) in the data lane` : ' — schema only, no data'}`);
        break;
      case 'notes':
        lines.push(`  notes for project "${entry.projectName}" (${entry.notes.length} note(s))`);
        break;
    }
  }
  lines.push('Grants never travel: this package carries no credentials, and nothing in it executes at import.');
  return lines;
}

export async function provisionApp(
  sql: postgres.Sql,
  input: {
    orgId: string;
    userId: string;
    appPath: string;
    acceptClosureHash?: string;
    armNames?: string[];
    io: ProvisionIo;
  },
): Promise<ProvisionResult> {
  const { io } = input;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(input.appPath, 'utf8'));
  } catch (err) {
    return { ok: false, refusal: `Could not read "${input.appPath}" as a package: ${err instanceof Error ? err.message : String(err)}. Nothing was installed.` };
  }
  const validated = validateLsgPackage(raw);
  if (!validated.ok) {
    return { ok: false, refusal: `This file is not a valid Nodeloom package: ${validated.errors[0] ?? 'malformed'}. Nothing was installed.` };
  }
  const pkg = validated.pkg;

  for (const line of renderClosure(pkg)) io.out(line);

  // Consent: interactive y/N or hash-named flag (never bare --yes).
  if (input.acceptClosureHash !== undefined) {
    if (input.acceptClosureHash !== pkg.packageHash) {
      return {
        ok: false,
        refusal: `--accept-closure names hash ${input.acceptClosureHash.slice(0, 12)}…, but this package is ${pkg.packageHash.slice(0, 12)}…. `
          + 'Consent is named by hash — re-run with the hash printed above. Nothing was installed.',
      };
    }
  } else if (input.io.confirm) {
    const yes = await input.io.confirm('Install this package? [y/N] ');
    if (!yes) {
      io.out('Nothing was installed.');
      return { ok: false, refusal: 'Declined at the closure. Nothing was installed.', denied: true };
    }
  } else {
    return {
      ok: false,
      refusal: 'Non-interactive install needs explicit consent: re-run with '
        + `--accept-closure ${pkg.packageHash}. Nothing was installed.`,
    };
  }

  // Install lands project-wise (find-or-birth by title, file path as fallback).
  const result = await importPackage(sql, {
    orgId: input.orgId, file: raw, createdBy: input.userId,
    findOrBirthProject: true, sourcePath: input.appPath,
  });
  if (!result.ok) {
    return { ok: false, refusal: `The import gauntlet refused: ${(result.errors ?? []).join('; ')}. Nothing was installed.` };
  }
  if (result.alreadyImported === true) {
    io.out('Already installed (same package hash) — nothing changed.');
  } else {
    const landed = result.landed;
    io.out(`Installed: ${landed?.scenes.length ?? 0} scene(s), ${landed?.components.length ?? 0} component(s), ${landed?.operations.length ?? 0} operation(s), ${landed?.datasetsDeclared.length ?? 0} dataset(s).`);
  }

  // Arming is explicit by name; a tproject@2 package carries no chains.
  if (input.armNames !== undefined && input.armNames.length > 0) {
    io.out(`--arm named [${input.armNames.join(', ')}], but this package format carries no chains — nothing was armed.`);
  } else {
    io.out('No chains ride this package format — nothing to arm. (Chains you create later arm only by your own act.)');
  }

  return { ok: true, packageHash: pkg.packageHash, import: result };
}
