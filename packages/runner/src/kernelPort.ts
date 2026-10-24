import type postgres from 'postgres';
import {
  appendMergeConflictNote, buildTurnView, claimNextExecution, clearRunIsolation,
  completeRun, confirmDerivedOutputs, countDatasetRows, countRunSurfaceWrites,
  emitEvent, evaluateTriggers, failDeliveredRun, failRun, failStaleRuns,
  findProjectForPath, findWarmChainRef, gateRun, getOrgConfig, getRunStatus,
  getRunWorkspace, getThreadProjectId, hasRunningFolderOwner, heartbeatRun,
  landRowsOutput, listConnections, listFolderGrantPaths, listOrgIds,
  loadSpawnedRun, maybeSpawnLoopWake, persistRunPermissionRules, purgeExpiredTrash,
  queryDatasetRows, readDatasetRowsPage, registerDerivedOutput,
  rescueStalledIntents, resolveDerivedOutput, resolveOperation,
  rewriteDerivedOutputPathKeys, settleExecution,
  readProjectTheme, setWindowBridge, stampRunModel, triggerSweepDueOrgs, windowStepIfDue,
} from '@nodeloom/kernel';

// The kernel port: the runner speaks this interface instead of holding a sql handle.
// Verb signatures derive from the kernel functions so drift is a compile error.
// The queue verbs died with the loop collapse; spawned runs load by id and settle terminally.

/** Drops the leading `sql` parameter from a kernel function's signature. */
type PortFn<F> = F extends (sql: postgres.Sql, ...rest: infer A) => infer R ? (...args: A) => R : never;

export interface KernelPort {
  // -- the execute spine (runner.ts) --
  loadSpawnedRun: PortFn<typeof loadSpawnedRun>;
  gateRun: PortFn<typeof gateRun>;
  failRun: PortFn<typeof failRun>;
  emitEvent: PortFn<typeof emitEvent>;
  windowStepIfDue: PortFn<typeof windowStepIfDue>;
  setWindowBridge: PortFn<typeof setWindowBridge>;
  readProjectTheme: PortFn<typeof readProjectTheme>;
  buildTurnView: PortFn<typeof buildTurnView>;
  getOrgConfig: PortFn<typeof getOrgConfig>;
  findProjectForPath: PortFn<typeof findProjectForPath>;
  findWarmChainRef: PortFn<typeof findWarmChainRef>;
  heartbeatRun: PortFn<typeof heartbeatRun>;
  // -- the settle half (settle.ts) --
  completeRun: PortFn<typeof completeRun>;
  confirmDerivedOutputs: PortFn<typeof confirmDerivedOutputs>;
  maybeSpawnLoopWake: PortFn<typeof maybeSpawnLoopWake>;
  // -- the host lanes (sweeps.ts): crash reconciliation + housekeeping --
  failStaleRuns: PortFn<typeof failStaleRuns>;
  rescueStalledIntents: PortFn<typeof rescueStalledIntents>;
  purgeExpiredTrash: PortFn<typeof purgeExpiredTrash>;
  evaluateTriggers: PortFn<typeof evaluateTriggers>;
  triggerSweepDueOrgs: PortFn<typeof triggerSweepDueOrgs>;
  // -- the operation executor (ops/opExecutor.ts) --
  claimNextExecution: PortFn<typeof claimNextExecution>;
  settleExecution: PortFn<typeof settleExecution>;
  resolveOperation: PortFn<typeof resolveOperation>;
  resolveDerivedOutput: PortFn<typeof resolveDerivedOutput>;
  registerDerivedOutput: PortFn<typeof registerDerivedOutput>;
  landRowsOutput: PortFn<typeof landRowsOutput>;
  queryDatasetRows: PortFn<typeof queryDatasetRows>;
  // -- the mount half (mount.ts) --
  listConnections: PortFn<typeof listConnections>;

  // -- the runner verbs (kernel/src/runnerVerbs.ts) --
  persistRunPermissionRules: PortFn<typeof persistRunPermissionRules>;
  hasRunningFolderOwner: PortFn<typeof hasRunningFolderOwner>;
  clearRunIsolation: PortFn<typeof clearRunIsolation>;
  stampRunModel: PortFn<typeof stampRunModel>;
  failDeliveredRun: PortFn<typeof failDeliveredRun>;
  countRunSurfaceWrites: PortFn<typeof countRunSurfaceWrites>;
  getRunStatus: PortFn<typeof getRunStatus>;
  appendMergeConflictNote: PortFn<typeof appendMergeConflictNote>;
  rewriteDerivedOutputPathKeys: PortFn<typeof rewriteDerivedOutputPathKeys>;
  listOrgIds: PortFn<typeof listOrgIds>;
  getRunWorkspace: PortFn<typeof getRunWorkspace>;
  countDatasetRows: PortFn<typeof countDatasetRows>;
  readDatasetRowsPage: PortFn<typeof readDatasetRowsPage>;
  listFolderGrantPaths: PortFn<typeof listFolderGrantPaths>;
  getThreadProjectId: PortFn<typeof getThreadProjectId>;
}

/** Normalizes a raw sql handle (a function) or a port (a plain object) to a port. */
export function toKernelPort(db: postgres.Sql | KernelPort): KernelPort {
  return typeof db === 'function' ? createDirectKernelPort(db) : db;
}

/** The slice of verbs the desktop's heavy-operation executor needs. */
export type OpsKernelPort = Pick<KernelPort,
  'claimNextExecution' | 'settleExecution' | 'resolveOperation' | 'resolveDerivedOutput'
  | 'registerDerivedOutput' | 'landRowsOutput' | 'confirmDerivedOutputs' | 'queryDatasetRows'
  | 'countDatasetRows' | 'readDatasetRowsPage' | 'listFolderGrantPaths'>;

export function toOpsKernelPort(db: postgres.Sql | OpsKernelPort): OpsKernelPort {
  return typeof db === 'function' ? createDirectKernelPort(db) : db;
}

export function createDirectKernelPort(sql: postgres.Sql): KernelPort {
  return {
    loadSpawnedRun: (...a) => loadSpawnedRun(sql, ...a),
    gateRun: (...a) => gateRun(sql, ...a),
    failRun: (...a) => failRun(sql, ...a),
    emitEvent: (...a) => emitEvent(sql, ...a),
    windowStepIfDue: (...a) => windowStepIfDue(sql, ...a),
    setWindowBridge: (...a) => setWindowBridge(sql, ...a),
    readProjectTheme: (...a) => readProjectTheme(sql, ...a),
    buildTurnView: (...a) => buildTurnView(sql, ...a),
    getOrgConfig: (...a) => getOrgConfig(sql, ...a),
    findProjectForPath: (...a) => findProjectForPath(sql, ...a),
    findWarmChainRef: (...a) => findWarmChainRef(sql, ...a),
    heartbeatRun: (...a) => heartbeatRun(sql, ...a),
    completeRun: (...a) => completeRun(sql, ...a),
    confirmDerivedOutputs: (...a) => confirmDerivedOutputs(sql, ...a),
    maybeSpawnLoopWake: (...a) => maybeSpawnLoopWake(sql, ...a),
    failStaleRuns: (...a) => failStaleRuns(sql, ...a),
    rescueStalledIntents: (...a) => rescueStalledIntents(sql, ...a),
    purgeExpiredTrash: (...a) => purgeExpiredTrash(sql, ...a),
    evaluateTriggers: (...a) => evaluateTriggers(sql, ...a),
    triggerSweepDueOrgs: (...a) => triggerSweepDueOrgs(sql, ...a),
    claimNextExecution: (...a) => claimNextExecution(sql, ...a),
    settleExecution: (...a) => settleExecution(sql, ...a),
    resolveOperation: (...a) => resolveOperation(sql, ...a),
    resolveDerivedOutput: (...a) => resolveDerivedOutput(sql, ...a),
    registerDerivedOutput: (...a) => registerDerivedOutput(sql, ...a),
    landRowsOutput: (...a) => landRowsOutput(sql, ...a),
    queryDatasetRows: (...a) => queryDatasetRows(sql, ...a),
    listConnections: (...a) => listConnections(sql, ...a),

    persistRunPermissionRules: (...a) => persistRunPermissionRules(sql, ...a),
    hasRunningFolderOwner: (...a) => hasRunningFolderOwner(sql, ...a),
    clearRunIsolation: (...a) => clearRunIsolation(sql, ...a),
    stampRunModel: (...a) => stampRunModel(sql, ...a),
    failDeliveredRun: (...a) => failDeliveredRun(sql, ...a),
    countRunSurfaceWrites: (...a) => countRunSurfaceWrites(sql, ...a),
    getRunStatus: (...a) => getRunStatus(sql, ...a),
    appendMergeConflictNote: (...a) => appendMergeConflictNote(sql, ...a),
    rewriteDerivedOutputPathKeys: (...a) => rewriteDerivedOutputPathKeys(sql, ...a),
    listOrgIds: (...a) => listOrgIds(sql, ...a),
    getRunWorkspace: (...a) => getRunWorkspace(sql, ...a),
    countDatasetRows: (...a) => countDatasetRows(sql, ...a),
    readDatasetRowsPage: (...a) => readDatasetRowsPage(sql, ...a),
    listFolderGrantPaths: (...a) => listFolderGrantPaths(sql, ...a),
    getThreadProjectId: (...a) => getThreadProjectId(sql, ...a),
  };
}
