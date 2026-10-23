import './tokens.css';
import { useEffect, useRef, useState } from 'react';
import { SettingsScreen } from './components/settings/SettingsScreen.js';
import { AgentFrames } from './components/shell/AgentFrames.js';
import { AnomalyStrip } from './components/shell/AnomalyStrip.js';
import { Console } from './components/shell/Console.js';
import { GateOrShell } from './components/shell/GateOrShell.js';
import { Screen, useNarrow } from './components/shell/ScreenRoute.js';
import { Titlebar } from './components/shell/Titlebar.js';
import { useProjectChatTabs } from './lib/chatTabWorkspace.js';
import type { ConsoleMode, ConsoleTab } from './lib/consoleState.js';
import { SidePanel, newTab } from './components/shell/SidePanel.js';
import type { PanelTab } from './components/shell/SidePanel.js';
import { WorkspacePane } from './components/workspace/WorkspacePane.js';
import { BottomPanel } from './components/shell/BottomPanel.js';
import styles from './components/shell/shell.module.css';
import { PublishTakeover } from './components/project/PublishTakeover.js';
import { DashboardShell } from './components/dashboard/DashboardShell.js';
import { desk } from './lib/desk.js';
import { birthProject } from './lib/birthProject.js';
import { closePublishTakeover, openPublishTakeover, usePublishTakeover } from './lib/publishTakeover.js';
import { store, useValue } from './lib/canvas/store.js';
import { FocusProvider, useFocusedProject } from './lib/FocusContext.js';
import { OrgProvider, useOrg } from './lib/OrgContext.js';
import { navigate, useRoute } from './lib/router.js';

function Shell() {
  const route = useRoute();
  const { orgId } = useOrg();
  // The resting shell is the dashboard; the editor is an entered takeover.
  const [editing, setEditing] = useState(false);
  const narrow = useNarrow();

  // The left slot: same panel species on the side track; Layout rides here by default.
  const [leftTabs, setLeftTabs] = useState<PanelTab[]>([]);
  const [leftActive, setLeftActive] = useState('');
  // A fresh session opens with the sidebars closed.
  const [leftShown, setLeftShown] = useState(false);
  const [leftClosing, setLeftClosing] = useState(false);
  const [leftOverlayOpen, setLeftOverlayOpen] = useState(false);
  const [leftW, setLeftW] = useState<number | null>(null);
  const [leftResizing, setLeftResizing] = useState(false);
  useEffect(() => {
    if (!narrow) setLeftOverlayOpen(false);
  }, [narrow]);
  const leftOpen = leftShown && !narrow;
  const leftOverlay = narrow && leftOverlayOpen;

  function toggleLeft(): void {
    if (narrow) {
      setLeftOverlayOpen((v) => !v);
      return;
    }
    if (leftShown) {
      setLeftShown(false);
      setLeftClosing(true);
      window.setTimeout(() => setLeftClosing(false), 220);
    } else {
      setLeftShown(true);
    }
  }

  // The right side panel: session-local tabs; stays mounted while closing so tabs survive.
  const [panelTabs, setPanelTabs] = useState<PanelTab[]>([]);
  const [panelActive, setPanelActive] = useState('');
  // The pane opens empty to the launcher; closing the last tab returns to it.
  const [panelShown, setPanelShown] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);
  // Narrow mode: the docked column collapses and the toggle opens an overlay instead.
  const [panelOverlayOpen, setPanelOverlayOpen] = useState(false);
  // User-dragged width rides a CSS var; null = the default track.
  const [panelW, setPanelW] = useState<number | null>(null);
  const [panelResizing, setPanelResizing] = useState(false);
  useEffect(() => {
    if (!narrow) setPanelOverlayOpen(false);
  }, [narrow]);
  const panelOpen = panelShown && !narrow;
  const panelOverlay = narrow && panelOverlayOpen;

  function togglePanel(): void {
    if (narrow) {
      setPanelOverlayOpen((v) => !v);
      return;
    }
    if (panelShown) {
      setPanelShown(false);
      setPanelClosing(true);
      window.setTimeout(() => setPanelClosing(false), 220);
    } else {
      setPanelShown(true);
    }
  }

  // The bottom panel: same tab grammar as the side panel, default hidden.
  const [bottomTabs, setBottomTabs] = useState<PanelTab[]>([]);
  const [bottomActive, setBottomActive] = useState('');
  const [bottomShown, setBottomShown] = useState(false);
  const [bottomClosing, setBottomClosing] = useState(false);
  const [bottomOverlayOpen, setBottomOverlayOpen] = useState(false);
  const [bottomH, setBottomH] = useState<number | null>(null);
  const [bottomResizing, setBottomResizing] = useState(false);
  useEffect(() => {
    if (!narrow) setBottomOverlayOpen(false);
  }, [narrow]);
  const bottomOpen = bottomShown && !narrow;
  const bottomOverlay = narrow && bottomOverlayOpen;

  function toggleBottom(): void {
    if (narrow) {
      setBottomOverlayOpen((v) => !v);
      return;
    }
    if (bottomShown) {
      setBottomShown(false);
      setBottomClosing(true);
      window.setTimeout(() => setBottomClosing(false), 220);
    } else {
      setBottomShown(true);
    }
  }

  // If an agent holds the browser and no browser tab exists, the panel opens one itself.
  const panelTabsRef = useRef(panelTabs);
  panelTabsRef.current = panelTabs;
  useEffect(() => {
    const id = setInterval(() => {
      desk.panelBrowserState().then((s) => {
        if (s === null || panelTabsRef.current.some((t) => t.kind === 'browser')) return;
        const t = newTab('browser');
        setPanelTabs([...panelTabsRef.current, t]);
        setPanelActive(t.id);
        if (narrow) setPanelOverlayOpen(true);
        else setPanelShown(true);
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(id);
  }, [narrow]);

  // The panel requests are records: a nonce opens (or focuses) the one tab of a kind, a subject change retargets in place.
  const panel = useValue('app.panel', () => store.panel, []);
  const seen = useRef({ inspector: 0, browser: 0, file: 0 });
  useEffect(() => {
    store.setPanelHosts({ inspector: true, browser: true, file: true, focus: true });
    return () => store.setPanelHosts({ inspector: false, browser: false, file: false, focus: false });
  }, []);
  const show = (): void => { if (narrow) setPanelOverlayOpen(true); else setPanelShown(true); };
  useEffect(() => {
    const subject = panel.inspector;
    const opening = panel.inspectorNonce !== seen.current.inspector;
    seen.current.inspector = panel.inspectorNonce;
    if (subject === null) return;
    const existing = panelTabsRef.current.find((t) => t.kind === 'inspector');
    if (existing) {
      setPanelTabs(panelTabsRef.current.map((t) => (t.id === existing.id ? { ...t, selection: subject } : t)));
      if (opening) { setPanelActive(existing.id); show(); }
    } else if (opening) {
      const t = newTab('inspector', undefined, subject);
      setPanelTabs([...panelTabsRef.current, t]);
      setPanelActive(t.id);
      show();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.inspector, panel.inspectorNonce]);
  useEffect(() => {
    const browse = panel.browser;
    const opening = panel.browserNonce !== seen.current.browser;
    seen.current.browser = panel.browserNonce;
    if (browse === null) return;
    const existing = panelTabsRef.current.find((t) => t.kind === 'nodeBrowser');
    if (existing) {
      setPanelTabs(panelTabsRef.current.map((t) => (t.id === existing.id ? { ...t, browse } : t)));
      if (opening) { setPanelActive(existing.id); show(); }
    } else if (opening) {
      const t = { ...newTab('nodeBrowser'), browse };
      setPanelTabs([...panelTabsRef.current, t]);
      setPanelActive(t.id);
      show();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.browser, panel.browserNonce]);
  useEffect(() => {
    const file = panel.file;
    if (file === null || file.nonce === seen.current.file) return;
    seen.current.file = file.nonce;
    const existing = panelTabsRef.current.find((t) => t.kind === 'file' && t.path === file.path);
    if (existing) setPanelActive(existing.id);
    else {
      const t = newTab('file', file.path);
      setPanelTabs([...panelTabsRef.current, t]);
      setPanelActive(t.id);
    }
    show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.file]);

  // Console state lives in Shell; the console renders as a sibling of <main>.
  const [consoleTabs, setConsoleTabs] = useState<ConsoleTab[]>([]);
  const [consoleActive, setConsoleActive] = useState('');
  // The pill is the resting state; hover/intent opens it.
  const [consoleMode, setConsoleMode] = useState<ConsoleMode>('pill');
  const [consoleSticky, setConsoleSticky] = useState(false);

  // Chat tabs live per project: a focus switch swaps the open-chat set.
  useProjectChatTabs({
    consoleTabs, consoleActive,
    onConsole: (tabs, activeId) => { setConsoleTabs(tabs); setConsoleActive(activeId); },
  });

  const { focusedProjectId, focusProject } = useFocusedProject();
  // D12 (user-corrected on pixels 2026-08-14): while the one project screen is
  // open, Back means "back to the project" — it closes the takeover; only a
  // bare editor's Back leaves for the dashboard.
  const takeover = usePublishTakeover();
  // THE CENTER FLIP (P3, the editor-in-the-map arc, 2026-08-19): entering a
  // project IS the takeover and the WORKSPACE is the permanent center — the
  // editor route died; screens edit in place on the canvas.
  function enterEditor(projectId: string): void {
    focusProject(projectId);
    setEditing(true);
    navigate('/');
  }
  // THE ONE BIRTH LANE (D-e1 re-homed to the dashboard's Create door, D2/D4):
  // the ceremony picks kind + name in one screen; the lane births and
  // navigates home itself; a typed name lands as the first rename (the born
  // default keeps a blank one). PROJECT FOCUS (§1.4): the born project
  // auto-focuses; the editor takeover opens on it.
  function pickKind(kind: 'app' | 'website', name: string): void {
    void birthProject(orgId, kind).then(async (born) => {
      if (born === null) return; // a refusal renders nowhere — the gate is role-side
      if (name !== '') await desk.renameProject(orgId, born, name).catch(() => undefined);
      focusProject(born);
      setEditing(true);
    });
  }

  // P3 (ruled 2026-08-19: "the layout tree on left and map on center is
  // waiting" — a fresh session opens with the sidebars CLOSED): the Layout tab
  // seeds the left slot WITHOUT opening it; the Workspace IS the center, so
  // the old right-slot Map seed died with the editor takeover's center.
  const leftTabsRef = useRef(leftTabs);
  leftTabsRef.current = leftTabs;
  useEffect(() => {
    if (!editing) return;
    if (leftTabsRef.current.length === 0) {
      const t = newTab('layers');
      setLeftTabs([t]);
      setLeftActive(t.id);
    }
  }, [editing, focusedProjectId]);

  const toggleLabel = (narrow ? leftOverlayOpen : leftShown) ? 'Hide left sidebar' : 'Show left sidebar';
  const appClass = [
    styles.app,
    styles.editorApp,
    leftOpen ? styles.appLeft : '',
    panelOpen ? styles.appPanel : '',
    bottomOpen ? styles.appBottom : '',
    leftResizing || panelResizing || bottomResizing ? styles.appResizing : '',
  ]
    .filter(Boolean)
    .join(' ');
  const appVars: Record<string, string> = {};
  if (leftW !== null) appVars['--leftW'] = `${leftW}px`;
  if (panelW !== null) appVars['--panelW'] = `${panelW}px`;
  if (bottomH !== null) appVars['--bottomH'] = `${bottomH}px`;

  // THE ONE DASHBOARD (D1): the resting shell. The editor grid below renders
  // only ENTERED (D5) — its console/panel/tab state lives up here in Shell,
  // so leaving and re-entering keeps every tab exactly as left.
  if (!editing) {
    return (
      <DashboardShell
        onEnterEditor={enterEditor}
        onPickKind={pickKind}
      />
    );
  }

  return (
    <div className={appClass} style={Object.keys(appVars).length > 0 ? (appVars as React.CSSProperties) : undefined}>
      <Titlebar
        onBack={() => {
          if (takeover !== null) {
            closePublishTakeover();
            return;
          }
          setEditing(false);
        }}
        {...(focusedProjectId !== null ? { projectId: focusedProjectId } : {})}
        {...(focusedProjectId !== null
          ? { onPublish: () => openPublishTakeover({ projectId: focusedProjectId, section: 'publish' }) }
          : {})}
        toggleLabel={toggleLabel}
        onToggleSide={toggleLeft}
        bottomVisible={bottomOpen || bottomOverlay}
        onToggleBottom={toggleBottom}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
      />
      {leftOverlay || panelOverlay || bottomOverlay ? (
        <div
          className={styles.scrim}
          onClick={() => {
            setLeftOverlayOpen(false);
            setPanelOverlayOpen(false);
            setBottomOverlayOpen(false);
          }}
        />
      ) : null}
      {/* D11: THE LEFT SLOT — the same panel species on the side track (the
          projects tree died into it; Layout rides here by default). */}
      {(leftShown || leftOverlay || leftClosing || leftTabs.length > 0) ? (
        <SidePanel
          side="left"
          tabs={leftTabs}
          activeId={leftActive}
          onTabs={(tabs, activeId) => {
            setLeftTabs(tabs);
            setLeftActive(activeId);
          }}
          hidden={!leftOpen && !leftOverlay}
          overlay={leftOverlay}
          onResize={setLeftW}
          reservedLeft={480 + (panelOpen ? 340 : 0)}
          onResizingChange={setLeftResizing}
        />
      ) : null}
      <main className={styles.main}>
        {/* P3 THE CENTER FLIP: the WORKSPACE is the permanent center — home
            renders it; threads/code keep their routed screens. */}
        {route.name === 'home' ? <WorkspacePane /> : <Screen route={route} />}
      </main>
      {/* THE EDITOR ARC (D-e2): the console mounts ALWAYS in the editor — the capsule is
          the one chat entry; with no AI connected it carries the connect card. The
          dashboard shows no console and no panels (D1); the tabs and their state live
          in Shell and return with the takeover. */}
      <Console
        tabs={consoleTabs}
        activeId={consoleActive}
        mode={consoleMode}
        sticky={consoleSticky}
        onTabs={(tabs, activeId) => {
          setConsoleTabs(tabs);
          setConsoleActive(activeId);
        }}
        onMode={setConsoleMode}
        onSticky={setConsoleSticky}
      />
      {(bottomShown || bottomOverlay || bottomClosing || bottomTabs.length > 0) ? (
        <BottomPanel
          tabs={bottomTabs}
          activeId={bottomActive}
          onTabs={(tabs, activeId) => {
            setBottomTabs(tabs);
            setBottomActive(activeId);
          }}
          hidden={!bottomOpen && !bottomOverlay}
          overlay={bottomOverlay}
          onResize={setBottomH}
          reservedTop={35 + 240}
          onResizingChange={setBottomResizing}
        />
      ) : null}
      {(panelShown || panelOverlay || panelClosing || panelTabs.length > 0) ? (
        <SidePanel
          tabs={panelTabs}
          activeId={panelActive}
          onTabs={(tabs, activeId) => {
            setPanelTabs(tabs);
            setPanelActive(activeId);
          }}
          hidden={!panelOpen && !panelOverlay}
          overlay={panelOverlay}
          onResize={setPanelW}
          reservedLeft={(leftOpen ? (leftW ?? 300) : 0) + 480}
          onResizingChange={setPanelResizing}
        />
      ) : null}
      {/* Tier 33: ambient frames for agents whose threads are NOT on screen (LAW 1 — the
          in-feed group header owns visible liveness; these own only the out-of-sight kind).
          Fix ledger 2026-07-28 wave 1.5: CONSOLE tabs count as on-screen — T52 made the
          console the default reading surface but omitted its tabs here, so a console-open
          thread got a duplicate ambient "· Working" frame (two narrators for one run). A
          folded pill still counts: its threads are one hover away and the capsule sits on
          screen — the frame would render directly beside it. */}
      <AgentFrames
        visibleThreadIds={[
          ...(route.name === 'thread' ? [route.threadId] : []),
          ...consoleTabs.flatMap((t) => (t.threadId !== null ? [t.threadId] : [])),
        ]}
      />
      <AnomalyStrip />
      {/* The project screen takeover: a direct grid child spanning main+panel+bottom;
          everything underneath stays mounted so Back restores the prior screen. */}
      <PublishTakeover />
      <SettingsScreen />
    </div>
  );
}

export function App() {
  // Tier 46 (FR-425, D-176): THE OWN-WINDOW APP (the rendered-app law, D-PT5) — a --focus-scene launch (or second-instance
  // forward, or the in-app "open focused" affordance) renders the FocusedShell instead
  // of the authoring shell. `viaLaunch` focus has no exit arrow (the window IS the
  // instrument — the D-176 shape); in-app focus keeps the way back.
  const [focus, setFocus] = useState<{ slug: string; viaLaunch: boolean } | null>(null);
  // Play: the store's focus request opens the app full screen (the way back stays).
  const focusReq = useValue('app.focusScene', () => store.panel.focusScene, []);
  const focusSeen = useRef(0);
  useEffect(() => {
    if (focusReq === null || focusReq.nonce === focusSeen.current) return;
    focusSeen.current = focusReq.nonce;
    setFocus({ slug: focusReq.slug, viaLaunch: false });
  }, [focusReq]);
  // THE GLOBAL DROP GUARD (live find 2026-08-01): Chromium's default for an unhandled
  // file drop is NAVIGATE-TO-FILE — a stray drop anywhere off a DropTarget blanked the
  // app. Window-level preventDefault makes stray drops inert; real drop zones handle
  // their own events before this and are unaffected.
  useEffect(() => {
    const inert = (e: DragEvent): void => e.preventDefault();
    window.addEventListener('dragover', inert);
    window.addEventListener('drop', inert);
    return () => {
      window.removeEventListener('dragover', inert);
      window.removeEventListener('drop', inert);
    };
  }, []);

  useEffect(() => {
    desk.focusedScene()
      .then((slug) => { if (slug !== null) setFocus({ slug, viaLaunch: true }); })
      .catch(() => undefined);
    const bridge = (window as unknown as { desk?: { onFocusScene?: (cb: (slug: string) => void) => () => void } }).desk;
    const off = bridge?.onFocusScene?.((slug) => setFocus({ slug, viaLaunch: true }));
    return () => off?.();
  }, []);

  return (
    <OrgProvider>
      {/* PROJECT FOCUS (2026-08-01): the ONE focus context — everything under the shell
          (rail, Map mounts, chat births, ⚙, drops) reads/aims through it. */}
      <FocusProvider>
        <GateOrShell
          focus={focus}
          onExitFocus={() => setFocus(null)}
          shell={<Shell />}
        />
      </FocusProvider>
    </OrgProvider>
  );
}
