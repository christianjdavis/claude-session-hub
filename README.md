# Claude Session Hub

One VS Code window for every Claude Code session on the machine.

Open VS Code on a parent folder such as `~/dev`. The extension finds every git
repository below it and every Claude Code session whose working directory is
below it, then keeps a live queue of what needs you.

## Install

Grab the latest `claude-session-hub-<version>.vsix` from
[Releases](https://github.com/christianjdavis/claude-session-hub/releases) and install it:

```sh
code --install-extension claude-session-hub-<version>.vsix
```

or in VS Code: Extensions view → `···` → **Install from VSIX…**. The extension needs the
`claude` CLI on your PATH; it offers to install it if missing.

## Views

**Working** (activity bar → Claude Sessions)

| Section | Meaning | Source |
| --- | --- | --- |
| Needs input | Claude is blocked on a permission prompt, question, or dialog | `~/.claude/sessions/<pid>.json` `status: waiting` |
| Completed · review | Claude finished a turn after your last prompt and you have not looked yet | registry `idle` + transcript `end_turn` after last human prompt (the transcript wins over a registry entry that is stale) |
| Running | The model is working | registry `status: busy`, or a prompt in the transcript newer than the registry's last update |
| Idle | Live sessions waiting at the prompt with nothing new | registry `idle` |
| Background jobs | `claude --bg` sessions and their state | `~/.claude/jobs/*/state.json` |
| Outside workspace | Live sessions whose cwd is not under any root | |

A review item clears when you focus its terminal, or via **Mark reviewed**.

Recent Claude Code versions run an interactive conversation as two processes: a
parked terminal UI and a background worker that does the work. The hub folds the
pair into one session row (the worker's state, the UI's terminal), so a
conversation never shows up as both a stuck "Running" session and a background
job.

**Focus**: the repos and folders you are actually working on, promoted by hand.
The pin icon on a repo or folder row in All available (or right-click → **Pin to
Focus**) adds it here with the same sessions and `Files` group; rows stay in the
order you pinned them, and you can drag them or use **Move Up / Move Down** to
reorder. Unpin from either view. Pins are saved across reloads and windows.
Working stays a live-process view; Focus is the hand-picked project list.

**All available**: every repo under the roots, with its recent sessions. The
`+` icon on a repo row starts a session there; it asks for a name first (leave
it blank for an unnamed one). The window icon on a repo row
(and **Open Repo in New Window** on sessions) opens that repo in its own VS Code
window; if a window already has it open, VS Code focuses that one instead.

**Browsing and uploading files.** Every session row ends with a collapsed
**Browse files** group rooted at its repo (or working directory), and every
repo/folder row in All available has a **Files** group: the whole tree, not only
what the session changed, so any file can be opened. Dotfiles, build output
(`node_modules`, `dist`, `.venv`, …) and `.gitignore`d paths are hidden; the eye
icon in the view title shows them, marked `ignored`. The upload icon on a
folder-like row (or dropping files from Finder or the Explorer onto it) copies
them into that directory, asking before anything is replaced. Directory
listings are read in the worker and cached; a live session's activity re-reads
the folders under its root.

## Sessions as tabs

Clicking a session opens (or focuses) a terminal running `claude --resume <id>`
in that session's own working directory. Terminals open as editor tabs by
default (`sessionHub.terminalLocation`), so you tab between sessions like
files. Terminals where you started `claude` by hand are adopted automatically
by matching the process tree to the registry.

| Command | Default keys |
| --- | --- |
| Switch Session… (dropdown grouped by state) | `⌘⇧;` |
| Next / Previous Session | `⌃⌥]` / `⌃⌥[` |
| Jump to Session Needing Input | `⌃⌥⏎` |

The status bar shows `needs-input · review · running · idle` counts; click it
to open the switcher.

## Settings

All under `sessionHub.*`: `claudePath`, `terminalLocation`, `roots`,
`repoScanDepth`, `maxAgeDays`, `maxPerRepo`, `pollIntervalMs`,
`clearReviewOnFocus`, `notifications.enabled`, `adoptExternalTerminals`,
`useOfficialExtensionWhenCwdMatches`, `extraResumeArgs`, `useWorker`.

## Performance

All transcript scanning and git work runs in a small worker process
(`dist/worker.js`) that the extension forks on activation. The VS Code
extension host is one Node process shared by every extension, and its file I/O
pool is often saturated by others (language servers, Copilot, GitLens); a
separate process has its own pool, so reading a few registry files takes
milliseconds rather than seconds no matter what else is running. If the worker
crashes repeatedly the hub falls back to in-process scanning and says so in the
"Claude Sessions" output channel. Set `sessionHub.useWorker` to `false` to
always run in-process.

After every build the worker prefetches the groups of live sessions, sessions
you have expanded, and the most recent ones, and pushes them to the extension
host, so expanding a row is a cache hit rather than a round trip. Cached
children are refreshed in the background when the session changes; commit file
lists are immutable and cached for good.

The output channel separates the two halves of every timing: `build 643 ms
(worker 9 ms: …)` means the worker finished in 9 ms and the rest was the
extension host's event loop being busy with other extensions (`host loop lag`
is reported when that exceeds half a second, and polling backs off while it
lasts). This typically happens for the first two or three minutes after a
window reload while language extensions activate; it is not something this
extension can shorten.

## Development

```sh
npm install
npm run compile      # bundle to dist/extension.js + dist/worker.js
npm run typecheck
npm test             # unit tests (queue, stores, helpers, worker round trip)
npm run snapshot     # build a snapshot from your real ~/.claude and print it
npm run package      # .vsix
```

Press F5 to launch an Extension Development Host on `~/dev`.

## Releasing

CI (`.github/workflows/ci.yml`) typechecks, tests and packages every push and pull request on
macOS and Linux. A release is a tag:

```sh
# add a "## [x.y.z] - date" section to CHANGELOG.md, then
npm run release -- patch    # or minor / major: bumps package.json, commits, tags vX.Y.Z, pushes
```

The release workflow (`.github/workflows/release.yml`) checks that the tag matches
`package.json`, builds the `.vsix`, and publishes a GitHub Release with the CHANGELOG section
as notes. Set the `VSCE_PAT` repository secret (a Marketplace personal access token for the
`davisc` publisher) to also publish to the VS Code Marketplace, and `OVSX_PAT` for Open VSX.

No setup steps are required before installing: if the `claude` CLI is not on
your PATH the extension offers to run the official installer for you (or lets
you point `sessionHub.claudePath` at an existing binary). Git and `ps` come
with macOS/Linux.

Requires Claude Code 2.1.27x or newer (the live registry with `status` /
`waitingFor` fields). Not affiliated with Anthropic. Session-scanning approach
adapted from [vswt](https://github.com/vana123/vswt) (MIT).
