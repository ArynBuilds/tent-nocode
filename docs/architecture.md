# Architecture

This guide explains how Tent NoCode is put together: the processes that run on your computer, the two databases, the one router every call goes through, the canvas, screens, data, flows, integrations, the AI builder, consent and publishing. [architecture.html](architecture.html) is an interactive map of the same system; download it and open it in a browser.

## The shape

Everything runs on one computer, in one desktop app:

```
┌──────────────────────────── Electron app ─────────────────────────────┐
│  Window (React)                         Main process (Node)            │
│  canvas, screen editor, panels,  IPC →  local account, token minting,  │
│  chat, settings                         tab:// screen protocol,        │
│                                         heavy-operation loop           │
│                                                │  HTTP 127.0.0.1:4700  │
│                                                ▼                       │
│                       The host (apps/server, in-process)               │
│        workspace door · publish door · published apps · webhooks       │
│        AI runs (Claude Code or API key) · flow and trigger clocks      │
│                                                │                       │
│                                                ▼                       │
│                 Bundled Postgres 127.0.0.1:54329                       │
│                 workspace database · rooms database                   │
└────────────────────────────────────────────────────────────────────────┘
```

On launch, the main process (`apps/desktop/src/main/index.ts`):

1. reads or creates this install's secrets (`account.ts`): a token secret and a vault key;
2. starts the bundled Postgres under `%APPDATA%\Tent NoCode\pgdata` and then the host (`localServer.ts`);
3. registers the window's channels and opens the window, which asks you to sign up or unlock.

The host (`apps/server/src/host.ts`) creates the two databases if they are missing, applies both migration lines, gives the published-apps roles fresh passwords, and listens on `127.0.0.1:4700`.

## Two databases

| Database | Holds | Migrations |
| --- | --- | --- |
| `workspace` | Everything you author: projects, screens and their revisions, tables and rows, flows, triggers, integrations, chats, runs, the record of events, the vault | `packages/kernel/migrations` |
| `rooms` | Published apps: releases, the screens and tables they carry, their visitors' rows, flows that run for visitors | `packages/room-server/migrations` |

The rooms database is born hardened: two roles (`room_runtime` for visitors, `room_publish` for the publish door) with least grants, forced row-level security on every table, and policies that read the app and the visitor from per-connection settings. A visitor's own rows are stamped with their opaque per-app id and nobody else's are visible.

## One router, two mouths

Every workspace call is a procedure in one typed router (`packages/kernel/src/workspace/registry.ts` and its channel files): a read or a write, with a zod schema per argument, parsed at the door. The client type is inferred from the router, so the window's API is never written by hand.

Two adapters call it:

- the host's HTTP door: `POST /workspace/call` with `{ channel, args }` and a bearer token (`apps/server/src/workspace/routes.ts`);
- the desktop's IPC adapter, which forwards every procedure the main process does not answer itself (`apps/desktop/src/main/ipc/adapter.ts`), through the HTTP door with the token the main process holds.

The few things that must happen on the desktop (the save dialog, files on disk, the OS keychain, window controls) are answered by the main process in five small files under `apps/desktop/src/main/ipc/`.

Changes flow back as a stream: the database announces every changed row on the `desk_live` channel, the host's watcher turns it into a pointer event, and a delta computer turns pointers into fresh rows for every screen binding that reads the changed table. The window receives both over `GET /workspace/live` (server-sent events).

## The canvas

The workspace is one canvas where everything is a node: tables, screens, flows, triggers, services, notes. The editor (`apps/desktop/src/renderer/lib/canvas/`) follows tldraw's shape:

- **one reactive record store** (`store.ts`, on `@tldraw/state`) holds nodes, wires, the screens' elements, camera, selection, hover and the current gesture;
- **undo** is a list of record diffs (`history.ts`);
- **tools are state machines** (`tools/`): select, create and hand, with states like pointing, translating, resizing and drawing a wire;
- **the property panel is schema-driven**: its rows come from the screen contract, not from per-component panels.

Every placeable thing (integrations, flow steps, triggers) comes from one shelf (`placeables.ts`), so the right-click menu, the node browser and the toolbar never disagree.

## Screens

A screen is built from five primitives declared once in `packages/core/src/primitives.ts`: **frame**, **text**, **field**, **chart** and **instance** (a placed copy of a saved component). Each has typed properties in shared groups (size, position, layout, paint, type, effects), plus two dimensions on top: **states** (hover, focus, pressed, disabled) and **breakpoints** (phone and tablet).

Every change to a screen is an operation. Operations are applied to the screen's document and checked by one validator (`packages/kernel/src/scenes/validate.ts`) in a single pass; a passing batch becomes a new revision. Nothing writes a screen any other way, which is what makes undo, the AI's edits and the live push safe.

The screen engine, **tentkit** (`packages/tentkit/src/tentkit.tsx`), draws a document from the same contract: one stylesheet for the base, the states and the breakpoints, ten chart marks, and instances expanded in place. It is built into one browser file named by its content hash. The editor shows screens through the `tab://` protocol and published apps load the same file, so a screen looks the same in both.

Screens get their data through **bindings** of three kinds: a **query** over a table (filtered and sorted in SQL), an **asset**, or a **clock**.

## Tables, flows and triggers

- **Tables** are rows with a declared schema. Queries are composed in one place (`packages/kernel/src/tabs/datasetQuery.ts`), with every column checked against the schema and every value passed as a bound parameter.
- **Flows** are documents of steps wired together (`packages/core/src/flows.ts`). The engine (`packages/kernel/src/flows/`) runs them from a registry of 33 step definitions, one file per step, and records every execution.
- **Triggers** start flows: a webhook, rows changing in a table, or a clock. The host sweeps due triggers and pending flow runs every few seconds, for the workspace and for published apps.

## Integrations

The shelf has 80 services, each one data file in `packages/kernel/src/integrations/defs/`. One executor makes every outbound call: it opens the credential from the vault, applies per-connection daily budgets (tighter for calls that send), refuses redirects and scrubs what it stores. Webhooks arrive at `POST /hook/<token>` and are checked against each service's signature scheme. Services that sign in through their own page use an OAuth flow whose callback is the host's `/oauth/callback`.

## The AI builder

The AI works on the same objects you do, through the same validator, and never at run time: published apps run with no model calls.

```
your message → spawnRun → the run spawner → executeSpawnedRun
                                              │
                         ┌────────────────────┴────────────────────┐
                 API key saved for the vendor            Claude Code on this computer
                 ApiDriver, tools in-process             ClaudeCodeDriver, tools as an MCP child
                         └────────────────────┬────────────────────┘
                                              ▼
                          the seven tools: read · contract · rows · record · pixels · edit · brief
                                              ▼
                   edit: project grammar → operations → consent → validator → revision → live push
```

- **One prompt.** `packages/kernel/src/charters/charter.ts` composes one charter for chat turns and runs.
- **A grammar made for the AI.** `packages/kernel/src/dialect.ts` renders a project, a screen or a flow as line-numbered text, and reads edited text back into operations without evaluating anything. Design rules (bans, budgets, direction) are compile errors, so a bad edit is refused with the reason instead of landing. The project text ends with a `canvas { }` block (`packages/kernel/src/canvasLens.ts`): where every card sits and which cards are grouped, so the AI can arrange the canvas the same way it edits everything else.
- **Seven tools** live in one file (`packages/runner/src/tools.ts`): fat definitions, thin handlers, each one gate, then the change, then a receipt.
- **Claude Code** is found at startup (`claude --version`). When it is there, every run that no API key claims goes to it, on your own sign-in, with `--setting-sources ''`, an explicit allow list of the seven tools, and the tools served by a small MCP process (`apps/desktop/src/main/mcp/toolsMcpEntry.ts`). Work the AI starts from inside that process is left in the runs table and picked up by the host when the database announces it.

## Consent

Every action the AI can take has one row in `CONSENT_POLICY` (`packages/kernel/src/consent.ts`) with a class:

- **free**: changes project content that revisions can undo; lands at once.
- **ask-once**: standing behaviour or access inside the project; asks the first time.
- **always-ask**: reaches outside the project or cannot be undone; shows a card every time, in every mode.

## Publishing

Publishing turns a project into a release and serves it:

1. The workspace builds the project's closure: the chosen screens, the components and operations they use, the tables they read (rows only if you tick them) and notes (`buildPackageClosure`).
2. The publish door (`packages/room-server/src/publish.ts`) checks the token, maps the account to its rooms organization, and lands the release in the rooms database in one transaction as the `room_publish` role.
3. The app router (`packages/room-server/src/router.ts`) resolves `<name>.localhost:4700` to the app and serves its pages, its data (`/api/data`), its actions (`/api/action`) and a live stream (`/data/live`) as the `room_runtime` role, with the visitor's context set per connection.

## Projects as files

A project travels as a `.tproject` file (`tproject@2`, `packages/core/src/lsgPackage.ts`): one manifest of projects, tables, screens, library items, flows, triggers, services, operations and notes, with a content hash. Export builds it in the host; import is one merge that finds or creates the project.

## Running on your own server

`apps/server/src/cli.ts` has three commands for a server of your own:

- `install <app.tproject>`: migrates the database in `DATABASE_URL` and lands the project;
- `serve`: serves that one app on port 4680 (`httpHost.ts`), with its flows, triggers and integrations running in the background (`lanes.ts`);
- `status`: what is installed and what ran last.

## Heavy operations

Operations that need real compute (Python through Pyodide, ONNX models) run in a sealed worker on the desktop. The main process runs a small loop (`apps/desktop/src/main/runner/opsLoop.ts`) that claims pending operation runs through the workspace door, runs them in the worker and posts the results back.
