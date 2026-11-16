# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run compile                          # tsc (extension) + esbuild (webview bundle) + copy body.html/styles.css -> out/
npm run deploy                           # compile + copy into installed extension (then reload VS Code window)
npm run watch                            # tsc watch - extension host code only
npm run watch:webview                    # esbuild watch - webview bundle only (HTML/CSS still need compile)
npm test                                 # all Vitest tests (test/**/*.test.ts)
npx vitest run test/tabMatch.test.ts     # one test file
npx vitest run -t "name of test"         # tests matching a name
npm run generate-sprites                 # regenerate sprite assets (scripts/, uses dev-only canvas)
```

**Iteration loop:** `npm run deploy` -> **Ctrl/Cmd+Shift+P -> Developer: Reload Window**. `deploy` compiles and copies `out/` (extension JS, `session/`, webview bundle + HTML/CSS), `assets/` and `package.json` into every `~/.vscode/extensions/madeby10am.claude-code-session-*/` (and `local.*`) folder, updating the installed extension in place. It is a bash loop, so on Windows run it from Git Bash. There is no dev server.

Alternatively, press **F5** to launch an Extension Development Host window for isolated testing.

**Which script to use** (use these in place of manual package-and-install steps):

- `npm run deploy` - fastest way to try a change. Builds the extension and copies it directly over the installed version (currently 2.2.0). Then run "Developer: Reload Window".
- `npm run package` - makes the `.vsix` file. Use it for a complete installable build.
- `npm test` - runs the repo's Vitest tests. Run them after each change.

Caveat: `npm run deploy` overwrites the installed extension's files. To go back to the original, reinstall the original 2.2.0 VSIX.

## Architecture

A VS Code extension ("Claude Code Session") that monitors Claude Code CLI sessions and displays them in an animated pixel art sidebar.

**Data flow:** `~/.claude/projects/**/*.jsonl` -> `SessionManager` -> `Panel` -> Webview

**Per-window scoping:** Each VS Code window runs its own extension host. `SessionManager` receives the window's workspace folder paths and only watches the matching project-log folders under `~/.claude/projects/` (folder names are the project path with non-alphanumerics replaced by `-`; subdirectory sessions match by prefix). A window with no folder open shows all sessions. The manager is rebuilt on `onDidChangeWorkspaceFolders`.

### Source files (`src/`)

- **extension.ts** - Entry point. Wires `SessionManager` -> `Panel`, registers the `claude-code-session.sidebar` webview view provider and the `claude-code-session.open` command. Passes workspace roots to `SessionManager`.
- **sessionManager.ts** - File-watches `~/.claude/projects/` for JSONL session logs (filtered to this window's projects). Parses entries to extract session metadata (tokens, activity state, tool usage, model, context %). Emits `Map<string, SessionState>` updates via callback with 100ms debounce. Activity state machine: `idle -> user_sent -> tooling -> responding -> idle -> sleeping`.
- **session/** - Parsing and data modules (also `tabMatch.ts`: editor-tab label -> session by chat title; `dismissed.ts`: hide closed/dismissed sessions until new activity, and always hide Agent SDK sessions via `isBackgroundSession`; `gitActivity.ts`: reflog -> push/pull/merge/commit feed): `jsonlParser.ts` (JSONL -> SessionState; one API response spans multiple lines sharing a `message.id` - usage is counted once per id), `tokenActivity.ts` (24h token events for the chart, same dedupe), `usageCompute.ts` (live rate-limit meters via the Claude OAuth token: macOS Keychain first, else `~/.claude/.credentials.json`), `claudeEnvironment.ts` (paths, MCP servers, skills, `encodeProjectPath`), `activityTimers.ts`, `categorize.ts`, `clis.ts`, `types.ts`.
- **shared/messages.ts** - Message payload types shared by the extension host and the webview bundle.
- **panel.ts** - `WebviewViewProvider`. Builds the webview HTML shell, handles webview messages, tab -> session sync (`syncActiveTab`, `onTabsClosed`), session focus, and project info. Git status follows the focused session's repo (`repoRoot` of its `cwd`); the activity feed spans every session's repo. Branch-name-bearing git calls use `execFileSync` (no shell) because branch names are attacker-controlled; `gh repo view` is cached 5 min.
- **webview/index.ts** - All webview-side JS (session cards, robot sprite animation, usage meters, token chart). Bundled by esbuild to `out/webview/bundle.js`.

### Webview message protocol

Extension -> Webview (via `postMessage`):
- `{ type: 'sessionsUpdate', sessions: SessionState[] }` - visible sessions only (dismissed/background filtered out)
- `{ type: 'focusSession', sessionId }` - the active Claude editor tab changed; webview pins that session
- `{ type: 'projectInfo', data }` - focused repo status + merged git `activity[]` (see `shared/messages.ts`)
- `{ type: 'envData' | 'usageUpdate' | 'tokenActivity' }`

Webview -> Extension (via `vscodeApi.postMessage`):
- `{ type: 'ready' }`, `{ type: 'refreshUsage' }`, `{ type: 'refreshTokenActivity' }`
- `{ type: 'openSession', sessionId }` - bring the session forward (see below)
- `{ type: 'dismissSession', sessionId }` - hide it until new activity (also fired automatically when its tab closes)
- `{ type: 'newSession' }`, `openUrl`, `openFile`, `openFolder`, `inputSkill`
- `{ type: 'togglePlugin', pluginKey, enabled }` - writes `enabledPlugins[pluginKey]` to the first workspace folder's `.claude/settings.local.json` (Skills tab ON/OFF button on plugin rows)

### Session focus strategy (`focusSession`)

1. A terminal in `terminalMap` for the session -> `show()`
2. An open Claude editor tab (`claudeVSCodePanel` webview) whose label matches the session's chat title -> focus its group, then `workbench.action.openEditorAtIndex`
3. A terminal whose name includes the sessionId prefix
4. `claude-vscode.primaryEditor.open(sessionId)` for VS Code-entrypoint sessions; otherwise a new terminal **in the session's own cwd** running `claude --resume <id>`

## Pushing to GitHub

Remote is `madeby10am/claude-code-session` (personal). The active `gh` account is `nikjfly`, which gets a 403 here. Push with the stored `madeby10am` token for that one command, without switching accounts:

```bash
T=$(gh auth token --user madeby10am); AUTH=$(printf 'x-access-token:%s' "$T" | base64)
git -c credential.helper= -c "http.https://github.com/.extraheader=Authorization: Basic $AUTH" push origin main; unset T AUTH
```

Releases follow `.claude/commands/release.md` (`npm run package` builds the VSIX; `npm run release` uploads it). For `gh release`, prefix with `GH_TOKEN=$(gh auth token --user madeby10am)`.

## Key Conventions

- **Webview assets**: HTML body and CSS live in `src/webview/body.html` / `styles.css`; JS in `src/webview/index.ts` (esbuild bundle). `panel.ts:buildHtml()` only assembles the shell.
- **Sprite sheet**: Robot character from `assets/Robot Character/Sprite sheets/Directional sprite sheets/Down sprite sheet.png`. URI injected via `webview.asWebviewUri()`. Always set `ctx.imageSmoothingEnabled = false` after `scale()`; CSS uses `image-rendering: pixelated`.
- **No runtime dependencies**: Only VS Code API and Node built-ins at runtime. `canvas`, `esbuild` and `vitest` are dev-only.
- **Design rules** (from `PRODUCT.md`): inherit the VS Code theme and fonts (one UI face, one mono face); motion under 250ms, ease-out, honor `prefers-reduced-motion`; no loud gradients, glassmorphism or bouncy motion; never add polling or heavy work to the extension host.
- **Tests**: Vitest, `npm test`. `vitest.config.ts` aliases `vscode` to `test/__mocks__/vscode.ts`, so modules that import `vscode` can still be unit-tested. Pure logic (`tabMatch`, `dismissed`, `gitActivity`, `categorize`, project scoping, parsers) is unit-tested; `panel.ts` and the webview are not, so verify those by `npm run deploy` + reloading the window. The webview can be exercised standalone by serving `out/webview/` with a stub `acquireVsCodeApi`.
