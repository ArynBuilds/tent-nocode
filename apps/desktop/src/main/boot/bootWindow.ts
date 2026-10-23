import { app, BrowserWindow } from 'electron';
import bootHtml from './boot.html?raw';
import { stageSentence, type BootFailure, type BootStageKind } from './bootStages.js';

// Frameless boot window over one static page; shows only on slow or first boots, always on failure. Buttons navigate to app-boot://<verb>.

const SLOW_BOOT_MS = 1500;

export interface BootSurface {
  setStage(stage: BootStageKind): void;
  fail(failure: BootFailure, logPath: string): void;
  close(): void;
}

export function createBootSurface(opts: { virgin: boolean }): BootSurface {
  let win: BrowserWindow | null = null;
  let stage: BootStageKind = opts.virgin ? 'first-time-setup' : 'starting-db';
  let closed = false;
  let timer: NodeJS.Timeout | null = null;

  function ensureWindow(): BrowserWindow {
    if (win !== null && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: 460,
      height: 300,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: '#171717',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'app-boot://try-again') {
        app.relaunch();
        app.exit(0);
      } else if (url === 'app-boot://quit') {
        app.quit();
      }
    });
    win.once('ready-to-show', () => {
      if (!closed && win !== null && !win.isDestroyed()) win.show();
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bootHtml)}`);
    return win;
  }

  function render(js: string): void {
    const w = ensureWindow();
    const run = (): void => { void w.webContents.executeJavaScript(js).catch(() => undefined); };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', run);
    else run();
  }

  // Virgin boots show immediately; warm boots arm the slow-boot timer and usually never render.
  if (opts.virgin) {
    render(`setStage(${JSON.stringify(stageSentence(stage))})`);
  } else {
    timer = setTimeout(() => {
      if (!closed) render(`setStage(${JSON.stringify(stageSentence(stage))})`);
    }, SLOW_BOOT_MS);
  }

  return {
    setStage(next: BootStageKind): void {
      stage = next;
      if (win !== null && !win.isDestroyed()) {
        render(`setStage(${JSON.stringify(stageSentence(next))})`);
      }
    },
    fail(failure: BootFailure, logPath: string): void {
      if (timer !== null) clearTimeout(timer);
      render(`setFailure(${JSON.stringify({ ...failure, logPath })})`);
    },
    close(): void {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      if (win !== null && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
