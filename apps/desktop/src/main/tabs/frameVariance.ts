// Blank-frame heuristic: sampled luminance variance, not brightness, so dark themes pass.
export interface CapturedFrame {
  getSize(): { width: number; height: number };
  /** BGRA bytes. */
  getBitmap(): Buffer | Uint8Array;
}

export const BLANK_VARIANCE_FLOOR = 50;

export function frameVariance(img: CapturedFrame): number {
  const { width, height } = img.getSize();
  const bmp = img.getBitmap();
  let n = 0, mean = 0, m2 = 0;
  const step = Math.max(4, Math.floor((width * height) / 4000)) * 4;
  for (let i = 0; i < bmp.length; i += step) {
    const lum = 0.114 * bmp[i]! + 0.587 * bmp[i + 1]! + 0.299 * bmp[i + 2]!;
    n++;
    const d = lum - mean;
    mean += d / n;
    m2 += d * (lum - mean);
  }
  return n > 1 ? m2 / (n - 1) : 0;
}
