export {};

// Mirrors preload desk API shape (generic, untyped); precise typing in renderer/lib/desk.ts from shared/ipc.ts.
declare global {
  interface Window {
    desk: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      onLive: (cb: (event: unknown) => void) => () => void;
      onDelta: (cb: (event: unknown) => void) => () => void;
    };
  }
}
