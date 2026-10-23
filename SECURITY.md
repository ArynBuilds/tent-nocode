# Security policy

## Supported versions

Tent NoCode runs on your own computer. Security fixes land on the default branch and in the next release; please run the latest release.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository. Include the affected version or commit, the file or screen, reproduction steps and the impact you observed.

We aim to acknowledge reports within 3 working days and to agree on a disclosure date with you once a fix is available. We are happy to credit reporters in the release notes.

---

## Security model

Tent NoCode is designed for one person on their own computer. It runs a database, a server and an AI builder there, so the main questions are who can reach them and what the AI may do without asking.

### Actors

| Actor | Authenticates with | Can do |
| --- | --- | --- |
| You | Name, email and password, created once on first launch | Everything in the app |
| The desktop window | Nothing of its own: it asks the main process, which holds the token | Call the workspace through the main process only |
| The local server | Verifies an access token signed with this install's secret | Read and write your workspace, publish apps |
| The AI builder | Claude Code on your own sign-in, or an API key you saved | Use the app's own tools, under the consent rules below |
| A visitor of a published app | Nothing, or the published app's own sign-in | What that app's screens and actions allow |

### The account

- The first launch creates the account. After that the app only asks for the password; there is no second account.
- The password is hashed with scrypt and a random salt and stored in `account.json` in the app's data folder (`%APPDATA%\Tent NoCode`). It never leaves the computer.
- Locking the app (Settings, sign out) ends the session; the account and everything built stay.

### The tokens and the keys

- Every install makes two random 32-byte secrets on first launch: the token secret and the vault key. They live in `host-secrets` in the data folder, sealed by the operating system's keychain (Windows DPAPI through Electron's `safeStorage`) when it is available.
- After you unlock, the main process mints short-lived (one hour) HS256 access tokens with the token secret. Tokens never reach the window.
- API keys and service credentials you save are encrypted in the database with AES-256-GCM, each under its own data key wrapped by the vault key. The vault key is held only in the server's memory while the app runs.

### The network

- The local server listens on `127.0.0.1:4700` only. Published apps answer at `http://<name>.localhost:4700`, which resolves to your own computer. **Do not forward port 4700 or expose it on a network**: anyone who reaches it can reach your published apps and try the workspace door.
- The bundled Postgres listens on `127.0.0.1:54329` only.

### What the AI may do without asking

Claude Code runs with `--setting-sources ''` (your own `~/.claude` settings do not apply), `--permission-mode default` and an explicit list of allowed tools: the app's own seven tools (read, contract, rows, record, pixels, edit, brief). Anything outside that list falls to a refusal.

Inside the app, every action the AI proposes has a consent class (`packages/kernel/src/consent.ts`):

| Class | Meaning | Examples |
| --- | --- | --- |
| free | Changes project content that revisions can undo | Editing a screen, renaming a project |
| ask-once | Standing behaviour or standing access inside the project | Creating a project, a standing work proposal |
| always-ask | Reaches outside or cannot be undone | Connecting a service, settings, the app plan, deleting whole tables or screens |

An always-ask action shows a card and waits for your answer in every mode.

### Integrations

Outbound calls to services go through one executor with per-connection daily budgets and a tighter budget for calls that send. Redirects are refused and stored results pass a scrub that removes credentials.

### What this does not protect against

- **The local database password is fixed.** The bundled Postgres uses a known password on `127.0.0.1`. Any program already running on your computer as you can connect to it. Treat your computer's user account as the boundary.
- **Prompt injection.** The AI reads your project, and integrations can bring in outside text. The always-ask cards are the defence; read each one before you approve it.
- **Published apps are public where they are served.** On your own server, a published app is reachable by anyone who can reach that server. Put it behind HTTPS and only publish what you mean to share.
