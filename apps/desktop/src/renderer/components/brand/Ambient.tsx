import styles from './ambient.module.css';

// The quiet canvas behind a moment: two slow lights drifting and a dot grid fading out from the center.
// Pure decoration; it fills its positioned parent and never takes a pointer.

export function Ambient() {
  return (
    <div className={styles.ambient} aria-hidden="true">
      <div className={styles.glow} />
      <div className={styles.grid} />
    </div>
  );
}
