import { z } from 'zod';

// Array metadata: descriptors, projection validation, and .npy header parsing - pure, no filesystem.

export const ARRAY_DTYPES = ['float32', 'float64', 'int16', 'int32', 'uint8', 'uint16'] as const;
export type ArrayDtype = (typeof ARRAY_DTYPES)[number];

export const DTYPE_BYTES: Record<ArrayDtype, number> = {
  float32: 4, float64: 8, int16: 2, int32: 4, uint8: 1, uint16: 2,
};

export const ARRAY_MAX_DIMS = 5;
/** One projected read never exceeds this many elements. */
export const PROJECTION_MAX_ELEMENTS = 4_194_304;
/** Hard byte ceiling for one projection payload down the port. */
export const PROJECTION_MAX_BYTES = 16_777_216;
export const PROJECTION_MAX_DOWNSAMPLE = 64;

export const arrayDescriptorSchema = z
  .object({
    dtype: z.enum(ARRAY_DTYPES),
    shape: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(ARRAY_MAX_DIMS),
    axes: z.array(z.string().min(1).max(32)),
    units: z.string().min(1).max(32).optional(),
    /** sha256 hex of the payload file, set at registration. */
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((d) => d.axes.length === d.shape.length, { message: 'axes must label every shape dimension' });
export type ArrayDescriptor = z.infer<typeof arrayDescriptorSchema>;

export const projectionRequestSchema = z
  .object({
    /** Fixed axes: each names an axis and the index held. */
    slice: z
      .array(z.object({ axis: z.number().int().min(0).max(ARRAY_MAX_DIMS - 1), index: z.number().int().min(0) }).strict())
      .max(ARRAY_MAX_DIMS)
      .default([]),
    /** Crop on the TRAILING two remaining dims (y = second-to-last, x = last), pre-downsample. */
    region: z
      .object({
        x0: z.number().int().min(0), y0: z.number().int().min(0),
        x1: z.number().int().min(1), y1: z.number().int().min(1),
      })
      .strict()
      .optional(),
    downsample: z.number().int().min(1).max(PROJECTION_MAX_DOWNSAMPLE).default(1),
  })
  .strict();
export type ProjectionRequest = z.infer<typeof projectionRequestSchema>;

export interface ProjectionPlan {
  /** Shape of the projected result, post-slice, post-region, post-downsample. */
  shape: number[];
  elements: number;
  bytes: number;
}

/** Validate a projection against a descriptor; over-cap requests are refused, never truncated. */
export function validateProjection(descriptor: ArrayDescriptor, request: ProjectionRequest): ProjectionPlan {
  const seen = new Set<number>();
  for (const s of request.slice) {
    if (s.axis >= descriptor.shape.length) throw new Error(`projection: axis ${s.axis} out of range for a ${descriptor.shape.length}-dim array`);
    if (seen.has(s.axis)) throw new Error(`projection: axis ${s.axis} sliced twice`);
    seen.add(s.axis);
    const dim = descriptor.shape[s.axis]!;
    if (s.index >= dim) throw new Error(`projection: index ${s.index} past the axis-${s.axis} extent (${dim})`);
  }
  let shape = descriptor.shape.filter((_, axis) => !seen.has(axis));
  if (request.region) {
    const r = request.region;
    if (shape.length < 2) throw new Error('projection: region needs a ≥2-dim result (slice down to a plane first)');
    if (r.x1 <= r.x0 || r.y1 <= r.y0) throw new Error('projection: region extents must be positive (x1>x0, y1>y0)');
    const y = shape.length - 2, x = shape.length - 1;
    if (r.x1 > shape[x]! || r.y1 > shape[y]!) throw new Error(`projection: region exceeds the plane (${shape[y]}×${shape[x]})`);
    shape = [...shape.slice(0, y), r.y1 - r.y0, r.x1 - r.x0];
  }
  shape = shape.map((d) => Math.ceil(d / request.downsample));
  const elements = shape.reduce((a, b) => a * b, 1);
  const bytes = elements * DTYPE_BYTES[descriptor.dtype];
  if (elements > PROJECTION_MAX_ELEMENTS) {
    throw new Error(`projection exceeds the element cap (${elements} > ${PROJECTION_MAX_ELEMENTS}) — slice or downsample further`);
  }
  if (bytes > PROJECTION_MAX_BYTES) {
    throw new Error(`projection exceeds the byte cap (${bytes} > ${PROJECTION_MAX_BYTES}) — slice or downsample further`);
  }
  return { shape, elements, bytes };
}

// .npy container: magic + python-dict header + raw C-order bytes.

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const; // \x93NUMPY

const DESCR_TO_DTYPE: Record<string, ArrayDtype> = {
  '<f4': 'float32', '|f4': 'float32',
  '<f8': 'float64', '|f8': 'float64',
  '<i2': 'int16', '|i2': 'int16',
  '<i4': 'int32', '|i4': 'int32',
  '|u1': 'uint8', '<u1': 'uint8',
  '<u2': 'uint16', '|u2': 'uint16',
};

const DTYPE_TO_DESCR: Record<ArrayDtype, string> = {
  float32: '<f4', float64: '<f8', int16: '<i2', int32: '<i4', uint8: '|u1', uint16: '<u2',
};

export interface NpyHeader {
  dtype: ArrayDtype;
  shape: number[];
  /** Byte offset where the raw C-order payload begins. */
  dataOffset: number;
}

/** Parse a .npy header (v1/v2/v3) from the file's leading bytes; C-order little-endian only. */
export function parseNpyHeader(bytes: Uint8Array): NpyHeader {
  if (bytes.length < 10 || NPY_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('not an .npy file (bad magic)');
  const major = bytes[6]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const dataOffset = headerStart + headerLen;
  if (bytes.length < dataOffset) throw new Error('.npy header truncated');
  let text = '';
  for (let i = headerStart; i < dataOffset; i++) text += String.fromCharCode(bytes[i]!);
  const descr = /'descr':\s*'([^']+)'/.exec(text)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(text)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(text)?.[1];
  if (!descr || !fortran || shapeText === undefined) throw new Error('.npy header unparsable');
  if (fortran === 'True') throw new Error('.npy fortran_order not supported (v1 reads C-order only)');
  const dtype = DESCR_TO_DTYPE[descr];
  if (!dtype) throw new Error(`.npy dtype '${descr}' outside the descriptor enum (${ARRAY_DTYPES.join('/')})`);
  const shape = shapeText.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new Error(`.npy shape entry '${s}' invalid`);
    return n;
  });
  if (shape.length === 0) throw new Error('.npy 0-dim arrays not supported (descriptors are ≥1-dim)');
  return { dtype, shape, dataOffset };
}

/** Build an empty .npy file (v1 header + zeroed payload); producers fill the payload region. */
export function buildNpy(dtype: ArrayDtype, shape: number[]): Uint8Array {
  const dict = `{'descr': '${DTYPE_TO_DESCR[dtype]}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  // numpy alignment law: magic(6) + version(2) + len(2) + text + padding + '\n' ≡ 0 (mod 64)
  const unpadded = 10 + dict.length + 1;
  const pad = (64 - (unpadded % 64)) % 64;
  const text = dict + ' '.repeat(pad) + '\n';
  const payloadBytes = npyByteLength(dtype, shape);
  const out = new Uint8Array(10 + text.length + payloadBytes);
  out.set(NPY_MAGIC);
  out[6] = 1; out[7] = 0;
  new DataView(out.buffer).setUint16(8, text.length, true);
  for (let i = 0; i < text.length; i++) out[10 + i] = text.charCodeAt(i);
  return out;
}

/** Exact payload byte size for a dtype/shape. */
export function npyByteLength(dtype: ArrayDtype, shape: number[]): number {
  return shape.reduce((a, b) => a * b, 1) * DTYPE_BYTES[dtype];
}
