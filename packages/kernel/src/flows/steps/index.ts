import type { FlowStepDef } from '../stepTypes.js';
import { ifStep } from './if.js';
import { keepRowsStep } from './keep-rows.js';
import { editFieldsStep } from './edit-fields.js';
import { mergeStep } from './merge.js';
import { stopStep } from './stop.js';
import { waitStep } from './wait.js';
import { runFlowStep } from './run-flow.js';
import { callIntegrationStep } from './call-integration.js';
import { runToolStep } from './run-tool.js';
import { getRowsStep } from './get-rows.js';
import { saveRowsStep } from './save-rows.js';
import { splitByRulesStep } from './split-by-rules.js';
import { sortStep } from './sort.js';
import { limitStep } from './limit.js';
import { dedupeStep } from './dedupe.js';
import { oneRowPerStep } from './one-row-per.js';
import { aggregateStep } from './aggregate.js';
import { summarizeStep } from './summarize.js';
import { renameFieldsStep } from './rename-fields.js';
import { compareTablesStep } from './compare-tables.js';
import { dateTimeStep } from './date-time.js';
import { makeTextStep } from './make-text.js';
import { htmlStep } from './html.js';
import { markdownStep } from './markdown.js';
import { xmlStep } from './xml.js';
import { hashStep } from './hash.js';
import { calendarFileStep } from './calendar-file.js';
import { readFeedStep } from './read-feed.js';
import { batchesStep } from './batches.js';
import { doNothingStep } from './do-nothing.js';
import { screenEffectStep } from './screen-effect.js';
import { answerCallerStep } from './answer-caller.js';

/** The one array of step defs the registry consumes at module init; one def per file. */
export const FLOW_STEP_DEFS: FlowStepDef[] = [
  ifStep, keepRowsStep, editFieldsStep, mergeStep, stopStep, waitStep,
  runFlowStep, callIntegrationStep, runToolStep, getRowsStep, saveRowsStep,
  splitByRulesStep, sortStep, limitStep, dedupeStep, oneRowPerStep,
  aggregateStep, summarizeStep, renameFieldsStep, compareTablesStep,
  dateTimeStep, makeTextStep, htmlStep, markdownStep, xmlStep, hashStep,
  calendarFileStep, readFeedStep, batchesStep, doNothingStep, screenEffectStep,
  answerCallerStep,
];
