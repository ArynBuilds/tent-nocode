import { z } from 'zod';
import { NODE_ID_RE, SCENE_ROOT_ID, sceneDocumentSchema, type SceneDocument, type SceneNode } from './scene.js';
import { isExprValue } from './expr.js';

// THE CONTRACT (Phase 12, ruling 2; the 500-line law is waived - one system, one file).
// Five primitives - frame, text, field, chart, instance - declared once with every
// property typed (a zod schema, an initial value, a unit group, one hint line); the
// nine shared groups declared once and adopted; states and breakpoints as two
// dimensions on every group; the instance model; the element class; the typedef the
// AI reads. Property names follow one law: the CSS name where CSS has the concept,
// Figma's word where CSS has none (fill kinds, action, each, open, anchor, layout).

// ---------------------------------------------------------------------------
// Names, refs, the two dimensions.
// ---------------------------------------------------------------------------

export const PRIMITIVE_NAMES = ['frame', 'text', 'field', 'chart', 'instance'] as const;
export type PrimitiveName = (typeof PRIMITIVE_NAMES)[number];

/** The stored component key keeps the pinned-ref shape the document schema requires; the five are the namespace. */
export const PRIMITIVE_NAMESPACE = 'core';
const PRIMITIVE_VERSION = 1;

export function isPrimitiveName(word: string): word is PrimitiveName {
  return (PRIMITIVE_NAMES as readonly string[]).includes(word);
}

/** 'frame' -> the component key a node stores it under. */
export function primitiveRef(name: PrimitiveName): string {
  return `${PRIMITIVE_NAMESPACE}::${name}@${PRIMITIVE_VERSION}`;
}

/** A stored component key -> the primitive it names, or null for anything else. */
export function primitiveOfRef(ref: string): PrimitiveName | null {
  const m = /^([a-z0-9-]+)::([a-z0-9-]+)@(\d+)$/.exec(ref);
  if (m === null || m[1] !== PRIMITIVE_NAMESPACE) return null;
  return isPrimitiveName(m[2]!) ? m[2] : null;
}

/** The one primitive a node carries (the root may carry none - it reads as a frame). */
export function primitiveOfNode(node: Pick<SceneNode, 'components'>): { name: PrimitiveName; ref: string; payload: Record<string, unknown> } | null {
  for (const [ref, payload] of Object.entries(node.components)) {
    const name = primitiveOfRef(ref);
    if (name !== null) return { name, ref, payload: payload as Record<string, unknown> };
  }
  return null;
}

/** The state dimension (Webstudio's pseudo-classes, the four every property may vary by). */
export const STATE_NAMES = ['hover', 'focus', 'pressed', 'disabled'] as const;
export type StateName = (typeof STATE_NAMES)[number];

/** The breakpoint dimension: named widths the theme declares; these two stand when it declares none. */
export interface Breakpoint { minWidth?: number; maxWidth?: number }
export const DEFAULT_BREAKPOINTS: Readonly<Record<string, Breakpoint>> = {
  phone: { maxWidth: 767 },
  tablet: { minWidth: 768, maxWidth: 1023 },
};

export function breakpointsOf(theme?: { breakpoints?: Record<string, Breakpoint> } | null): Record<string, Breakpoint> {
  const declared = theme?.breakpoints;
  return declared !== undefined && Object.keys(declared).length > 0 ? declared : { ...DEFAULT_BREAKPOINTS };
}

// ---------------------------------------------------------------------------
// Value forms: a literal that fits the property, an expression, or a channel.
// ---------------------------------------------------------------------------

const CHANNEL_REF_RE = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.([a-z][a-zA-Z0-9-]{0,63})$/;

/** Exactly {from: '<node>.<emit>'} with one key. */
export function isChannelRef(v: unknown): v is { from: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r['from'] === 'string' && Object.keys(r).length === 1;
}

export function channelRefParts(from: string): { node: string; emit: string } | null {
  const m = CHANNEL_REF_RE.exec(from);
  return m === null ? null : { node: m[1]!, emit: m[2]! };
}

const exprValueSchema = z.object({ $expr: z.string().min(1), deps: z.array(z.string()).optional() }).strict();
const channelValueSchema = z.object({ from: z.string().regex(CHANNEL_REF_RE) }).strict();

/** Every property accepts its literal, an expression {$expr}, or a channel {from}. */
function withValueForms(schema: z.ZodTypeAny): z.ZodTypeAny {
  return z.union([schema, exprValueSchema, channelValueSchema]);
}

// ---------------------------------------------------------------------------
// The property definition (Webstudio's PropertyData: unit group, initial, hint).
// ---------------------------------------------------------------------------

export type UnitGroup = 'px' | 'percent' | 'number' | 'ms' | 'deg' | 'color' | 'font' | 'text' | 'word' | 'ref' | 'shape' | 'boolean';

export interface PropertyDef {
  schema: z.ZodTypeAny;
  /** One plain line - what the property does and how to write it. */
  hint: string;
  /** The value when unset; 'theme' marks a value the theme decides. */
  initial?: unknown;
  unit?: UnitGroup;
  /** Structure, never a look: excluded from the state and breakpoint dimensions. */
  fixed?: true;
  /** A fixed property the breakpoint dimension may still vary (structure that responds: layout). */
  atOk?: true;
  /** Hand-written teaching for the typedef alone: `type` replaces the schema expansion on the
   * property line; `lines` render as comment lines under it (the chart's channel dictionary).
   * The zod schema stays the validator's truth - teach changes only what the model reads. */
  teach?: { type: string; lines?: readonly string[] };
}
export type PropertyTable = Record<string, PropertyDef>;

// Leaf schemas; a described string renders its description as the type word in the typedef.
const color = z.string().min(1).max(80).describe('color');
const url = z.string().min(1).describe('url');
const nodeRef = z.string().regex(NODE_ID_RE).describe('node');
const screenRef = z.string().min(1).describe('screen');
const queryRef = z.string().min(1).describe('query');
const actionName = z.string().min(1).describe('action-name');
const sizeValue = z.union([z.number().min(0), z.enum(['fill', 'hug'])]);
const sides = z.union([
  z.number().min(0),
  z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() }).strict(),
]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

const gradientPaint = z.object({
  gradient: z.enum(['linear', 'radial', 'conic']), from: color, to: color, via: color.optional(), angle: z.number().optional(),
}).strict();
const imagePaint = z.object({ image: url, alt: z.string().optional() }).strict();
const videoPaint = z.object({
  video: url, poster: url.optional(), autoplay: z.boolean().optional(), loop: z.boolean().optional(), muted: z.boolean().optional(), controls: z.boolean().optional(),
}).strict();
const paint = z.union([color, gradientPaint, imagePaint, videoPaint]);
const paintList = z.array(paint).min(1).max(4).describe('paint[]');

const shadow = z.object({
  x: z.number(), y: z.number(), blur: z.number().min(0), spread: z.number().optional(), color, inset: z.boolean().optional(),
}).strict();
const shadowList = z.array(shadow).min(1).max(4).describe('shadow[]');
const filterShape = z.object({
  blur: z.number().min(0).optional(), brightness: z.number().min(0).optional(), contrast: z.number().min(0).optional(),
  saturate: z.number().min(0).optional(), grayscale: z.number().min(0).max(1).optional(), 'hue-rotate': z.number().optional(),
  invert: z.number().min(0).max(1).optional(), sepia: z.number().min(0).max(1).optional(),
}).strict();
const blendMode = z.enum([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);

/** The action a frame (or a field's change) fires - json-render's three arms plus the screen's own doors. */
export const actionSchema = z.union([
  z.object({ run: actionName, with: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ goto: screenRef, key: z.string().optional() }).strict(),
  z.object({ href: url, 'new-tab': z.boolean().optional() }).strict(),
  z.object({ open: nodeRef, on: z.enum(['click', 'hover']).optional() }).strict(),
  z.object({ close: z.union([nodeRef, z.literal(true)]) }).strict(),
  z.object({ toggle: nodeRef }).strict(),
  z.object({ copy: z.string().min(1) }).strict(),
]);
export type ActionValue = z.infer<typeof actionSchema>;

// ---------------------------------------------------------------------------
// THE SHARED GROUPS - declared once, adopted by the five.
// ---------------------------------------------------------------------------

export const GROUP_NAMES = ['fill', 'stroke', 'effects', 'size', 'position', 'states', 'motion', 'visibility', 'a11y'] as const;
export type GroupName = (typeof GROUP_NAMES)[number];

const FILL: PropertyTable = {
  fill: { schema: z.union([paint, paintList]), unit: 'color', hint: 'a theme color name (card, primary, accent...) or a literal; a list stacks paints bottom to top' },
  'fill-opacity': { schema: z.number().min(0).max(1), unit: 'number', initial: 1, hint: 'the paint alone fades, 0 to 1 (the content stays)' },
  'object-fit': { schema: z.enum(['cover', 'contain', 'fill', 'tile']), unit: 'word', initial: 'cover', hint: 'how an image or video paint sits in the box' },
  'object-position': { schema: z.string().min(1), unit: 'text', initial: 'center', hint: "where an image or video paint anchors: 'top', 'bottom left', '30% 60%'" },
};

const STROKE: PropertyTable = {
  'border-color': { schema: color, unit: 'color', hint: 'a theme name (border, primary) or a literal; setting it draws the border' },
  'border-width': { schema: sides, unit: 'px', initial: 1, hint: 'px, one number or per side' },
  'border-style': { schema: z.enum(['solid', 'dashed', 'dotted']), unit: 'word', initial: 'solid', hint: 'the line style' },
  'border-radius': {
    schema: z.union([
      z.number().min(0), z.enum(['theme', 'capsule', 'circle']),
      z.object({ 'top-left': z.number().optional(), 'top-right': z.number().optional(), 'bottom-right': z.number().optional(), 'bottom-left': z.number().optional() }).strict(),
    ]),
    unit: 'px', initial: 'theme', hint: "px or per corner; 'capsule' for one-line elements, 'circle' for avatars",
  },
  outline: { schema: z.object({ width: z.number().min(0), color, offset: z.number().optional() }).strict(), unit: 'shape', hint: 'a ring outside the border that takes no space - the focus ring lives here' },
};

const EFFECTS: PropertyTable = {
  'box-shadow': { schema: z.union([z.literal('theme'), shadow, shadowList]), unit: 'shape', hint: "'theme' takes the theme's shadow; a list stacks them" },
  filter: { schema: filterShape, unit: 'shape', hint: 'on the box itself; blur px, hue-rotate deg' },
  'backdrop-filter': { schema: filterShape, unit: 'shape', hint: 'the same filters on what shows through the box - frosted glass is {blur: 12}' },
  'mix-blend-mode': { schema: blendMode, unit: 'word', initial: 'normal', hint: 'how the box blends with what is under it' },
  transform: {
    schema: z.object({
      scale: z.union([z.number(), z.object({ x: z.number(), y: z.number() }).strict()]).optional(),
      translate: z.object({ x: z.number().optional(), y: z.number().optional() }).strict().optional(),
      skew: z.object({ x: z.number().optional(), y: z.number().optional() }).strict().optional(),
    }).strict(),
    unit: 'shape', hint: 'translate px, skew deg - the one property motion may animate cheaply; the turn itself is the rotation property in position',
  },
  'transform-origin': { schema: z.string().min(1), unit: 'text', initial: 'center', hint: "the point the transform turns and scales around: 'top left', '50% 100%'" },
};

const SIZE: PropertyTable = {
  width: { schema: sizeValue, unit: 'px', initial: 'hug', hint: "px; 'fill' grows along a flow axis and stretches across it, 'hug' fits the content" },
  height: { schema: sizeValue, unit: 'px', initial: 'hug', hint: 'px, as width' },
  'min-width': { schema: z.number().min(0), unit: 'px', hint: 'never narrower than this, px' },
  'max-width': { schema: z.number().min(0), unit: 'px', hint: 'never wider than this, px - a content column caps here' },
  'min-height': { schema: z.number().min(0), unit: 'px', hint: 'never shorter than this, px' },
  'max-height': { schema: z.number().min(0), unit: 'px', hint: 'never taller than this, px' },
  'aspect-ratio': { schema: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/)]), unit: 'number', hint: "width divided by height: 1.5 or '16 / 9' - the other side follows" },
};

const POSITION: PropertyTable = {
  x: { schema: z.number(), unit: 'px', initial: 0, hint: "px from the parent's left edge; under a row, column or grid parent the flow computes it and a write is ignored (free: true places by hand)" },
  y: { schema: z.number(), unit: 'px', initial: 0, hint: "px from the parent's top edge; computed the same way under a laid-out parent" },
  rotation: { schema: z.number(), unit: 'deg', initial: 0, hint: 'degrees around the top left corner' },
  free: { schema: z.boolean(), unit: 'boolean', initial: false, hint: "takes the child out of its parent's flow: its own x and y while still nesting inside (a badge on a card corner); pin says how it follows a resize" },
  pin: {
    schema: z.object({
      x: z.enum(['left', 'right', 'center', 'stretch', 'scale']).optional(),
      y: z.enum(['top', 'bottom', 'center', 'stretch', 'scale']).optional(),
    }).strict(),
    unit: 'shape', hint: "how x and y follow the parent's resize: 'stretch' spans both sides, 'scale' keeps the ratio - {x: 'right', y: 'top'} holds a corner; unset pins left and top",
  },
  cell: {
    schema: z.object({
      column: z.number().int().min(1).optional(), row: z.number().int().min(1).optional(),
      'column-span': z.number().int().min(1).optional(), 'row-span': z.number().int().min(1).optional(),
      'align-x': z.enum(['start', 'center', 'end']).optional(), 'align-y': z.enum(['start', 'center', 'end']).optional(),
    }).strict(),
    unit: 'shape', hint: 'grid: the cell occupied - column and row count from 1; omit what the grid should decide',
  },
  stick: { schema: z.enum(['top', 'bottom']), unit: 'word', hint: 'holds at that edge while the page scrolls past - a sticky nav or footer bar' },
};

const MOTION: PropertyTable = {
  transition: {
    schema: z.object({
      duration: z.number().min(0), easing: z.enum(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'spring']).optional(),
      delay: z.number().min(0).optional(), property: z.string().optional(),
    }).strict(),
    unit: 'shape', hint: "how a property change settles; duration and delay ms, property: 'all', 'transform', 'opacity' or 'fill'; 150-300 ease-out reads as calm",
  },
  enter: {
    schema: z.object({
      effect: z.enum(['fade', 'rise', 'slide-left', 'slide-right', 'scale', 'none']),
      at: z.enum(['appear', 'enter', 'half', 'full']).optional(), duration: z.number().min(0).optional(),
      delay: z.number().min(0).optional(), stagger: z.number().min(0).optional(),
    }).strict(),
    unit: 'shape', hint: "the entrance, once; at: 'appear' is on load, the rest how far into view; duration, delay and stagger ms - stagger spaces the children",
  },
  exit: {
    schema: z.object({ effect: z.enum(['fade', 'sink', 'slide-left', 'slide-right', 'scale', 'none']), duration: z.number().min(0).optional() }).strict(),
    unit: 'shape', hint: 'how it leaves when visible turns false or it closes',
  },
  parallax: { schema: z.object({ speed: z.number().min(-1).max(1) }).strict(), unit: 'shape', hint: 'drifts against the scroll; speed -1 to 1, 0 none' },
  animate: {
    schema: z.object({ effect: z.enum(['pulse', 'spin', 'float', 'bounce', 'shimmer']), duration: z.number().min(0).optional(), count: z.union([z.number().int().min(1), z.literal('infinite')]).optional() }).strict(),
    unit: 'shape', hint: 'a looping motion, duration ms - sparse, one element, never on text',
  },
};

const VISIBILITY: PropertyTable = {
  visible: {
    schema: z.union([z.boolean(), z.object({ field: nodeRef, is: scalar }).strict()]),
    unit: 'boolean', initial: true, hint: "an expression (expr(\"count('orders') > 0\")) or {field, is} shows only while that field holds the value",
  },
  opacity: { schema: z.number().min(0).max(1), unit: 'number', initial: 1, hint: 'the whole box fades, 0 to 1' },
  overflow: {
    schema: z.union([z.enum(['visible', 'hidden', 'scroll', 'auto']), z.object({ x: z.enum(['visible', 'hidden', 'scroll', 'auto']).optional(), y: z.enum(['visible', 'hidden', 'scroll', 'auto']).optional() }).strict()]),
    unit: 'word', initial: 'visible', hint: 'what happens past the edge; per axis with {x, y}',
  },
};

const A11Y: PropertyTable = {
  'aria-label': { schema: z.string().min(1).max(200), unit: 'text', hint: 'the spoken label when the visible words are not enough (an icon button, an image fill)' },
  role: { schema: z.string().min(1).max(40), unit: 'word', hint: "the landmark or widget role when the tag does not say it: 'button', 'navigation', 'dialog', 'tab', 'alert'" },
  'tab-index': { schema: z.number().int().min(-1), unit: 'number', hint: '-1 leaves the tab ring; omit for the natural order' },
};

export const SHARED_GROUPS: Readonly<Record<Exclude<GroupName, 'states'>, { title: string; properties: PropertyTable }>> = {
  fill: { title: 'fill', properties: FILL },
  stroke: { title: 'stroke', properties: STROKE },
  effects: { title: 'effects', properties: EFFECTS },
  size: { title: 'size and space', properties: SIZE },
  position: { title: 'position', properties: POSITION },
  motion: { title: 'motion', properties: MOTION },
  visibility: { title: 'visibility', properties: VISIBILITY },
  a11y: { title: 'a11y', properties: A11Y },
};

// ---------------------------------------------------------------------------
// THE FIVE - own properties.
// ---------------------------------------------------------------------------

const trackSize = z.union([z.number().min(0), z.enum(['hug', 'flex'])]);

const FRAME_OWN: PropertyTable = {
  layout: { schema: z.enum(['none', 'row', 'column', 'grid']), unit: 'word', initial: 'none', fixed: true, atOk: true, hint: "'none' places each child at its own x and y (the artboard feel); the others flow the children" },
  padding: { schema: sides, unit: 'px', initial: 0, hint: 'px between the frame edge and its children; the ladder is 4 8 12 16 24 32' },
  gap: { schema: z.union([z.number().min(0), z.object({ row: z.number().min(0).optional(), column: z.number().min(0).optional() }).strict()]), unit: 'px', initial: 0, hint: 'row, column and grid: px between children' },
  align: { schema: z.enum(['start', 'center', 'end', 'baseline']), unit: 'word', hint: "row and column: the cross axis; a child stretches by setting its own width or height to 'fill'" },
  justify: { schema: z.enum(['start', 'center', 'end', 'between']), unit: 'word', initial: 'start', hint: 'row and column: how children spread along the flow axis' },
  wrap: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'row: children that run out of room start a new line' },
  'wrap-align': { schema: z.enum(['auto', 'between']), unit: 'word', initial: 'auto', hint: "a wrapping row: 'auto' packs the lines by align, 'between' spreads them" },
  columns: { schema: z.number().int().min(1).max(24), unit: 'number', initial: 2, hint: 'grid: the number of columns' },
  rows: { schema: z.number().int().min(1).max(100), unit: 'number', hint: 'grid; omit to add rows as the children need them' },
  'column-sizes': { schema: z.array(trackSize).min(1).max(24), unit: 'shape', hint: "grid: one size per column; 'flex' shares the leftover space, omit for equal flex" },
  'row-sizes': { schema: z.array(trackSize).min(1).max(100), unit: 'shape', hint: 'grid: the same, one size per row' },
  flow: { schema: z.enum(['manual', 'auto']), unit: 'word', initial: 'auto', hint: "grid: 'auto' fills the next open cell in order; 'manual' keeps each child in the cell its cell property names" },
  'first-on-top': { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'the children order is the z-order, last on top unless this flips it' },
  tag: { schema: z.enum(['div', 'section', 'article', 'nav', 'header', 'footer', 'main', 'aside', 'form', 'ul', 'ol', 'li', 'a', 'button']), unit: 'word', initial: 'div', fixed: true, hint: "the published HTML element; an action frame publishes as 'button' or 'a' by itself" },
  action: { schema: actionSchema, unit: 'shape', fixed: true, teach: { type: '{ run, with? } | { goto, key? } | { href, new-tab? } | { open, on? } | { close } | { toggle } | { copy }' }, hint: "what a click does - this makes the frame a button; run fires a declared action, collecting the field children as its params; goto navigates (inside an each, key carries the row); href links out; open shows a closed or anchored frame (on: 'hover' works); copy puts the words on the clipboard" },
  disabled: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'the action does not fire and the disabled state applies' },
  each: {
    schema: z.union([queryRef, z.object({ query: queryRef, limit: z.number().int().min(1).max(500).optional(), empty: z.string().optional(), key: z.string().optional() }).strict()]),
    unit: 'ref', fixed: true, hint: "repeats the children once per row of the query; empty is the no-rows words, key the column that keeps rows apart; inside, row('<column>') reads the row",
  },
  open: { schema: z.boolean(), unit: 'boolean', initial: true, hint: 'false hides the children until an action opens it (a disclosure, a tab pane, a modal); a child with role \'tab\' or a sibling action toggles it' },
  exclusive: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'one child open at a time - a tab strip or an accordion' },
  anchor: {
    schema: z.object({
      to: z.union([nodeRef, z.literal('screen')]), side: z.enum(['top', 'bottom', 'left', 'right', 'center']).optional(),
      align: z.enum(['start', 'center', 'end']).optional(), offset: z.number().optional(),
      backdrop: z.union([color, z.boolean()]).optional(), dismiss: z.boolean().optional(),
    }).strict(),
    unit: 'shape', fixed: true, teach: { type: "{ to, side?, align?, offset?, backdrop?, dismiss? }" }, hint: "floats at an anchor instead of in the flow; to: a node or 'screen', offset px, backdrop: a color or true, dismiss: outside click and Esc close it - a modal is {to: 'screen', side: 'center', backdrop: true}, a drawer side: 'right', a popover or tooltip anchors to its trigger node",
  },
  'scroll-snap': { schema: z.enum(['none', 'x', 'y', 'both']), unit: 'word', initial: 'none', hint: 'children snap as the frame scrolls - a carousel is a row snapping on x' },
  autoplay: { schema: z.object({ interval: z.number().min(100), loop: z.boolean().optional(), 'pause-on-hover': z.boolean().optional() }).strict(), unit: 'shape', hint: 'a snapping frame advances by itself, interval ms - the slideshow' },
  cursor: { schema: z.enum(['default', 'pointer', 'grab', 'text', 'move', 'not-allowed', 'crosshair']), unit: 'word', hint: 'an action frame shows the pointer by itself' },
  'pointer-events': { schema: z.enum(['auto', 'none']), unit: 'word', initial: 'auto', hint: "'none' lets clicks pass through" },
  'user-select': { schema: z.boolean(), unit: 'boolean', initial: true, hint: 'false stops the words inside from being selected' },
};

const textRun = z.object({ text: z.string(), bold: z.boolean().optional(), italic: z.boolean().optional(), code: z.boolean().optional(), link: z.string().optional() }).strict();
const textBlock = z.object({
  kind: z.enum(['p', 'h1', 'h2', 'h3', 'h4', 'bullets', 'numbers', 'quote', 'code', 'table']),
  runs: z.array(textRun).optional(), items: z.array(z.array(textRun)).optional(),
  rows: z.array(z.array(z.union([z.string(), z.array(textRun)]))).optional(),
}).strict();

const TEXT_OWN: PropertyTable = {
  text: { schema: z.string(), unit: 'text', fixed: true, hint: "the words, or expr(\"...\") over a query - concat('Open: ', count('orders')), row('name')" },
  blocks: { schema: z.array(textBlock).min(1), unit: 'shape', fixed: true, hint: 'rich text instead of text; a run is {text, bold?, italic?, code?, link?}; items carries bullets and numbers, rows the table' },
  format: {
    schema: z.union([
      z.object({ number: z.object({ decimals: z.number().int().min(0).max(6).optional(), unit: z.string().optional(), currency: z.string().optional(), compact: z.boolean().optional() }).strict() }).strict(),
      z.object({ date: z.string().min(1) }).strict(),
      z.object({ relative: z.literal(true) }).strict(),
      z.object({ countdown: z.string().min(1) }).strict(),
      z.object({ clock: z.object({ hours: z.enum(['12', '24']).optional(), seconds: z.boolean().optional() }).strict() }).strict(),
    ]),
    unit: 'shape', fixed: true, hint: "{date: 'MMM d, yyyy'}; relative reads '3 hours ago'; countdown ticks to an ISO moment; clock is the live time; currency takes a code ('USD')",
  },
  tag: { schema: z.enum(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'code', 'pre', 'blockquote', 'li', 'caption']), unit: 'word', initial: 'p', fixed: true, hint: 'what the text IS on the published page' },
  'font-family': { schema: z.string().min(1).max(80), unit: 'font', initial: 'sans', hint: "'sans' or 'mono' (the theme's families) or a vendored family name" },
  'font-size': { schema: z.union([z.number().min(1), z.enum(['caption', 'small', 'body', 'title', 'heading', 'metric', 'hero'])]), unit: 'px', initial: 'body', hint: 'the ladder: caption 11, small 12, body 13, title 14, heading 16, metric 26, hero 40; body never under 14, nothing under 12' },
  'font-weight': { schema: z.number().int().min(100).max(900), unit: 'number', initial: 400, hint: '400 narration, 500 exactly where the news is, 600 emphasis and headers' },
  'font-style': { schema: z.enum(['normal', 'italic']), unit: 'word', initial: 'normal', hint: 'italic slants the whole run' },
  'line-height': { schema: z.number().min(0.8).max(3), unit: 'number', hint: 'a multiple of the size: 1.4 to 1.6 for body, 1.1 for a hero' },
  'letter-spacing': { schema: z.number().min(-10).max(20), unit: 'px', hint: 'px; negative tightens display type, 0.5 opens an uppercase label' },
  'text-transform': { schema: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']), unit: 'word', initial: 'none', hint: 'the words stay as typed' },
  'text-decoration': { schema: z.enum(['none', 'underline', 'line-through', 'overline']), unit: 'word', initial: 'none', hint: 'the decoration line' },
  'text-align': { schema: z.enum(['left', 'center', 'right', 'justify']), unit: 'word', initial: 'left', hint: 'the alignment inside its box' },
  'text-wrap': { schema: z.enum(['wrap', 'balance', 'pretty', 'nowrap']), unit: 'word', initial: 'wrap', hint: "'balance' evens a heading's lines, 'pretty' avoids a lone last word" },
  color: { schema: color, unit: 'color', initial: 'foreground', hint: "a theme name (foreground, mutedForeground, primary...) or a literal; on a filled frame use that fill's foreground" },
  'line-clamp': { schema: z.number().int().min(1).max(20), unit: 'number', hint: 'cut to this many lines with an ellipsis' },
  'white-space': { schema: z.enum(['normal', 'pre', 'pre-wrap']), unit: 'word', initial: 'normal', hint: "'pre' keeps typed line breaks and spaces" },
  'text-shadow': { schema: z.union([shadow, shadowList]), unit: 'shape', hint: 'a shadow under the letters' },
  tabular: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'digits keep one width - any number that changes or lines up in a column' },
  glyph: { schema: z.string().min(1).max(60), unit: 'word', fixed: true, hint: "an icon instead of words: a Lucide name ('check', 'arrow-right'); takes the font-size and color" },
  href: { schema: z.string().min(1), unit: 'ref', fixed: true, hint: "makes the words a link: a URL, or 'screen:<slug>' for a screen of this app" },
  copy: { schema: z.boolean(), unit: 'boolean', initial: false, fixed: true, hint: 'a click copies the words to the clipboard and says so' },
  'auto-fit': { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'the words shrink to fit the box - display headlines' },
};

const FIELD_OWN: PropertyTable = {
  kind: { schema: z.enum(['text', 'textarea', 'number', 'email', 'password', 'tel', 'url', 'select', 'multi-select', 'toggle', 'radio', 'date', 'date-range', 'time', 'search', 'file', 'range', 'color']), unit: 'word', initial: 'text', fixed: true, hint: 'what the input is; the notes below say what each kind takes' },
  name: { schema: z.string().regex(/^[a-z][a-zA-Z0-9-]{0,63}$/), unit: 'word', fixed: true, hint: "the action param this value fills when the enclosing frame's action runs" },
  label: { schema: z.string().min(1).max(120), unit: 'text', fixed: true, hint: 'the visible label, 2 to 4 plain words' },
  placeholder: { schema: z.string().max(200), unit: 'text', hint: 'the quiet words inside an empty input' },
  hint: { schema: z.string().max(300), unit: 'text', hint: 'one quiet line under the input' },
  value: { schema: z.union([scalar, z.array(scalar)]), unit: 'text', fixed: true, hint: 'the starting value' },
  options: {
    schema: z.union([
      z.array(z.union([z.string(), z.object({ label: z.string(), value: scalar }).strict()])).min(1),
      z.object({ query: queryRef, label: z.string().min(1), value: z.string().min(1) }).strict(),
    ]),
    unit: 'shape', fixed: true, hint: 'a list of words, [{label, value}], or the query form taking the choices from rows - its label and value name columns',
  },
  required: { schema: z.boolean(), unit: 'boolean', initial: false, fixed: true, hint: 'the action refuses to fire without it' },
  disabled: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'takes no input and applies the disabled state' },
  readonly: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'shows its value and takes no edits' },
  min: { schema: z.union([z.number(), z.string()]), unit: 'number', hint: 'the smallest legal value' },
  max: { schema: z.union([z.number(), z.string()]), unit: 'number', hint: 'the largest legal value' },
  step: { schema: z.number().positive(), unit: 'number', hint: 'the distance between legal values' },
  pattern: { schema: z.string().min(1), unit: 'text', hint: 'a regular expression the text must match' },
  maxlength: { schema: z.number().int().min(1).max(100000), unit: 'number', hint: 'the most characters the input takes' },
  autofocus: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'takes focus when the screen opens' },
  autocomplete: { schema: z.string().min(1).max(40), unit: 'word', hint: "the browser autofill hint: 'email', 'name', 'tel', 'off'" },
  rows: { schema: z.number().int().min(1).max(40), unit: 'number', hint: 'how many lines tall it starts' },
  accept: { schema: z.string().min(1), unit: 'text', hint: "the kinds taken: 'image/*' or '.csv,.xlsx'" },
  multiple: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'several files at once' },
  filters: { schema: z.object({ query: queryRef, columns: z.array(z.string().min(1)).min(1) }).strict(), unit: 'shape', fixed: true, hint: "narrows the query's rows to those whose columns contain the typed words, live" },
  'on-change': { schema: actionSchema, unit: 'shape', fixed: true, teach: { type: 'action' }, hint: 'fires whenever the value changes - the same shapes a frame action takes' },
  glyph: { schema: z.string().min(1).max(60), unit: 'word', hint: 'a Lucide icon inside the input at its start' },
  error: { schema: z.string().min(1).max(200), unit: 'text', hint: 'the words when the value fails required, pattern, min or max' },
  prefix: { schema: z.string().min(1).max(20), unit: 'text', hint: "fixed words at the start of the input: '$', '+1'" },
  suffix: { schema: z.string().min(1).max(20), unit: 'text', hint: "fixed words at the end of the input: 'kg', '%'" },
};

const channelDef = z.union([
  z.string().min(1),
  z.object({
    field: z.string().min(1).optional(), type: z.enum(['quantitative', 'ordinal', 'nominal', 'temporal']).optional(),
    aggregate: z.enum(['count', 'sum', 'mean', 'median', 'min', 'max', 'distinct']).optional(),
    bin: z.union([z.boolean(), z.object({ step: z.number().positive().optional(), maxbins: z.number().int().min(2).optional() }).strict()]).optional(),
    'time-unit': z.enum(['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute']).optional(),
    sort: z.union([z.enum(['ascending', 'descending']), z.string().min(1), z.array(scalar)]).optional(),
    title: z.string().optional(), format: z.string().optional(),
    scale: z.object({
      type: z.enum(['linear', 'log', 'sqrt', 'time', 'band', 'point', 'ordinal']).optional(),
      domain: z.array(scalar).optional(), range: z.array(scalar).optional(), zero: z.boolean().optional(), nice: z.boolean().optional(),
    }).strict().optional(),
    value: scalar.optional(),
  }).strict(),
]);
const axisDef = z.union([z.literal(false), z.object({
  title: z.string().optional(), grid: z.boolean().optional(), ticks: z.boolean().optional(), labels: z.boolean().optional(),
  format: z.string().optional(), 'tick-count': z.number().int().min(1).optional(), 'label-angle': z.number().optional(), domain: z.boolean().optional(),
}).strict()]);
const encodingShape = z.object({
  x: channelDef.optional(), y: channelDef.optional(), x2: channelDef.optional(), y2: channelDef.optional(),
  theta: channelDef.optional(), radius: channelDef.optional(), color: channelDef.optional(), size: channelDef.optional(),
  opacity: channelDef.optional(), shape: channelDef.optional(), order: channelDef.optional(), detail: channelDef.optional(),
  text: channelDef.optional(), tooltip: z.union([channelDef, z.array(channelDef), z.literal(false)]).optional(),
}).strict();
const layerDef = z.object({
  mark: z.enum(['line', 'area', 'bar', 'point', 'rule', 'text', 'tick']), query: queryRef.optional(),
  encoding: encodingShape.optional(),
  interpolate: z.enum(['linear', 'monotone', 'step', 'basis', 'natural']).optional(), point: z.boolean().optional(),
}).strict();

const CHART_OWN: PropertyTable = {
  query: { schema: queryRef, unit: 'ref', fixed: true, hint: 'the query whose rows the chart draws' },
  mark: { schema: z.enum(['line', 'area', 'bar', 'point', 'arc', 'rect', 'rule', 'text', 'tick', 'gauge']), unit: 'word', initial: 'bar', fixed: true, hint: "what one row draws as; 'arc' is pie and donut through theta, 'rect' the heatmap, 'gauge' one bounded value through theta" },
  encoding: {
    schema: encodingShape, unit: 'shape', fixed: true,
    hint: "which columns drive the marks - the dictionary below; the node's own x and y stay geometry",
    teach: {
      type: '{ x?, y?, x2?, y2?, theta?, radius?, color?, size?, opacity?, shape?, order?, detail?, text?, tooltip? }',
      lines: [
        "a channel's value, the same for every channel: a column name ('month'), or { field?: '<column>', type?: 'quantitative' | 'ordinal' | 'nominal' | 'temporal', aggregate?: 'count' | 'sum' | 'mean' | 'median' | 'min' | 'max' | 'distinct', bin?: true | { step?, maxbins? }, 'time-unit'?: 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute', sort?: 'ascending' | 'descending' | [values], title?, format?, scale?: { type?, domain?, range?, zero?, nice? }, value?: a literal instead of a column }",
        'x - horizontal position of the marks; the category axis of a vertical bar',
        'y - vertical position; the value axis of a vertical bar',
        "x2, y2 - the far edge of ranged 'bar', 'area' and 'rule' marks (a span from x to x2)",
        "theta - the arc angle: a slice's share on 'arc', the needle's value on 'gauge'",
        'radius - the arc radius when a column should drive it',
        'color - one column splits the rows into colored series (the legend follows)',
        "size - the mark's size from a column (a point's area, a text's font size)",
        "opacity - the mark's opacity from a column",
        "shape - the point symbol per category ('point' marks)",
        "order - stacking and drawing order; a connected line's point order",
        'detail - splits rows into series without any visual change',
        "text - the words a 'text' mark writes",
        'tooltip - what hovering shows: one channel, a list of channels, or false for none',
      ],
    },
  },
  orient: { schema: z.enum(['vertical', 'horizontal']), unit: 'word', initial: 'vertical', hint: 'bar, tick and area: which way the value runs' },
  interpolate: { schema: z.enum(['linear', 'monotone', 'step', 'basis', 'natural']), unit: 'word', initial: 'linear', hint: 'line and area smoothing' },
  point: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'line and area: draw a marker at every point' },
  line: { schema: z.boolean(), unit: 'boolean', initial: false, hint: 'area: draw the top edge as a line' },
  'corner-radius': { schema: z.number().min(0), unit: 'px', initial: 0, hint: 'bar and rect: rounded ends' },
  'stroke-width': { schema: z.number().min(0), unit: 'px', initial: 2, hint: 'line, rule and tick thickness' },
  'stroke-dash': { schema: z.array(z.number().min(0)).min(2).max(4), unit: 'shape', hint: 'line and rule: [dash, gap] px' },
  'inner-radius': { schema: z.number().min(0), unit: 'px', initial: 0, hint: 'arc and gauge: the hole - a donut is 60' },
  'outer-radius': { schema: z.number().min(0), unit: 'px', hint: 'arc and gauge; omit to fit the box' },
  'pad-angle': { schema: z.number().min(0), unit: 'deg', initial: 0, hint: 'arc: the gap between slices' },
  band: { schema: z.number().min(0.05).max(1), unit: 'number', initial: 0.8, hint: 'bar and tick: the share of the step a bar fills' },
  stack: { schema: z.union([z.enum(['zero', 'normalize', 'center']), z.literal(false)]), unit: 'word', initial: 'zero', hint: "bars and areas sharing an x: 'normalize' stacks to 100 percent, 'center' streams, false overlays" },
  'x-axis': { schema: axisDef, unit: 'shape', hint: 'false hides it' },
  'y-axis': { schema: axisDef, unit: 'shape', hint: 'as x-axis' },
  grid: { schema: z.union([z.boolean(), z.object({ x: z.boolean().optional(), y: z.boolean().optional() }).strict()]), unit: 'boolean', initial: true, hint: 'per axis with {x, y}; false with both axes false is the word-sized spark' },
  legend: { schema: z.union([z.boolean(), z.object({ orient: z.enum(['top', 'bottom', 'left', 'right']).optional(), title: z.string().optional(), direction: z.enum(['vertical', 'horizontal']).optional() }).strict()]), unit: 'shape', initial: true, hint: 'shows when color or shape encodes a column' },
  title: { schema: z.string().max(120), unit: 'text', hint: 'the chart title' },
  subtitle: { schema: z.string().max(200), unit: 'text', hint: 'one quiet line under the title' },
  format: { schema: z.string().min(1), unit: 'text', hint: "the default number or date format for labels and tooltips: '.1f', '%b %d'" },
  scheme: { schema: z.union([z.enum(['series', 'status']), z.array(color).min(1).max(8)]), unit: 'color', initial: 'series', hint: "'series' is the theme's monochrome ramp, 'status' green, amber, red in order; or a list of theme names" },
  animation: { schema: z.union([z.boolean(), z.object({ duration: z.number().min(0) }).strict()]), unit: 'shape', initial: true, hint: 'marks grow in on load and move on data change; false snaps' },
  labels: { schema: z.union([z.boolean(), z.object({ format: z.string().optional(), position: z.enum(['inside', 'outside', 'center']).optional() }).strict()]), unit: 'shape', initial: false, hint: 'the value written on or beside every mark' },
  thresholds: { schema: z.array(z.object({ 'up-to': z.number(), color }).strict()).min(1).max(6), unit: 'shape', hint: "gauge: status bands ({up-to: 60, color: 'green'}...) - status meaning alone" },
  'on-pick': { schema: actionSchema, unit: 'shape', fixed: true, teach: { type: 'action' }, hint: 'fires on a mark click, the picked row riding as the params - the same shapes a frame action takes' },
  empty: { schema: z.string().max(120), unit: 'text', hint: 'the quiet words when the query has no rows' },
  layers: {
    schema: z.array(layerDef).min(1).max(6), unit: 'shape', fixed: true,
    hint: 'more marks over the same scales - a target rule over revenue bars',
    teach: {
      type: 'layer[]',
      lines: ["each layer: { mark: 'line' | 'area' | 'bar' | 'point' | 'rule' | 'text' | 'tick', query?: another query drawn on the same scales, encoding?: the same channels as encoding above, interpolate?, point? }"],
    },
  },
};

const INSTANCE_OWN: PropertyTable = {
  component: { schema: z.string().min(1), unit: 'ref', fixed: true, hint: 'the library item this places, by name or name@version to pin; mint with the `component <name>` construct' },
  variant: { schema: z.string().min(1).max(60), unit: 'word', fixed: true, hint: 'one of the variants the item declares' },
  overrides: { schema: z.record(z.string().regex(NODE_ID_RE), z.record(z.string(), z.unknown())), unit: 'shape', fixed: true, hint: "per exposed child: {'<child id>': {property: value}}; the item names which children are exposed" },
};

export interface PrimitiveDef {
  name: PrimitiveName;
  title: string;
  /** What it is, in one breath. */
  breath: string;
  /** The always-prompt routing row: shape summary + when this one is the right pick + what it is not for. */
  route: { summary: string; useWhen: string; notFor: string };
  own: PropertyTable;
  groups: readonly Exclude<GroupName, 'states'>[];
  /** Whether the node takes children. */
  children: 'any' | 'none';
  emits: Readonly<Record<string, { type: string; hint: string }>>;
  /** Prose teaching lines rendered after the own properties (field's per-kind narrowing). */
  notes?: readonly string[];
  examples: readonly { title: string; payload: Record<string, unknown> }[];
}

const EVERY_GROUP = ['fill', 'stroke', 'effects', 'size', 'position', 'motion', 'visibility', 'a11y'] as const;

export const PRIMITIVES: Readonly<Record<PrimitiveName, PrimitiveDef>> = {
  frame: {
    name: 'frame', title: 'Frame',
    breath: 'a box: lays out its children (none: each at its own x and y; row, column, or grid), is painted (fill: a color, a gradient, an image, a video), has an action (a button), repeats per row (each), opens and closes (tabs, disclosure), floats at an anchor (modal, popover, tooltip, drawer), snaps on scroll (carousel)',
    route: {
      summary: 'a box - lays out children (none = free x/y, row, column, grid), paints, clicks, repeats, opens, floats',
      useWhen: 'any container, card, section or list (each); anything clickable - a button IS a frame with an action; a modal, drawer or popover (anchor); tabs and disclosure (open)',
      notFor: 'words (that is a text) or collecting one value (that is a field)',
    },
    own: FRAME_OWN, groups: EVERY_GROUP, children: 'any',
    emits: { open: { type: 'boolean', hint: 'whether it is open right now' } },
    examples: [
      { title: 'a card', payload: { layout: 'column', gap: 8, padding: 16, fill: 'card', 'border-radius': 'theme' } },
      { title: 'a primary button', payload: { layout: 'row', align: 'center', padding: { top: 8, right: 16, bottom: 8, left: 16 }, fill: 'primary', 'border-radius': 'capsule', action: { run: 'add-order' }, states: { hover: { fill: 'accent' } } } },
      { title: 'a list over a query', payload: { layout: 'column', gap: 4, each: { query: 'orders', limit: 50, empty: 'No orders yet' } } },
    ],
  },
  text: {
    name: 'text', title: 'Text',
    breath: 'words: one block or rich blocks; family, size, weight, leading, tracking, case, decoration, alignment, clamp; a theme color; a value with a format (number, date, countdown, clock); tabular digits; a glyph',
    route: {
      summary: 'words or an icon - family, size, weight, color; a live value with expr() and a format',
      useWhen: 'any words - headings, labels, paragraphs, links (href), icons (glyph); a single number or metric is a text with an expr and a format, not a chart',
      notFor: 'input (that is a field) or a button (a frame with an action, with a text child)',
    },
    own: TEXT_OWN, groups: EVERY_GROUP, children: 'none',
    emits: {},
    examples: [
      { title: 'a heading', payload: { text: 'This week', tag: 'h2', 'font-size': 'heading', 'font-weight': 600 } },
      { title: 'a live count', payload: { text: { $expr: "count('orders')", deps: ['bindings.orders'] }, 'font-size': 'metric', tabular: true } },
      { title: 'an icon', payload: { glyph: 'trending-up', 'font-size': 16, color: 'mutedForeground' } },
    ],
  },
  field: {
    name: 'field', title: 'Field',
    breath: 'one input whose kind says what it is: text, textarea, number, email, password, tel, url, select, multi-select, toggle, radio, date, date-range, time, search, file, range, color',
    route: {
      summary: 'one input - kind picks the control (text, select, toggle, date, file, search...)',
      useWhen: 'collecting one value from the reader; a search kind filters a query live',
      notFor: 'showing a value (that is a text) or a clickable thing (a frame with an action, not a field)',
    },
    own: FIELD_OWN, groups: EVERY_GROUP, children: 'none',
    emits: { value: { type: 'any', hint: 'the current value, live' } },
    notes: [
      'which properties matter per kind:',
      'select, multi-select, radio -> options (required); a multi-select value is a list',
      'number, range -> min, max, step',
      'date, date-range, time -> min, max (ISO strings); date-range fills <name>-from and <name>-to',
      'textarea -> rows',
      'file -> accept, multiple',
      'search -> filters { query, columns }',
      'toggle -> value: true | false',
      'text, email, password, tel, url -> pattern, maxlength, autocomplete, prefix, suffix',
    ],
    examples: [
      { title: 'a name input', payload: { kind: 'text', name: 'customer', label: 'Customer', placeholder: 'Ada Lovelace', required: true } },
      { title: 'a status picker', payload: { kind: 'select', name: 'status', label: 'Status', options: ['open', 'paid', 'shipped'] } },
    ],
  },
  chart: {
    name: 'chart', title: 'Chart',
    breath: 'one chart whose mark says what it draws, bound to a query; the encoding shape carries the Vega channels (x, y, color, size, opacity, order, tooltip...); axes, grid, ticks, format, legend, stacking, smoothing, markers and animation are properties; its own x and y place it like any node',
    route: {
      summary: 'rows drawn as marks over a query - mark + encoding channels; axes, legend, stacking as properties',
      useWhen: 'trends, comparisons, shares and distributions over rows - several values in one picture',
      notFor: 'a single number (a text with an expr and a format) or a row list (a frame with each)',
    },
    own: CHART_OWN, groups: EVERY_GROUP, children: 'none',
    emits: { picked: { type: 'row', hint: 'the row of the mark the reader clicked' } },
    examples: [
      { title: 'revenue by month', payload: { query: 'revenue', mark: 'bar', encoding: { x: 'month', y: { field: 'amount', aggregate: 'sum' } }, height: 240 } },
      { title: 'a donut of shares', payload: { query: 'shares', mark: 'arc', encoding: { theta: 'share', color: 'segment' }, 'inner-radius': 60, legend: { orient: 'right' } } },
      { title: 'a gauge', payload: { query: 'load', mark: 'gauge', encoding: { theta: { field: 'percent', scale: { domain: [0, 100] } } }, thresholds: [{ 'up-to': 60, color: 'green' }, { 'up-to': 85, color: 'amber' }, { 'up-to': 100, color: 'red' }] } },
    ],
  },
  instance: {
    name: 'instance', title: 'Instance',
    breath: 'a placed library item; the library starts empty - build a thing once from the other four, mint it with Save as component, then place instances that pick a variant and override exposed children',
    route: {
      summary: 'a placed library item - picks a variant, overrides its exposed children',
      useWhen: 'placing a component you already minted: build it once from the other four, Save as component, then place it everywhere',
      notFor: 'the first build of anything - the library starts empty until you mint',
    },
    own: INSTANCE_OWN, groups: ['size', 'position', 'motion', 'visibility', 'a11y'], children: 'none',
    emits: {},
    examples: [
      { title: 'a minted card, placed', payload: { component: 'pricing-card', overrides: { title: { text: 'Pro' }, price: { text: '$29' } } } },
    ],
  },
};

/** Every property a primitive takes, own first then its shared groups in order. */
export function propertiesOf(name: PrimitiveName): PropertyTable {
  const def = PRIMITIVES[name];
  const out: PropertyTable = { ...def.own };
  for (const g of def.groups) for (const [k, p] of Object.entries(SHARED_GROUPS[g].properties)) if (!(k in out)) out[k] = p;
  return out;
}

/** The properties the state dimension may vary (the look, never the structure). */
export function variableProperties(name: PrimitiveName): PropertyTable {
  const out: PropertyTable = {};
  for (const [k, p] of Object.entries(propertiesOf(name))) if (p.fixed !== true) out[k] = p;
  return out;
}

/** The properties a breakpoint block may vary: the look, plus the fixed few marked atOk (layout responds). */
export function atProperties(name: PrimitiveName): PropertyTable {
  const out: PropertyTable = {};
  for (const [k, p] of Object.entries(propertiesOf(name))) if (p.fixed !== true || p.atOk === true) out[k] = p;
  return out;
}

/** The initial values a primitive carries when unset, own then shared. */
export function initialValues(name: PrimitiveName): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(propertiesOf(name))) if (p.initial !== undefined) out[k] = p.initial;
  return out;
}

// ---------------------------------------------------------------------------
// The payload schemas: the node's primitive block, strict; states and at as
// nested partials of the variable properties.
// ---------------------------------------------------------------------------

function tableShape(table: PropertyTable): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const [k, p] of Object.entries(table)) shape[k] = withValueForms(p.schema).optional();
  return shape;
}

const schemaCache = new Map<string, z.ZodTypeAny>();

/** The partial a state block carries. */
export function stateBlockSchema(name: PrimitiveName): z.ZodTypeAny {
  const key = `state:${name}`;
  const hit = schemaCache.get(key);
  if (hit !== undefined) return hit;
  const s = z.object(tableShape(variableProperties(name))).strict();
  schemaCache.set(key, s);
  return s;
}

/** The partial a breakpoint block carries: the state partial plus the atOk properties (its own cache key). */
export function atBlockSchema(name: PrimitiveName): z.ZodTypeAny {
  const key = `at:${name}`;
  const hit = schemaCache.get(key);
  if (hit !== undefined) return hit;
  const s = z.object(tableShape(atProperties(name))).strict();
  schemaCache.set(key, s);
  return s;
}

/** The whole payload a node stores under its primitive key. */
export function payloadSchema(name: PrimitiveName, breakpoints: readonly string[] = Object.keys(DEFAULT_BREAKPOINTS)): z.ZodTypeAny {
  const key = `payload:${name}:${breakpoints.join(',')}`;
  const hit = schemaCache.get(key);
  if (hit !== undefined) return hit;
  const stateBlock = stateBlockSchema(name);
  const statesShape: z.ZodRawShape = {};
  for (const st of STATE_NAMES) statesShape[st] = stateBlock.optional();
  const atBlock = atBlockSchema(name);
  const atShape: z.ZodRawShape = {};
  for (const bp of breakpoints) atShape[bp] = atBlock.optional();
  const s = z.object({
    ...tableShape(propertiesOf(name)),
    states: z.object(statesShape).strict().optional(),
    at: z.object(atShape).strict().optional(),
  }).strict();
  schemaCache.set(key, s);
  return s;
}

/** The instance model's document side: a library item is a document of the five plus the children an instance may override. */
export const libraryItemSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'an item name is kebab-case words'),
  version: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  keywords: z.string().min(1).optional(),
  document: sceneDocumentSchema,
  /** The child ids an instance may override; the root is always overridable. */
  exposed: z.array(z.string().regex(NODE_ID_RE)).default([]),
  /** Named presets: variant -> child id -> the properties it sets. */
  variants: z.record(z.string().min(1), z.record(z.string().regex(NODE_ID_RE), z.record(z.string(), z.unknown()))).default({}),
  examples: z.array(z.object({ title: z.string(), payload: z.record(z.string(), z.unknown()) }).strict()).optional(),
}).strict();
export type LibraryItem = z.infer<typeof libraryItemSchema>;

export function libraryItemRef(item: Pick<LibraryItem, 'name' | 'version'>): string {
  return `${item.name}@${item.version}`;
}

// ---------------------------------------------------------------------------
// The element class: what a node does on the map - navigates, acts, or displays.
// ---------------------------------------------------------------------------

export type ElementClass = 'nav' | 'action' | 'display';

export function elementClassOf(components: Record<string, Record<string, unknown>>): ElementClass {
  const p = primitiveOfNode({ components });
  if (p === null) return 'display';
  if (p.name === 'frame') {
    const action = p.payload['action'];
    if (typeof action === 'object' && action !== null && !Array.isArray(action)) {
      const a = action as Record<string, unknown>;
      return 'goto' in a || 'href' in a ? 'nav' : 'action';
    }
    return 'display';
  }
  if (p.name === 'text') return typeof p.payload['href'] === 'string' ? 'nav' : 'display';
  if (p.name === 'field') return 'action';
  return 'display';
}

// ---------------------------------------------------------------------------
// Instance expansion (Figma's instance = the main component's tree under the
// instance node, the overrides on top): pure, over a resolver.
// ---------------------------------------------------------------------------

export const MAX_INSTANCE_DEPTH = 8;
export type LibraryItemResolver = (nameOrRef: string) => LibraryItem | null;

function mappedId(instanceId: string, childId: string): string {
  const joined = `${instanceId}-${childId}`;
  return joined.length <= 64 ? joined : `${instanceId.slice(0, 63 - childId.length)}-${childId}`.slice(0, 64);
}

/** Every instance node becomes its item's tree; overrides land on the exposed children; nested instances recurse. */
export function expandInstanceNodes(doc: SceneDocument, resolve: LibraryItemResolver): { doc: SceneDocument; errors: string[] } {
  const errors: string[] = [];
  const out: Record<string, SceneNode> = {};
  const expand = (node: SceneNode, stack: string[]): void => {
    const p = primitiveOfNode(node);
    if (p === null || p.name !== 'instance') { out[node.id] = node; return; }
    const ref = typeof p.payload['component'] === 'string' ? p.payload['component'] : '';
    const item = ref.length > 0 ? resolve(ref) : null;
    if (item === null) {
      errors.push(`node '${node.id}': instance of '${ref}' does not resolve - the node renders as absence`);
      out[node.id] = { ...node, components: {} };
      return;
    }
    if (stack.length >= MAX_INSTANCE_DEPTH || stack.includes(item.name)) {
      errors.push(`node '${node.id}': instance of '${ref}' ${stack.includes(item.name) ? 'cycles' : `nests past depth ${MAX_INSTANCE_DEPTH}`} - expansion stops here`);
      out[node.id] = { ...node, components: {} };
      return;
    }
    const itemRoot = item.document.nodes[SCENE_ROOT_ID];
    if (itemRoot === undefined) {
      errors.push(`node '${node.id}': item '${item.name}' has no root - nothing expands`);
      out[node.id] = { ...node, components: {} };
      return;
    }
    const map = (id: string): string => (id === SCENE_ROOT_ID ? node.id : mappedId(node.id, id));
    // The variant's and the overrides' property sets, child id -> properties; root overrides ride on the instance's own shared groups.
    const variant = typeof p.payload['variant'] === 'string' ? item.variants[p.payload['variant']] : undefined;
    const overrides = (typeof p.payload['overrides'] === 'object' && p.payload['overrides'] !== null ? p.payload['overrides'] : {}) as Record<string, Record<string, unknown>>;
    const patches = new Map<string, Record<string, unknown>>();
    for (const source of [variant ?? {}, overrides]) {
      for (const [childId, props] of Object.entries(source)) {
        if (childId !== SCENE_ROOT_ID && !item.exposed.includes(childId)) {
          errors.push(`node '${node.id}': override targets '${childId}' which '${item.name}' does not expose (${item.exposed.join(', ') || 'nothing'})`);
          continue;
        }
        patches.set(childId, { ...(patches.get(childId) ?? {}), ...props });
      }
    }
    const produced: SceneNode[] = [];
    for (const child of Object.values(item.document.nodes)) {
      const cloned = structuredClone(child);
      const isRoot = child.id === SCENE_ROOT_ID;
      const mapped: SceneNode = {
        ...cloned, id: map(child.id), parent: isRoot ? node.parent : map(child.parent ?? SCENE_ROOT_ID), order: isRoot ? node.order : cloned.order,
      };
      if (isRoot) {
        if (node.slot !== undefined) mapped.slot = node.slot; else delete mapped.slot;
        if (node.variantOf !== undefined) mapped.variantOf = node.variantOf; else delete mapped.variantOf;
        // The instance node's own shared groups (position, motion, visibility, a11y) ride onto the root's primitive.
        const rootPrim = primitiveOfNode(mapped);
        if (rootPrim !== null) {
          const own: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(p.payload)) if (!(k in INSTANCE_OWN)) own[k] = v;
          mapped.components[rootPrim.ref] = { ...rootPrim.payload, ...own };
        }
        (mapped as Record<string, unknown>)['instanceOf'] = libraryItemRef(item);
      } else {
        (mapped as Record<string, unknown>)['fromInstance'] = node.id;
      }
      const patch = patches.get(child.id);
      if (patch !== undefined) {
        const prim = primitiveOfNode(mapped);
        if (prim !== null) mapped.components[prim.ref] = { ...prim.payload, ...patch };
      }
      for (const [k, target] of Object.entries(mapped.refs ?? {})) {
        if (!target.startsWith('scene:') && item.document.nodes[target] !== undefined) mapped.refs![k] = map(target);
      }
      produced.push(mapped);
    }
    for (const n of produced) expand(n, [...stack, item.name]);
  };
  for (const node of Object.values(doc.nodes)) expand(structuredClone(node), []);
  return { doc: { ...doc, nodes: out }, errors };
}

/** Every item name or ref the document's instances name. */
export function instanceRefsIn(doc: SceneDocument): string[] {
  const refs = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    const p = primitiveOfNode(node);
    if (p !== null && p.name === 'instance' && typeof p.payload['component'] === 'string') refs.add(p.payload['component']);
  }
  return [...refs];
}

// ---------------------------------------------------------------------------
// Nearest names (the refusals name real ones).
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The nearest names to a wrong one, by edit distance, shared prefix breaking ties. */
export function nearestNames(wrong: string, candidates: readonly string[], n = 3): string[] {
  const w = wrong.toLowerCase();
  return [...candidates]
    .map((c) => {
      let prefix = 0;
      while (prefix < w.length && prefix < c.length && w[prefix] === c[prefix]) prefix++;
      return { c, score: levenshtein(w, c) - prefix };
    })
    .sort((a, b) => a.score - b.score || a.c.localeCompare(b.c))
    .slice(0, n)
    .map((x) => x.c);
}

export function nearestPrimitiveNames(wrong: string, n = 3): string[] {
  return nearestNames(wrong, PRIMITIVE_NAMES, n);
}

/** The nearest property names; a state block draws from the variable properties, a breakpoint block ('at') adds the atOk ones. */
export function nearestPropertyNames(name: PrimitiveName, wrong: string, n = 3, scope: 'payload' | 'block' | 'at' = 'payload'): string[] {
  const pool = scope === 'block' ? Object.keys(variableProperties(name))
    : scope === 'at' ? Object.keys(atProperties(name))
      : [...Object.keys(propertiesOf(name)), 'states', 'at'];
  return nearestNames(wrong, pool, n);
}

// ---------------------------------------------------------------------------
// THE TYPEDEF - what contract answers (the register the AI reads: one typed
// line per property with its hint, then the dimensions, emits, examples).
// ---------------------------------------------------------------------------

interface ZodDefView {
  typeName?: string; description?: string; shape?: () => Record<string, z.ZodTypeAny>; type?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny; keyType?: z.ZodTypeAny; valueType?: z.ZodTypeAny; values?: string[]; options?: z.ZodTypeAny[]; value?: unknown;
}
const zdef = (s: z.ZodTypeAny): ZodDefView => (s as unknown as { _def: ZodDefView })._def;

/** Nested shapes stop expanding at this depth; the capped tail teaches by hint + example instead. */
const TYPE_DEPTH_CAP = 2;
const CAPPED_SHAPE = 'a shape - the hint names its keys';

/** One-line type text of a property schema: a described string prints its word (color, node, query, url);
 * an object nested past the depth cap renders a plain-words pointer, never its expansion. */
export function typeText(s: z.ZodTypeAny, depth = 0): string {
  const d = zdef(s);
  // A one-word description names the shape (color, node, query, url, paint[], shadow[]).
  if (typeof d.description === 'string' && /^[a-z-]+(\[\])?$/.test(d.description)) return d.description;
  switch (d.typeName) {
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': return d.innerType !== undefined ? typeText(d.innerType, depth) : 'any';
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodLiteral': return JSON.stringify(d.value);
    case 'ZodEnum': return (d.values ?? []).map((v) => JSON.stringify(v)).join(' | ');
    case 'ZodArray': return d.type !== undefined ? `(${typeText(d.type, depth)})[]`.replace(/^\((\w+)\)\[\]$/, '$1[]') : 'any[]';
    case 'ZodRecord': return `{ [${d.keyType !== undefined ? typeText(d.keyType, depth) : 'string'}]: ${d.valueType !== undefined ? typeText(d.valueType, depth) : 'any'} }`;
    case 'ZodUnion': return (d.options ?? []).map((o) => typeText(o, depth)).join(' | ');
    case 'ZodObject': {
      if (depth >= TYPE_DEPTH_CAP) return CAPPED_SHAPE;
      const shape = d.shape?.() ?? {};
      const inner = Object.entries(shape).map(([k, f]) => `${bareKey(k)}${zdef(f).typeName === 'ZodOptional' ? '?' : ''}: ${typeText(f, depth + 1)}`);
      return `{ ${inner.join(', ')} }`;
    }
    default: return 'any';
  }
}

const bareKey = (k: string): string => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k));

/** A literal payload as dialect-shaped text (bare keys, quoted strings, expr() for expressions). */
export function plainValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(plainValue).join(', ')}]`;
  if (isExprValue(v)) return `expr(${JSON.stringify(v.$expr)})`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, x]) => `${bareKey(k)}: ${plainValue(x)}`).join(', ')} }`;
  }
  return 'null';
}

function propertyLine(key: string, p: PropertyDef, indent = '  '): string {
  const hints: string[] = [p.hint];
  if (p.initial !== undefined) hints.push(`default ${plainValue(p.initial)}`);
  if (p.fixed === true) hints.push(p.atOk === true ? 'structure - varies only by breakpoint, never by state' : 'structure - never in a state or breakpoint block');
  const head = `${indent}${bareKey(key)}?: ${p.teach?.type ?? typeText(p.schema)}   // ${hints.join('; ')}`;
  const tail = (p.teach?.lines ?? []).map((l) => `${indent}//   ${l}`);
  return [head, ...tail].join('\n');
}

/** The nine shared groups rendered once (every primitive but instance takes all of them; instance takes position, motion, visibility, a11y). */
export function renderSharedGroupsTypedef(): string {
  const lines: string[] = ['// THE SHARED GROUPS - every frame, text, field and chart takes all of these; an instance takes position, motion, visibility and a11y:'];
  for (const g of EVERY_GROUP) {
    lines.push(`// ${SHARED_GROUPS[g].title}`);
    for (const [k, p] of Object.entries(SHARED_GROUPS[g].properties)) lines.push(propertyLine(k, p));
  }
  lines.push('// states - a block per state that sets any non-structure property while the state holds: hover { fill: "cardRaised" }, focus { }, pressed { }, disabled { }');
  lines.push(`// breakpoints - a block per named width from the theme (${Object.keys(DEFAULT_BREAKPOINTS).join(', ')} by default): at phone { width: "fill" }`);
  return lines.join('\n');
}

/** One primitive's typedef; omitShared lists the shared groups by name instead of rendering them (they render once above). */
export function renderPrimitiveTypedef(name: PrimitiveName, opts?: { omitShared?: boolean }): string {
  const def = PRIMITIVES[name];
  const lines: string[] = [`// ${def.title} - ${def.breath}`, `${name} <id> {`];
  for (const [k, p] of Object.entries(def.own)) lines.push(propertyLine(k, p));
  for (const n of def.notes ?? []) lines.push(`  // ${n}`);
  if (opts?.omitShared === true) {
    lines.push(`  // + the shared groups: ${def.groups.map((g) => SHARED_GROUPS[g].title).join(', ')} (rendered once above)`);
  } else {
    for (const g of def.groups) {
      lines.push(`  // ${SHARED_GROUPS[g].title}`);
      for (const [k, p] of Object.entries(SHARED_GROUPS[g].properties)) lines.push(propertyLine(k, p));
    }
  }
  lines.push(`  ${STATE_NAMES.map((s) => `${s} { ... }`).join(' | ')}   // a state block sets any non-structure property while the state holds`);
  lines.push(`  at <${Object.keys(DEFAULT_BREAKPOINTS).join('|')}> { ... }   // a breakpoint block does the same at a named width from the theme`);
  lines.push('}');
  lines.push(`// children: ${def.children === 'any' ? 'any primitives nest inside (each repeats them per row)' : 'none - a leaf'}`);
  for (const [e, decl] of Object.entries(def.emits)) lines.push(`// emit '${e}': ${decl.type} - ${decl.hint}; consume with from("<node-id>.${e}")`);
  for (const ex of def.examples.slice(0, 3)) {
    const { states, ...rest } = ex.payload as Record<string, unknown> & { states?: Record<string, Record<string, unknown>> };
    const inner = Object.entries(rest).map(([k, v]) => `${bareKey(k)}: ${plainValue(v)}`).join(', ');
    const blocks = states !== undefined ? Object.entries(states).map(([s, v]) => ` ${s} ${plainValue(v)}`).join('') : '';
    lines.push(`// example (${ex.title}): ${name} x { ${inner}${blocks} }`);
  }
  return lines.join('\n');
}

/** The `<components>` block of the prompt prefix: one routing row per primitive (the typedef is a contract call). */
export function primitiveCatalogBlock(): string {
  return [
    'THE PRIMITIVES - every screen is built from these five words and nothing else; contract',
    "{names:['frame']} gives a full typedef (every property, its type, its hint), and the shared",
    'groups render once when you ask for more than one. Ask before you write a property you have',
    'not seen this run - guessing property names is the one reliable failure. A library item',
    'places as an instance; contract names it by its name; the library starts empty until you',
    'mint (Save as component).',
    ...PRIMITIVE_NAMES.map((n) => {
      const r = PRIMITIVES[n].route;
      return `- ${n}: ${r.summary}\n  use when: ${r.useWhen}\n  not for: ${r.notFor}`;
    }),
  ].join('\n');
}

/** Property counts per primitive and shared - the account the render prints. */
export function propertyCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of PRIMITIVE_NAMES) out[n] = Object.keys(PRIMITIVES[n].own).length;
  for (const g of EVERY_GROUP) out[`shared:${g}`] = Object.keys(SHARED_GROUPS[g].properties).length;
  out['shared'] = EVERY_GROUP.reduce((n, g) => n + Object.keys(SHARED_GROUPS[g].properties).length, 0);
  return out;
}
