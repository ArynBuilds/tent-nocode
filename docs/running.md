# Running Nodeloom

This guide covers running the app from source, building the installer, connecting an AI engine, publishing, running a project on your own server, where your data lives, backups and troubleshooting.

## Requirements

- Windows 10 or 11
- Node.js 20 or newer and npm
- Optional: [Claude Code](https://claude.com/claude-code), installed and signed in

Postgres is bundled. There is nothing else to install.

## From source

```sh
git clone https://github.com/ArynBuilds/nodeloom.git && cd nodeloom
npm install
npm run desktop
```

`npm run desktop` builds the screen engine (`packages/tentkit`) and starts the app with hot reload for the interface. On first launch it creates its database and asks you to create your account. The account is stored only on this computer; every later launch asks for its password.

## The installer

```sh
npm run build:tentkit
npm run package -w apps/desktop
```

The one-click installer lands in `apps/desktop/release/`. It installs per user (no administrator prompt), registers `.tproject` files to open in the app, and never deletes your data when you uninstall.

## The AI builder

The app picks its engine by itself:

- **Claude Code.** If `claude` is on your PATH and signed in, the app finds it at startup and uses it on your own sign-in. You do not need a key. Check with `claude --version`; sign in with `claude` in a terminal.
- **An API key.** In **Settings, Engines**, add an Anthropic or OpenAI key. A saved key takes the chat turns of its vendor; it is encrypted in your local database.

With neither, the chat explains how to connect one. The apps you build never call a model when they run.

## Publishing on this computer

Open a project, choose **Publish/Export** (or **Settings** on its dashboard card), then **Publish**. Pick the address name and what to include, then publish. The app answers at:

```
http://<name>.localhost:4700
```

`*.localhost` always points at your own computer, so a published app is reachable only from it. **Take it offline** stops the address; your project is not touched.

## On your own server

1. In the app, open the project and choose **Export** to save it as a `.tproject` file.
2. On the server (Node 20+, a Postgres 15+ database), clone this repository, then:

```sh
npm install
npm run build:tentkit
export DATABASE_URL=postgres://user:password@localhost:5432/nodeloom
npm run server -- install app.tproject
npm run server -- serve
```

The app answers on port `4680` (set `PORT` to change it). Put a TLS reverse proxy (Caddy, nginx) in front of it for a public address. `npm run server -- status` shows what is installed and the last events.

## Integrations

Most services on the shelf connect with a key you paste in. Services that sign in through their own page (OAuth) need an app registration of your own with that service, given to the app as `TENT_OAUTH_<SERVICE>_ID` and `TENT_OAUTH_<SERVICE>_SECRET` in the environment it starts in; without them, those services show as coming later. Webhooks reach the app at `http://127.0.0.1:4700/hook/<token>`, so a service on the internet needs a tunnel to call it.

## Where your data lives

Everything is in `%APPDATA%\Nodeloom`:

| Path | What it is |
| --- | --- |
| `pgdata/` | The bundled Postgres cluster: both databases |
| `account.json` | Your account: name, email and the password hash |
| `host-secrets` | This install's token secret and vault key, sealed by Windows |
| `workspaces/` | Files the app and its heavy operations work in |
| `logs/boot.log` | The startup log |

## Backups

Close the app, then copy the whole `%APPDATA%\Nodeloom` folder. To move a single project to another computer, export it as a `.tproject` file instead; secrets and API keys never travel in a project file.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "port 4700 is taken" or "port 54329 is taken" on startup | Another copy of the app, or another program, holds the port. Close it and start again. |
| The AI says there is no engine | Install and sign in to Claude Code, or add an API key in Settings, Engines. Restart the app after installing Claude Code. |
| "the database at ... is not UTF-8" | The data folder was created by something else. Close the app and move `pgdata` aside; a fresh one is created on the next launch. |
| A published address does not open | Use `http://`, not `https://`, and keep the `:4700`. The app must be running. |
| Start over completely | Close the app and delete `%APPDATA%\Nodeloom`. |
