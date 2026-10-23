# Tent NoCode

Tent NoCode is a desktop app for building apps and websites without writing code. Everything sits on one canvas: tables, screens, flows, triggers, services and notes are nodes you place, configure and wire together. Screens are edited in place at their real size. An AI builder can do the same work from a chat box.

It runs entirely on your own computer. There is no account on anyone's server: you sign up once, locally, and your projects, data and published apps stay on your machine unless you choose to move them.

## What it does

- **Build on one canvas.** Tables, screens, flows (33 step types), triggers, services from an 80-integration shelf, and notes, all as nodes wired together.
- **Screens from five building blocks.** Frame, text, field, chart and instance, with states (hover, pressed) and phone and tablet layouts.
- **An AI builder that uses what you already have.** If [Claude Code](https://claude.com/claude-code) is installed and signed in on your computer, the app finds it and uses it on your own login. No key, no setup. You can also add an Anthropic or OpenAI API key in Settings, Engines.
- **No AI at run time.** The AI helps you build. The apps you publish run on a plain engine with no model calls.
- **Publish on your computer.** Publishing serves the app from the local server at `http://<name>.localhost:4700`.
- **Run it on your own server.** Export a project as a `.tproject` file and serve it from any machine with Node and Postgres (see below).
- **Import and export.** Projects travel as `.tproject` files. Double-click one to import it.

## Requirements

- Windows 10 or 11 (the desktop app is built and tested on Windows)
- Node.js 20 or newer
- Optional: [Claude Code](https://claude.com/claude-code), installed and signed in, for the AI builder

Postgres is bundled. The app starts its own database on first launch, so there is nothing else to install.

## Run it from source

```sh
git clone https://github.com/ArynBuilds/tentis.git tent-nocode
cd tent-nocode
npm install
npm run desktop
```

`npm run desktop` builds the screen engine (`packages/tentkit`) and starts the app in development mode. On first launch it creates a database under `%APPDATA%\Tent NoCode` and asks you to create your local account.

To build the Windows installer:

```sh
npm run build:tentkit
npm run package -w apps/desktop
```

The installer lands in `apps/desktop/release/`.

## Run a project on your own server

1. In the app, open the project and choose **Export** to save it as a `.tproject` file.
2. On the server (Node 20+, a Postgres 15+ database), clone this repo, then run `npm install` and `npm run build:tentkit`.
3. Point `DATABASE_URL` at the database, then:

```sh
npm run server -- install app.tproject
npm run server -- serve
```

The app answers on port 4680 (set `PORT` to change it). `npm run server -- status` shows what is installed.

## How it is put together

```
apps/
  desktop/        the Electron app: the canvas, the editor, the local account, the local server's start
  server/         the server: the host the desktop runs, and the install/serve commands for your own server
packages/
  core/           the contracts: the five screen primitives, nodes and ports, flows, the .tproject format
  kernel/         components, screens, data, flows, integrations, consent, the workspace router
    migrations/   the workspace database
  room-server/    serving published apps
    migrations/   the published-apps database
  runner/         the AI loop and its tools (Claude Code or a direct API key)
  tentkit/        the screen engine, built into one browser file both hosts serve
scripts/          the engine build and the AI eval harness
```

The desktop app starts two things on your computer: a bundled Postgres (port 54329) and the local server (port 4700). Everything the interface does goes through the local server's workspace door, the same door a self-hosted server opens.

## Contributing

Open an issue or a pull request. Before sending code, run `npm run typecheck` (it must pass), and try the change in the running app.
