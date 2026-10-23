import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  arrayDescriptorSchema, parseNpyHeader, validateProjection, DTYPE_BYTES,
  type ArrayDescriptor, type ProjectionRequest, type ProjectionPlan,
} from '@tent-nocode/core';

// Reads a validated projection from a .npy file; only the needed strided runs, never the whole file.

export interface ProjectionResult extends ProjectionPlan {
  dtype: ArrayDescriptor['dtype'];
  /** Raw little-endian payload of the projected result, C-order. */
  data: Uint8Array;
}

export function readProjection(
  input: { path: string; descriptor: unknown; request: ProjectionRequest },
): ProjectionResult {
  const descriptor = arrayDescriptorSchema.parse(input.descriptor);
  const plan = validateProjection(descriptor, input.request);
  const elemBytes = DTYPE_BYTES[descriptor.dtype];

  const fd = openSync(input.path, 'r');
  try {
    // Re-verify the header against the descriptor; a drifted file refuses.
    const headBuf = Buffer.alloc(4096);
    const n = readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = parseNpyHeader(new Uint8Array(headBuf.buffer, 0, n));
    if (head.dtype !== descriptor.dtype
        || head.shape.length !== descriptor.shape.length
        || head.shape.some((v, i) => v !== descriptor.shape[i])) {
      throw new Error(`array file drifted from its descriptor (file ${head.dtype} [${head.shape.join(', ')}] vs descriptor ${descriptor.dtype} [${descriptor.shape.join(', ')}])`);
    }
    const expected = head.dataOffset + descriptor.shape.reduce((a, b) => a * b, 1) * elemBytes;
    if (statSync(input.path).size !== expected) throw new Error('array file truncated — refusing a partial read');

    // C-order strides over the full shape.
    const strides = new Array<number>(descriptor.shape.length);
    let acc = 1;
    for (let i = descriptor.shape.length - 1; i >= 0; i--) {
      strides[i] = acc;
      acc *= descriptor.shape[i]!;
    }
    const fixed = new Map<number, number>();
    for (const s of input.request.slice) fixed.set(s.axis, s.index);
    const freeAxes = descriptor.shape.map((_, i) => i).filter((i) => !fixed.has(i));
    const ds = input.request.downsample;
    // Region offsets apply to the trailing two free axes.
    const offsets = new Array<number>(freeAxes.length).fill(0);
    if (input.request.region) {
      offsets[freeAxes.length - 2] = input.request.region.y0;
      offsets[freeAxes.length - 1] = input.request.region.x0;
    }

    const out = new Uint8Array(plan.bytes);
    const lastAxis = freeAxes[freeAxes.length - 1]!;
    const lastStrideBytes = strides[lastAxis]! * elemBytes; // contiguous only when lastAxis is the true last dim
    const rowLen = plan.shape[plan.shape.length - 1]!;
    const leadShape = plan.shape.slice(0, -1);
    const leadCount = leadShape.reduce((a, b) => a * b, 1);
    // Past this cap fall back to per-element preads to bound memory.
    const ROW_SPAN_CAP = 33_554_432; // 32 MiB
    // The span ends at the last element, not a stride past it, to avoid reading past EOF.
    const rowSpanBytes = (rowLen - 1) * ds * lastStrideBytes + elemBytes;
    const elementWise = rowSpanBytes > ROW_SPAN_CAP;
    const rowBuf = Buffer.alloc(elementWise ? elemBytes : rowSpanBytes);
    let outPos = 0;

    for (let row = 0; row < leadCount; row++) {
      // Decompose the output row index into source coordinates on the leading free axes.
      let rem = row;
      let srcOffsetElems = 0;
      for (let k = leadShape.length - 1; k >= 0; k--) {
        const idx = rem % leadShape[k]!;
        rem = Math.floor(rem / leadShape[k]!);
        srcOffsetElems += (offsets[k]! + idx * ds) * strides[freeAxes[k]!]!;
      }
      for (const [axis, index] of fixed) srcOffsetElems += index * strides[axis]!;
      srcOffsetElems += offsets[freeAxes.length - 1]! * strides[lastAxis]!;
      if (elementWise) {
        for (let x = 0; x < rowLen; x++) {
          const at = head.dataOffset + (srcOffsetElems + x * ds * strides[lastAxis]!) * elemBytes;
          const got = readSync(fd, rowBuf, 0, elemBytes, at);
          if (got < elemBytes) throw new Error('array file short read — refusing a partial projection');
          out.set(new Uint8Array(rowBuf.buffer, 0, elemBytes), outPos);
          outPos += elemBytes;
        }
      } else {
        // One contiguous pread covers the strided source row; decimate in memory.
        const got = readSync(fd, rowBuf, 0, rowSpanBytes, head.dataOffset + srcOffsetElems * elemBytes);
        if (got < rowSpanBytes) throw new Error('array file short read — refusing a partial projection');
        if (ds === 1 && lastStrideBytes === elemBytes) {
          out.set(new Uint8Array(rowBuf.buffer, 0, rowLen * elemBytes), outPos);
          outPos += rowLen * elemBytes;
        } else {
          for (let x = 0; x < rowLen; x++) {
            const src = x * ds * lastStrideBytes;
            out.set(new Uint8Array(rowBuf.buffer, src, elemBytes), outPos);
            outPos += elemBytes;
          }
        }
      }
    }
    return { ...plan, dtype: descriptor.dtype, data: out };
  } finally {
    closeSync(fd);
  }
}
