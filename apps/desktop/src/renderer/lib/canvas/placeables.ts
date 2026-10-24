import { useEffect, useState } from 'react';
import type { IntegrationCatalogWire } from '@nodeloom/core';
import { desk } from '../desk.js';

/**
 * THE ONE PLACEABLE SHELF (2026-08-15, user-ruled after the node-browser gap:
 * "we need to make this system scalable"). Every CREATION surface - the + Add
 * menu, the right-click palette, the node browser tab - renders the
 * integrations shelf from THIS projection and nothing else. The failure this
 * kills: three surfaces each holding a private fetch + filter + word map, so
 * a new species needed three hand edits and silently missed one. A surface
 * that lists placeable integrations imports these two names; a surface with
 * its own copy is the bug.
 */

export interface IntegrationShelfRow { name: string; displayName: string }

/** The ONE projection: surface-filtered by the project's kind (the
 * app-forbidden set - absence, never a disabled row); upcoming entries wear
 * their word. Null/undefined kind reads as 'app' (the standing default). */
export function integrationShelfRows(
  defs: IntegrationCatalogWire[],
  projectKind: 'app' | 'website' | null | undefined,
): IntegrationShelfRow[] {
  const surface = projectKind === 'website' ? 'website' : 'app';
  return defs
    .filter((e) => e.surfaces === 'both' || e.surfaces === surface)
    .map((e) => ({
      name: e.name,
      displayName: e.availability === 'upcoming' ? `${e.displayName} (upcoming)` : e.displayName,
    }));
}

/**
 * The one hook every creation surface calls. Give the project kind when the
 * caller already holds it; give the projectId alone and the hook resolves the
 * kind itself - kind logic lives HERE, never re-derived per surface.
 */
export function usePlaceableIntegrations(
  orgId: string,
  opts: { projectId?: string | null; projectKind?: 'app' | 'website' | null },
): IntegrationShelfRow[] {
  const [rows, setRows] = useState<IntegrationShelfRow[]>([]);
  const knownKind = opts.projectKind;
  const projectId = opts.projectId ?? null;
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = (): void => {
      void (async () => {
        try {
          const defs = await desk.integrationsCatalog();
          let kind: 'app' | 'website' | null = knownKind ?? null;
          if (knownKind === undefined && projectId !== null) {
            const projects = await desk.listProjects(orgId);
            kind = projects.find((p) => p.id === projectId)?.kind ?? null;
          }
          if (cancelled) return;
          if (defs.length === 0) { timer = window.setTimeout(load, 5000); return; }
          setRows(integrationShelfRows(defs, kind));
        } catch {
          if (!cancelled) timer = window.setTimeout(load, 5000); // bug 5: retry, never an empty shelf
        }
      })();
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [orgId, projectId, knownKind]);
  return rows;
}

// ---- F19 (2026-08-16): THE DOORS ARM — every service's endpoints as placeable
// ACTION STEPS ("Slack: Send a message"). A door row is a PRECONFIGURED
// call-integration placement, never a new species: the surfaces filter is the
// SAME one integrationShelfRows applies (S29's http-request doors inherit its
// flag through this exact line), and the credential home stays the ONE
// Connection node the placement binds to.

export interface DoorShelfRow {
  service: string;
  serviceDisplayName: string;
  endpoint: string;
  displayName: string;
  klass: 'read' | 'write' | 'send';
}

/** The one doors projection - pure derivation off the catalog wire. */
export function doorShelfRows(
  defs: IntegrationCatalogWire[],
  projectKind: 'app' | 'website' | null | undefined,
): DoorShelfRow[] {
  const surface = projectKind === 'website' ? 'website' : 'app';
  return defs
    .filter((e) => e.surfaces === 'both' || e.surfaces === surface)
    .flatMap((e) => e.endpoints.map((ep) => ({
      service: e.name,
      serviceDisplayName: e.availability === 'upcoming' ? `${e.displayName} (upcoming)` : e.displayName,
      endpoint: ep.id,
      displayName: `${e.displayName}: ${ep.displayName}`,
      klass: ep.class,
    })));
}

/** The one doors hook - same catalog fetch, same kind resolution as the
 * integrations hook; kind logic lives HERE, never re-derived per surface. */
export function usePlaceableDoors(
  orgId: string,
  opts: { projectId?: string | null; projectKind?: 'app' | 'website' | null },
): DoorShelfRow[] {
  const [rows, setRows] = useState<DoorShelfRow[]>([]);
  const knownKind = opts.projectKind;
  const projectId = opts.projectId ?? null;
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = (): void => {
      void (async () => {
        try {
          const defs = await desk.integrationsCatalog();
          let kind: 'app' | 'website' | null = knownKind ?? null;
          if (knownKind === undefined && projectId !== null) {
            const projects = await desk.listProjects(orgId);
            kind = projects.find((p) => p.id === projectId)?.kind ?? null;
          }
          if (cancelled) return;
          if (defs.length === 0) { timer = window.setTimeout(load, 5000); return; }
          setRows(doorShelfRows(defs, kind));
        } catch {
          if (!cancelled) timer = window.setTimeout(load, 5000); // bug 5: retry, never an empty shelf
        }
      })();
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [orgId, projectId, knownKind]);
  return rows;
}

// ---- C WAVE UI (2026-08-16): THE TRIGGERS ARM — each service's declared
// trigger rows ("Slack: Message posted") as placeable preconfigured Watchers.
// FIRE-READY ONLY (DIALECTS-BEFORE-SHELF-SURFACING): a webhook row surfaces
// exactly when the wire carries the service's dialect (webhookScheme, the
// kernel's one scheme registry projected - slack/stripe/gitlab/... plus the
// generic speakers clickup and mailchimp; paypal's cert verification is owed,
// so its rows stay absent - absence is the off state). Poll rows ALWAYS
// surface: the rows_changed composition rides the mirror, never the door. The
// surfaces filter is the SAME line integrations and doors ride.

export interface TriggerShelfRow {
  service: string;
  serviceDisplayName: string;
  /** The def-declared trigger row id. */
  trigger: string;
  /** The composed words - 'Slack: Message posted' (the door idiom). */
  displayName: string;
  kind: 'webhook' | 'poll';
}

/** The one triggers projection - pure derivation off the catalog wire. */
export function triggerShelfRows(
  defs: IntegrationCatalogWire[],
  projectKind: 'app' | 'website' | null | undefined,
): TriggerShelfRow[] {
  const surface = projectKind === 'website' ? 'website' : 'app';
  return defs
    .filter((e) => e.surfaces === 'both' || e.surfaces === surface)
    .flatMap((e) => e.triggers
      .filter((t) => t.kind === 'poll' || e.webhookScheme !== null)
      .map((t) => ({
        service: e.name,
        serviceDisplayName: e.availability === 'upcoming' ? `${e.displayName} (upcoming)` : e.displayName,
        trigger: t.id,
        displayName: `${e.displayName}: ${t.displayName}`,
        kind: t.kind,
      })));
}

/** The one triggers hook - same catalog fetch, same kind resolution as the
 * integrations hook; kind logic lives HERE, never re-derived per surface. */
export function usePlaceableTriggers(
  orgId: string,
  opts: { projectId?: string | null; projectKind?: 'app' | 'website' | null },
): TriggerShelfRow[] {
  const [rows, setRows] = useState<TriggerShelfRow[]>([]);
  const knownKind = opts.projectKind;
  const projectId = opts.projectId ?? null;
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = (): void => {
      void (async () => {
        try {
          const defs = await desk.integrationsCatalog();
          let kind: 'app' | 'website' | null = knownKind ?? null;
          if (knownKind === undefined && projectId !== null) {
            const projects = await desk.listProjects(orgId);
            kind = projects.find((p) => p.id === projectId)?.kind ?? null;
          }
          if (cancelled) return;
          if (defs.length === 0) { timer = window.setTimeout(load, 5000); return; }
          setRows(triggerShelfRows(defs, kind));
        } catch {
          if (!cancelled) timer = window.setTimeout(load, 5000); // bug 5: retry, never an empty shelf
        }
      })();
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [orgId, projectId, knownKind]);
  return rows;
}

// ---- F13 (2026-08-16): THE STEPS ARM — the same one-shelf law applied to flow
// steps: every creation surface renders the step kinds from THIS projection
// (the kernel's closed defs shelf over the flowStepCatalog channel).

export interface StepShelfRow { kind: string; displayName: string; blurb: string }

/** The one steps hook - a failed/empty fetch RETRIES on a 5s beat until the
 * shelf answers (bug 5: one transient miss emptied the create menu until a
 * full leave-and-return). */
export function usePlaceableSteps(): StepShelfRow[] {
  const [rows, setRows] = useState<StepShelfRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = (): void => {
      desk.flowStepCatalog()
        .then((defs) => {
          if (cancelled) return;
          if (defs.length === 0) { timer = window.setTimeout(load, 5000); return; }
          setRows(defs.map((d) => ({ kind: d.kind, displayName: d.displayName, blurb: d.blurb })));
        })
        .catch(() => { if (!cancelled) timer = window.setTimeout(load, 5000); });
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);
  return rows;
}
