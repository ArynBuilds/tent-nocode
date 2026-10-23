import { app, BrowserWindow, Menu, shell } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBootLog } from './boot/bootLog.js';
import { createBootSurface } from './boot/bootWindow.js';
import { classifyBootFailure } from './boot/bootStages.js';
import { clearIdentity, resolveIdentity } from './identity.js';
import { registerWorkspaceAdapter } from './ipc/adapter.js';
import { registerCredentialHandlers } from './ipc/nativeCredentials.js';
import { registerDeliveryHandlers } from './ipc/nativeDelivery.js';
import { registerFileHandlers } from './ipc/nativeFiles.js';
import { registerShellHandlers } from './ipc/nativeShell.js';
import { startOpsLoop, type OpsLoopHandle } from './runner/opsLoop.js';
import { setFocusedScene } from './focusState.js';
import { parseLaunchArgs } from './launchArgs.js';
import { queueOffer, setPackageOfferBroadcast } from './packageOffer.js';
import { authState, loadAccountAtBoot, loadHostSecrets, onAuthStateChange, sessionAccessToken } from './account.js';
import { startLocalServer, type LocalServer } from './localServer.js';
import { registerTabProtocol, registerTabSchemePrivileges, type SceneServeSource } from './tabs/protocol.js';
import { initResources, resourcePath } from './resources.js';
import { createWorkspaceClient, setWorkspaceClient, workspaceCall, type WorkspaceLiveHandle } from './workspaceClient.js';
import { createWorkspaceOpsPort } from './workspaceOpsPort.js';
import type { LiveEvent } from '../shared/ipc.js';

// electron-vite bundles the main process as ESM; import.meta.url replaces __dirname.
const __dirname = dirname(fileURLToPath(import.meta.url));

// One resolver owns every packaged-vs-dev resource fork.
initResources({ isPackaged: app.isPackaged, appPath: app.getAppPath() });

// The app claims its name and data home first.
app.setName('Tent NoCode');
app.setPath('userData', join(app.getPath('appData'), 'Tent NoCode'));

// Privileged schemes must register before app ready.
registerTabSchemePrivileges();

// No OS menu bar.
Menu.setApplicationMenu(null);

// The main process starts the local server (bundled Postgres + the host) and every channel rides its workspace door.

let wsLive: WorkspaceLiveHandle | undefined;
let opsLoop: OpsLoopHandle | undefined;
let localServer: LocalServer | undefined;
let isQuitting = false;

/** Forwards every live notify to every open renderer window. */
function broadcastLive(event: LiveEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('desk:live', event);
  }
}

/** A launched .tproject waits in the offer slot; the renderer imports it once unlocked. */
function offerPackageOpen(path: string): void {
  queueOffer(path);
}

function createWindow(): void {
  const iconPath = resourcePath('icon.png');
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 560,
    minHeight: 380,
    show: false,
    icon: iconPath,
    backgroundColor: '#171717',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  win.webContents.on('did-finish-load', () => { win.webContents.setZoomFactor(1); });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[window] renderer gone: reason=${details.reason} exitCode=${details.exitCode} - reloading`);
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') win.webContents.reload();
  });

  // Web addresses (a published app, an integration sign-in) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    try {
      if (new URL(url).origin !== new URL(current).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toUpperCase();
    if (key === 'F5' || (input.control && !input.shift && key === 'R')) {
      event.preventDefault();
      win.webContents.reload();
    } else if (process.env['ELECTRON_RENDERER_URL'] && (key === 'F12' || (input.control && input.shift && key === 'I'))) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// One copy at a time: a second launch hands its payload to the first.
const coldArgs = parseLaunchArgs(process.argv);
setFocusedScene(coldArgs.focusSlug);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const warm = parseLaunchArgs(argv);
    const win = BrowserWindow.getAllWindows()[0];
    if (warm.focusSlug !== null) {
      setFocusedScene(warm.focusSlug);
      win?.webContents.send('desk:focus', warm.focusSlug);
    }
    if (warm.packagePath !== null) offerPackageOpen(warm.packagePath);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  const bootLog = createBootLog(app.getPath('userData'));
  const boot = createBootSurface({ virgin: false });
  bootLog.append(`boot start (local, v${app.getVersion()})`);
  try {
    const secrets = await loadHostSecrets();
    localServer = await startLocalServer({ userDataDir: app.getPath('userData'), tokenSecret: secrets.tokenSecret, vaultKey: secrets.vaultKey,
      toolsMcpEntry: join(__dirname, 'toolsMcp.js') });
    const wsClient = createWorkspaceClient({ origin: localServer.origin, token: sessionAccessToken });
    setWorkspaceClient(wsClient, localServer.origin);

    // The native set registers first; the adapter then forwards every router procedure the natives did not claim.
    registerShellHandlers();
    registerFileHandlers();
    registerCredentialHandlers();
    registerDeliveryHandlers();
    registerWorkspaceAdapter();

    // tab:// serving: the scene read rides the workspace door; fonts/engines stay local resources.
    const sceneSource: SceneServeSource = async (_orgId, sceneId) =>
      await workspaceCall('sceneForServe', [sceneId]) as Awaited<ReturnType<SceneServeSource>>;
    registerTabProtocol(sceneSource, resourcePath('fonts'), resourcePath('engines'),
      join(app.getPath('userData'), 'workspaces', 'tab-screens'));

    // Live = the server's stream; the ops loop is the desktop's one standing compute job.
    wsLive = wsClient.startLive(broadcastLive);
    opsLoop = startOpsLoop({
      port: createWorkspaceOpsPort(),
      ready: () => authState().status === 'signed-in',
      ops: {
        workerFile: resourcePath('opsWorker.cjs'),
        pyodideDir: resourcePath('pyodide'),
        onnxDir: resourcePath('onnx'),
        workspaceRoot: join(app.getPath('userData'), 'workspaces'),
      },
    });
  } catch (err) {
    const failure = classifyBootFailure(err);
    console.error(`[boot] failed [${failure.kind}]:`, failure.detail);
    bootLog.append(`BOOT FAILED [${failure.kind}] ${failure.detail}`);
    boot.fail(failure, bootLog.path);
    await localServer?.stop().catch(() => undefined);
    localServer = undefined;
    return;
  }

  createWindow();
  boot.close();
  bootLog.append('boot complete');
  console.log('main up (local)');

  // Unlocking resolves the workspace identity; locking empties the slot.
  onAuthStateChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('desk:auth', state);
    }
    if (state.status === 'signed-in') {
      void resolveIdentity(workspaceCall)
        .catch((e: unknown) => {
          console.error('[identity] resolve failed:', e instanceof Error ? e.message : String(e));
        });
    } else {
      clearIdentity();
    }
  });
  await loadAccountAtBoot();
  setPackageOfferBroadcast((path) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('desk:openPackage', path);
    }
  });
  if (coldArgs.packagePath !== null) offerPackageOpen(coldArgs.packagePath);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error(`[app] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void (async () => {
    if (opsLoop) {
      try { await opsLoop.stop(); } catch (err) { console.error('[ops] failed to stop loop cleanly:', err); }
    }
    wsLive?.stop();
    await localServer?.stop().catch((err: unknown) => console.error('[host] failed to stop cleanly:', err));
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
