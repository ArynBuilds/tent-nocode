# Contributing to Tent NoCode

Thank you for helping. Tent NoCode is an app builder people trust with their data and their projects, so we value small, well-explained changes that were tried in the running app over large rewrites.

## Ways to contribute

- **Report a bug** with the bug report template. Include steps, expected and actual behaviour, the terminal output and your version.
- **Propose a feature** with the feature request template before writing a large change, so we can agree on the approach.
- **Improve the docs.** If something in `docs/` does not match the code, the code wins; please fix the doc.
- **Security issues** go through private reporting, never public issues. See [SECURITY.md](SECURITY.md).

Good first areas: more integrations on the shelf (one data file each in `packages/kernel/src/integrations/defs/`), screen thumbnails on the dashboard cards, macOS and Linux builds of the desktop app, and translations of the interface.

## Development setup

You need Node.js 20 or newer and npm, on Windows. Claude Code, installed and signed in, is optional but makes the AI builder work without a key.

```sh
git clone <your fork> tent-nocode && cd tent-nocode
npm install
npm run desktop
```

`npm run desktop` builds the screen engine and starts the app with hot reload for the interface. Main-process changes (`apps/desktop/src/main`, `apps/server`, `packages/*`) need a restart: close the window and run it again.

The app keeps its data in `%APPDATA%\Tent NoCode`. To start over, close the app and delete that folder; your next launch creates a fresh database and asks you to sign up again.

## Checks

Run this before every pull request; CI runs the same, plus the engine build:

```sh
npm run typecheck
```

There is no test suite yet. Every change is tried in the running app the way a person would use it: click through the screens you touched, and for anything the AI or a published app does, run it end to end.

## Where things live

| Folder | What it holds |
| --- | --- |
| `apps/desktop` | The Electron app: the canvas, the screen editor, panels, the local account, starting the local server |
| `apps/server` | The server host the desktop runs, and the `install` / `serve` commands for your own server |
| `packages/core` | The contracts: the five screen primitives, nodes and ports, flows, the `.tproject` format |
| `packages/kernel` | Screens, data, flows, integrations, consent, the AI's grammar, and the one router every call goes through |
| `packages/room-server` | Serving published apps |
| `packages/runner` | The AI loop and its tools |
| `packages/tentkit` | The screen engine that draws a screen in the editor and in a published app |

[docs/architecture.md](docs/architecture.md) explains how these fit together.

## Code conventions

- **Extend what exists.** Before adding a module, a node, an endpoint or a helper, search for the code that already handles the concern and extend it. Two systems for one concern is a bug.
- **One router.** Every workspace call is a procedure in `packages/kernel/src/workspace/` with zod inputs per argument. The desktop and the server are two mouths over the same router; do not add a second door.
- **Consent is a table.** A new action the AI can take gets one row in `CONSENT_POLICY` (`packages/kernel/src/consent.ts`). Anything that reaches outside the project or cannot be undone is `always-ask`.
- **Migrations only move forward.** A schema change is a new file in `packages/kernel/migrations` (the workspace) or `packages/room-server/migrations` (published apps), never an edit to one that has run. A column both databases read goes in both.
- **The design system is the tokens.** Interface styles use the tokens in `apps/desktop/src/renderer/tokens.css` through CSS modules; no raw colors.
- **TypeScript strict, no `any`.** Use proper types or `unknown` with narrowing.
- **Files stay small and do one thing.** Split a file before it passes 500 lines.
- **A comment says why, in one or two lines.** Never what the code does, never history.

## Commits and pull requests

- Branch from the default branch; keep one logical change per pull request.
- Write commit messages in the imperative mood (`Add a gauge chart mark`). Reference issues with `Fixes #123`.
- Fill in the pull request template: what changed, why, how you tested it, and screenshots for interface changes.
- Update `README.md` and `docs/` when behaviour, settings or commands change.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
