# Changelog

All notable changes to Claude Session Hub. The version is the git tag; the section for a tag is
used as its GitHub Release notes.

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
