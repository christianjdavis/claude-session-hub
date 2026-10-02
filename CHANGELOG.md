# Changelog

All notable changes to Claude Session Hub. The version is the git tag; the section for a tag is
used as its GitHub Release notes.

## [0.3.0] - 2026-10-02

- **Files / Browse files** now match the Explorer: dotfiles such as `.claude`, `.github` and
  `.vscode` are listed, and `.gitignore`d entries appear dimmed instead of being hidden. Only
  `.git` and build or dependency folders (`node_modules`, `dist`, `.venv`, …) stay out of the
  tree; the eye icon ("Show Excluded Folders") reveals them.
- Session terminals survive a window reload: the running session is restored and re-bound
  instead of killed, so it stays in **Working**.
- Sessions whose first prompt is large (pasted screenshots) are listed again. The transcript
  head reader stopped at 256 KB, found no working directory inside the truncated record and
  dropped the transcript for good, so such a session vanished from every list the moment its
  process exited. It now keeps reading until that record is complete.
- `/resume` of another session inside a running terminal re-binds the terminal to the new
  session id instead of leaving it stale.
- Finished turns are detected in long tool-heavy sessions: the tail read widens when the last
  64 KB holds no prompt or end-of-turn record.
- When another extension keeps the extension host busy, a one-time warning says so and offers
  to open Running Extensions; slow child listings log the host lag they waited through.

## [0.2.0] - 2026-09-18

- **Files changed** now mirrors the Source Control view: **Staged Changes** (HEAD ↔ index) above
  **Changes** (index ↔ working tree, untracked included), plus **Committed** for what the
  session's commits changed. Rows and group headers carry **Stage / Unstage / Discard** and
  **Stage All / Unstage All / Discard All**, so working-tree changes can be handled without
  asking Claude. Lists refresh right after each action.

## [0.1.0] - 2026-09-18

First public release.

- **Working**: Needs input / Completed · review / Running / Idle / Background jobs / Outside
  workspace, driven by the Claude Code live registry cross-checked against the transcript.
  Parked interactive sessions and their background worker show as one row.
- **Focus**: pin repos and folders from All available; pin order, drag or Move Up/Down to reorder.
- **All available**: every repo under the configured roots as a folder tree, with recent sessions.
- Per-session PR-style **Files changed** (commits + working tree, other repos the session
  worked in, shell edits included), **Commits**, **Branch vs base**, and a **Browse files**
  tree with upload by picker or drag-and-drop.
- Sessions open as terminals (panel or editor tab); resume, fork, attach to background jobs.
- All disk and git work runs in a forked worker so a busy extension host never blocks the tree.
