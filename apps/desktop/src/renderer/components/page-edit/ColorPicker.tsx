import { useEffect, useRef, useState } from 'react';
import { Pipette } from 'lucide-react';
import {
  BAKED_SCENE_COLORS, formatColor, hexFieldText, hsvToRgb, parseColor,
  pushRecentColor, recentColors, rgbToHsv,
} from '../../lib/page-edit/colorPicker.js';
import type { ColorFormat, Hsv } from '../../lib/page-edit/colorPicker.js';
import styles from './colorpicker.module.css';

// The one color picker popover; commits land on release, one revision per gesture.

interface EyeDropperCtor { new (): { open(): Promise<{ sRGBHex: string }> } }

export function ColorPicker({ word, value, kinds, onCommit, onClose }: {
  /** The aspect's plain word - the popover title (Fill · Border color · ...). */
  word: string;
  /** The stored color value (hex, rgb(), or a house name). */
  value: string;
  /** The fill-kind tabs - mounted only where the aspect supports kinds. */
  kinds?: { value: string; options: readonly string[]; onPick: (kind: string) => void };
  onCommit: (v: string) => void;
  onClose: () => void;
}) {
  const parsed = parseColor(value) ?? { r: 128, g: 128, b: 128, a: 1 };
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(parsed));
  const [alpha, setAlpha] = useState(parsed.a);
  const [format, setFormat] = useState<ColorFormat>(() => (/^rgb/i.test(value.trim()) ? 'rgb' : 'hex'));
  const [hexDraft, setHexDraft] = useState(() => hexFieldText(parsed));
  const svRef = useRef<HTMLDivElement | null>(null);
  const rgb = hsvToRgb(hsv, alpha);
  const opaque = hsvToRgb(hsv, 1);
  const hueCss = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;

  // Follow value changes made outside the picker.
  useEffect(() => {
    const p = parseColor(value);
    if (p === null) return;
    setHsv(rgbToHsv(p));
    setAlpha(p.a);
    setHexDraft(hexFieldText(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: { hsv?: Hsv; alpha?: number; format?: ColorFormat }): void => {
    const c = hsvToRgb(next.hsv ?? hsv, next.alpha ?? alpha);
    const out = formatColor(c, next.format ?? format);
    pushRecentColor(out);
    onCommit(out);
  };

  /** SV area drag: live locally, one commit on release. */
  function onSvDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = svRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    let last = hsv;
    const at = (ev: { clientX: number; clientY: number }): Hsv => ({
      h: hsv.h,
      s: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
      v: Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height)),
    });
    last = at(e);
    setHsv(last);
    const onMove = (ev: PointerEvent): void => { last = at(ev); setHsv(last); };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      commit({ hsv: last });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const eye = (window as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  const recent = recentColors();

  return (
    <div className={styles.pop} role="dialog" aria-label={`${word} picker`}>
      <div className={styles.head}>
        <span className={styles.headWord}>{word}</span>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>×</button>
      </div>
      {kinds !== undefined ? (
        <div className={styles.kinds} role="tablist">
          {kinds.options.map((k) => (
            <button
              key={k} type="button" role="tab" aria-selected={k === kinds.value}
              className={k === kinds.value ? styles.kindOn : styles.kind}
              onClick={() => { if (k !== kinds.value) kinds.onPick(k); }}
            >{k}</button>
          ))}
        </div>
      ) : null}
      <div
        ref={svRef} className={styles.sv}
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss})` }}
        onPointerDown={onSvDown}
      >
        <span
          className={styles.svDot}
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: formatColor(opaque, 'hex') }}
        />
      </div>
      <input
        type="range" className={styles.hue} min={0} max={360} step={1}
        value={Math.round(hsv.h)} aria-label="Hue"
        onChange={(e) => setHsv({ ...hsv, h: Number(e.target.value) })}
        onPointerUp={() => commit({})}
        onKeyUp={(e) => { if (e.key.startsWith('Arrow')) commit({}); }}
      />
      <div className={styles.alphaTrack}>
        <div className={styles.alphaFill} style={{ background: `linear-gradient(to right, transparent, ${formatColor(opaque, 'hex')})` }} />
        <input
          type="range" className={styles.alpha} min={0} max={100} step={1}
          value={Math.round(alpha * 100)} aria-label="Opacity"
          onChange={(e) => setAlpha(Number(e.target.value) / 100)}
          onPointerUp={() => commit({})}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow')) commit({}); }}
        />
      </div>
      <div className={styles.fields}>
        <input
          className={styles.hex} value={format === 'hex' ? hexDraft : formatColor(rgb, 'rgb')}
          spellCheck={false} aria-label="Color value"
          onChange={(e) => setHexDraft(e.target.value.replace(/^#/, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onBlur={() => {
            const p = parseColor(format === 'hex' ? `#${hexDraft.replace(/^#/, '')}` : hexDraft);
            if (p === null) { setHexDraft(hexFieldText(rgb)); return; }
            const next = rgbToHsv(p);
            setHsv(next);
            commit({ hsv: next, alpha });
          }}
          readOnly={format === 'rgb'}
        />
        <input
          className={styles.opacity} inputMode="numeric" aria-label="Opacity percent"
          value={`${Math.round(alpha * 100)}%`}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/%/g, ''));
            if (Number.isFinite(n)) setAlpha(Math.min(1, Math.max(0, n / 100)));
          }}
          onBlur={() => commit({})}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>
      <div className={styles.fields}>
        <select
          className={styles.format} value={format} aria-label="Color format"
          onChange={(e) => { const f = e.target.value as ColorFormat; setFormat(f); commit({ format: f }); }}
        >
          <option value="hex">HEX</option>
          <option value="rgb">RGB</option>
        </select>
        {/* Eyedropper renders only where the EyeDropper API exists. */}
        {eye !== undefined ? (
          <button
            type="button" className={styles.eye}
            aria-label="Pick a color from the page" title="Pick a color from the page"
            onClick={() => { void new eye().open().then((r) => { pushRecentColor(r.sRGBHex); onCommit(r.sRGBHex); }).catch(() => undefined); }}
          >
            <Pipette size={13} />
          </button>
        ) : null}
      </div>
      {recent.length > 0 ? (
        <div className={styles.swatches} aria-label="Recent colors">
          {recent.map((c) => (
            <button
              key={c} type="button" className={styles.swatch} style={{ background: c }}
              title={c} aria-label={`Use ${c}`} onClick={() => onCommit(c)}
            />
          ))}
        </div>
      ) : null}
      <div className={styles.swatches} aria-label="Scene palette">
        {Object.entries(BAKED_SCENE_COLORS).map(([name, css]) => (
          <button
            key={name} type="button" className={styles.swatch} style={{ background: css }}
            title={name} aria-label={`Use ${name}`}
            onClick={() => { pushRecentColor(css); onCommit(css); }}
          />
        ))}
      </div>
    </div>
  );
}
