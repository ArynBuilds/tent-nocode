import { useEffect, useState } from 'react';
import type { OrgRole } from '@nodeloom/core';
import type { MessageRow } from '../../../shared/ipc.js';
import { approvalAction, can } from '../../../shared/roles.js';
import { desk } from '../../lib/desk.js';
import styles from './chat.module.css';

/** THE ONE CARD - the single card moment. Four faces from consent.ts card state:
 * the generic consent face (lands sentence + Approve/Decline; ask-once carries the
 * remembered-for-this-project line), the app_plan citizen grid, the component-mint
 * preview, and the connect/keys face (the only face with inputs - keys ride into
 * the vault, never chat). Two sizes by container width: pill chat and full screen. */

/** Envelope keys the kernel adds to every card — never user-consented content. */
const ENVELOPE_KEYS = new Set(['kind', 'threadId', 'runId', 'jobId', 'previewPath', 'lands', 'consentClass']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain words for a kind: 'create_view' -> 'Create view'. */
function kindWords(kind: string): string {
  const words = kind.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function valueWords(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Who answered, in plain words. */
function answeredChip(answer: Record<string, unknown> | null): string {
  if (answer === null) return 'answered';
  const approved = answer['approved'] === true;
  const by = typeof answer['resolvedBy'] === 'string' ? (answer['resolvedBy'] as string) : '';
  if (UUID_RE.test(by)) return approved ? 'approved by you' : 'declined by you';
  return approved ? 'approved' : 'declined';
}

// ---- the app_plan citizen grid (renders INSIDE the card, never a new surface) ----

interface PlanTable { name: string; rowSchema: Record<string, string>; provenance: string }
interface PlanScreen { name: string; purpose: string; reads: string[] }

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function PlanGrid({ payload }: { payload: Record<string, unknown> }) {
  const tables = asArray<PlanTable>(payload['tables']);
  const screens = asArray<PlanScreen>(payload['screens']);
  const flows = asArray<string>(payload['flows']);
  const services = asArray<string>(payload['services']);
  return (
    <div className={styles.planGrid}>
      {tables.length > 0 ? (
        <div className={styles.planSection}>
          <div className={styles.planLabel}>Tables</div>
          {tables.map((t) => (
            <div className={styles.planRow} key={t.name}>
              <div className={styles.planHead}>
                <span className={styles.planName}>{t.name}</span>
                <span className={styles.planTag}>{t.provenance}</span>
              </div>
              <div className={styles.planQuiet}>
                {Object.entries(t.rowSchema ?? {}).map(([col, ty]) => `${col} ${ty}`).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {screens.length > 0 ? (
        <div className={styles.planSection}>
          <div className={styles.planLabel}>Screens</div>
          {screens.map((s) => (
            <div className={styles.planRow} key={s.name}>
              <div className={styles.planHead}>
                <span className={styles.planName}>{s.name}</span>
                {s.reads.length > 0 ? <span className={styles.planTag}>reads {s.reads.join(', ')}</span> : null}
              </div>
              <div className={styles.planQuiet}>{s.purpose}</div>
            </div>
          ))}
        </div>
      ) : null}
      {flows.length > 0 ? (
        <div className={styles.planSection}>
          <div className={styles.planLabel}>Flows</div>
          {flows.map((f, i) => (
            <div className={styles.planRow} key={i}>
              <div className={styles.planName}>{f}</div>
            </div>
          ))}
        </div>
      ) : null}
      {services.length > 0 ? (
        <div className={styles.planSection}>
          <div className={styles.planLabel}>Services</div>
          {services.map((v) => (
            <div className={styles.planRow} key={v}>
              <div className={styles.planName}>{v}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ConsentBlock({ orgId, role, gate, rawText }: {
  orgId: string; role: OrgRole; gate: MessageRow; rawText?: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const payload = gate.payload;
  const kind = typeof payload['kind'] === 'string' ? (payload['kind'] as string) : 'consent';
  const lands = typeof payload['lands'] === 'string' ? (payload['lands'] as string) : null;
  const askOnce = payload['consentClass'] === 'ask-once';
  const isPlan = kind === 'app_plan';
  const preview = typeof payload['previewPath'] === 'string' && (payload['previewPath'] as string).length > 0
    ? `tab://local/mint-preview/${(payload['previewPath'] as string).split(/[\\/]/).pop() ?? ''}`
    : null;
  // The mint face speaks the component's name and preview, never the raw definition JSON.
  const isMint = kind === 'component_proposal' || kind === 'import_component';
  const mintDef = isMint ? (payload['definition'] ?? payload['file']) : null;
  const mintName = mintDef !== null && typeof mintDef === 'object'
    && typeof (mintDef as Record<string, unknown>)['name'] === 'string'
    ? ((mintDef as Record<string, unknown>)['name'] as string) : null;
  // The connect face: the token goes straight to the vault; the value never enters payloads or the record.
  // Two doors share the face: connect_service (the dev-tool gallery) and integrations_connect (a placed
  // service node's own key - the payload carries secretName/tokenHelp/projectId; the secret is project-scoped).
  const isServiceKey = kind === 'integrations_connect';
  const isConnect = kind === 'connect_service' || isServiceKey;
  const serviceId = isConnect && typeof payload['service'] === 'string' ? (payload['service'] as string) : null;
  const keyProjectId = isServiceKey && typeof payload['projectId'] === 'string' ? (payload['projectId'] as string) : undefined;
  const planKeys = new Set(['tables', 'screens', 'flows', 'services']);
  const mintKeys = new Set(['definition', 'file', 'migration', 'shapeMapping', 'forkOf']);
  const keyRiders = new Set(['secretName', 'tokenHelp', 'projectId']);
  const metas = [
    ...(mintName !== null ? [{ label: 'component', value: mintName }] : []),
    ...Object.entries(payload)
      .filter(([k]) => !ENVELOPE_KEYS.has(k) && !(isPlan && planKeys.has(k)) && !(isMint && mintKeys.has(k)) && !(isServiceKey && keyRiders.has(k)))
      .map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: valueWords(v) })),
  ];

  const [tokenSpec, setTokenSpec] = useState<{ secretName: string; tokenHelp: string; command: string[] } | null>(null);
  const [token, setToken] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  const payloadSecretName = typeof payload['secretName'] === 'string' ? (payload['secretName'] as string) : null;
  const payloadTokenHelp = typeof payload['tokenHelp'] === 'string' ? (payload['tokenHelp'] as string) : '';
  useEffect(() => {
    if (!isConnect || gate.answeredAt !== null) return;
    if (isServiceKey) {
      if (payloadSecretName !== null) setTokenSpec({ secretName: payloadSecretName, tokenHelp: payloadTokenHelp, command: [] });
      return;
    }
    if (serviceId === null) return;
    void desk.listGalleryServices(orgId).then((gallery) => {
      const s = gallery.find((g) => g.id === serviceId);
      if (s) setTokenSpec({ secretName: s.secretName, tokenHelp: s.tokenHelp, command: s.command });
    }).catch(() => {});
  }, [isConnect, isServiceKey, serviceId, orgId, gate.answeredAt, payloadSecretName, payloadTokenHelp]);

  async function saveToken(): Promise<void> {
    if (!tokenSpec || token.length === 0) return;
    setSubmitting(true);
    const res = await desk.setSecret(orgId, tokenSpec.secretName, token, keyProjectId);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setToken('');
    setTokenSaved(true);
  }

  if (gate.answeredAt !== null) {
    // Approved gates render nothing; declined gates keep one quiet line.
    const approved = gate.answer !== null && (gate.answer as Record<string, unknown>)['approved'] === true;
    if (approved) return null;
    return (
      <div className={styles.answeredLine}>
        {kindWords(kind)} — {answeredChip(gate.answer)}
      </div>
    );
  }

  const canApprove = can(role, approvalAction(kind));

  async function respond(approved: boolean): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    const result = await desk.answerApproval(orgId, gate.id, approved);
    setSubmitting(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className={styles.cardWrap}>
      <div className={styles.card}>
        <div className={styles.cardTitle}>{isPlan ? 'App plan' : kindWords(kind)}</div>

        {/* Face 2: the citizen grid. Face 3: the rendered mint preview. Face 1: param rows. */}
        {isPlan ? <PlanGrid payload={payload} /> : null}
        {preview !== null ? <img className={styles.cardPreview} src={preview} alt="rendered preview" /> : null}
        {!isPlan ? metas.map((m, i) => (
          <div className={styles.cardRow} key={`${m.label}-${i}`}>
            <span className={styles.cardRowLabel}>{m.label}</span>
            <span className={styles.cardRowValue}>{m.value}</span>
          </div>
        )) : null}
        {lands ? <div className={styles.cardLands}>{lands}</div> : null}

        {/* Face 4: the one face with inputs — the key rides into the vault, never chat. */}
        {isConnect && tokenSpec ? (
          <div className={styles.cardField}>
            {tokenSpec.command.length > 0 ? (
              <div className={styles.cardRow}>
                <span className={styles.cardRowLabel}>runs</span>
                <span className={styles.cardRowValue}>{tokenSpec.command.join(' ')}</span>
              </div>
            ) : null}
            <div className={styles.cardQuiet}>{tokenSpec.tokenHelp}</div>
            {tokenSaved ? (
              <div className={styles.cardQuiet}>key in the vault · {tokenSpec.secretName}</div>
            ) : (
              <>
                <input
                  className={styles.cardInput}
                  type="password"
                  value={token}
                  placeholder={`${tokenSpec.secretName} — goes only to the vault`}
                  disabled={submitting}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button type="button" className={styles.cardBtnQuiet} disabled={submitting || token.length === 0} onClick={() => void saveToken()}>
                  Save to vault
                </button>
              </>
            )}
          </div>
        ) : null}

        {canApprove ? (
          <div className={styles.cardBtns}>
            <button type="button" className={styles.pBtnPrimary} disabled={submitting} onClick={() => void respond(true)}>
              Approve
            </button>
            <button type="button" className={styles.pBtnGhost} disabled={submitting} onClick={() => void respond(false)}>
              Decline
            </button>
            {askOnce ? <span className={styles.cardMemory}>remembered for this project</span> : null}
          </div>
        ) : (
          <div className={styles.cardQuiet}>waiting on a permitted role</div>
        )}
        {error ? <div className={styles.errorText}>{error}</div> : null}

        {rawText !== undefined && rawText !== '' ? (
          <>
            <button type="button" className={styles.rawToggle} onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? 'hide raw' : 'show raw'}
            </button>
            {showRaw ? <div className={styles.rawBox}>{rawText}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
