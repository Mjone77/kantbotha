# Kantbotha

A Chromium/Edge and Firefox extension with quality-of-life improvements for Kantata
(Mavenlink), plus a timesheet copier that copies a week of Kantata time into Workday.

## Features

**On Kantata workspace pages** (all pages under `/workspaces/` except Gantt):

- Wider task tracker table and row hover highlight.
- Resizable side panel (drag its left edge).
- A **MODE: Normal / Public** toggle on the activity feed and side panel that hides private
  messages and submissions.

**Timesheet copier** (click the toolbar icon):

- Copies one week of your Kantata time into the Workday timesheet.
- Safety rules:
  - **It never submits anything.** It never clicks Submit or Update. The click code refuses
    any control labelled Submit, Update, Delete, Bookmark, Approve or Send Back.
  - **It only reads from Kantata.** It only sends GET requests to Kantata's API.
  - **In Workday, it only adds time.**
    - It adds rows through Expand Search, adds entries in each row's Details sidebar, and
      clicks Save.
    - It never edits or removes existing entries. If an entry for the same Kantata task is
      already there with different hours or a different comment, it's flagged and left
      alone.

## Install

Build it first (see below). The build makes `dist/chrome` (Chrome and Edge) and
`dist/firefox`.

**Edge or Chrome:**

1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick `dist/chrome`. From WSL, that's
   `\\wsl.localhost\<distro>\path\to\kantbotha\dist\chrome`.
   - If the browser won't load from a `\\wsl.localhost` path, export a copy to a Windows
     folder and load that instead:
     `tool/target/release/extool export /mnt/c/Users/<you>/kantbotha`
3. The Chrome build has a fixed extension ID, `baaajmclhilgdijakgpdifdcbjboiebn`. It comes
   from the key in `manifest_key.txt`, so the copier page is always
   `chrome-extension://baaajmclhilgdijakgpdifdcbjboiebn/timesheet/app.html`.
4. After rebuilding, click the reload icon on the extension's card.

**Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**,
and pick `dist/firefox/manifest.json`. Then allow its site permissions for Kantata and
Workday in `about:addons` → Kantbotha → Permissions.

**Store packages:** run `tool/target/release/extool package`. It writes
`releases/kantbotha-chrome-<version>.zip` (Chrome Web Store, Edge Add-ons) and
`releases/kantbotha-firefox-<version>.zip` (addons.mozilla.org). Before each release, bump
`version` in both manifests; they must match.

## Using the timesheet copier

1. Log in to Kantata and Workday in the same browser. Any page works; the copier opens
   Workday and goes to the timesheet itself.
2. Click the Kantbotha toolbar icon. The copier opens in its own small window.
3. The first time, click **Open Organization settings** (or **Organization settings** in
   the copier's top bar). The settings open in the copier's window, and **← Back to
   Timesheet Copier** returns to it. (They're also the extension's Options page.) Set:
   - **Kantata URL**: your `https://<name>.mavenlink.com` address.
   - **Workday tenant**: the name after `wd5.myworkday.com/` in your Workday address (you
     can paste the whole URL).
   - **Admin project**: the exact Workday project that Kantata "Admin Project" time goes to.

   Nothing has a default, and the copier won't run until all three are set. They're saved in
   this browser only.
4. Set the role, the location worktag, and the week (any date in it). Leave the location
   blank to keep Workday's default.
5. Click **Load Timesheet**. It reads Kantata and Workday and shows what it would add.
   To read Workday, it opens each row's Details sidebar and closes it with Cancel. Nothing
   is changed.
6. Click **Copy to Workday** to add the missing entries. Each Workday row is saved
   separately with that sidebar's Save. Then review and submit the timesheet in Workday
   yourself.

**Keep the browser window with Workday visible while it runs** (not minimized or
completely covered). Browsers pause rendering in hidden windows and background tabs, and
Workday then stops updating. The copier waits until the window is visible again, and says
so in its log.

The copier only supports Workday on `wd5.myworkday.com`, and the role names listed in
`timesheet/plan.ts`.

## Build

Requirements:

- Rust (cargo).
- The TypeScript compiler (`tsc`, v7 native build) on PATH.
- Run `npm install` in this folder once, for `@types/chrome`.

```sh
cargo build --release --manifest-path tool/Cargo.toml   # once
tool/target/release/extool build            # type-check, compile, assemble dist/chrome + dist/firefox
tool/target/release/extool build chrome     # just one browser
tool/target/release/extool check            # type-check only
```

| Command | What it does |
|---|---|
| `build [chrome\|firefox]` | Type-checks and compiles `timesheet/**/*.ts` with `tsc` (comments are stripped from the output); any type error fails the build. Copies `background/`, `content_scripts/`, `icons/` and `timesheet/` (except `.ts`). Writes `manifest-<browser>.json` as `manifest.json`, adding the key to the Chrome build. Checks that every file the manifest names exists. |
| `check` | Type-check only. |
| `id` | Print the Chrome/Edge extension ID and the copier URL. |
| `keygen` | Create `manifest_key.txt` (public key only). Only needed if you want a new ID. |
| `export <dir> [chrome\|firefox]` | Build, then copy `dist/<browser>` (default chrome) to `<dir>`, e.g. a Windows folder under `/mnt/c`. |
| `page-fn <module> <function> [json-args] --out <file>` | Write one copier page function as a standalone script, for testing it by pasting it into the browser's DevTools console. Example: `extool page-fn page/workday.js wdScanGrid --out scan.js`. |
| `package` | Build both browsers and write the store zips to `releases/kantbotha-<browser>-<version>.zip`. `manifest.json` is at the zip root, and the Chrome `key` is left out (the store assigns its own ID). Fails if the two manifest versions differ. |
| `clean` | Delete `dist/`. |

## Layout

| Path | Role |
|---|---|
| `manifest-chrome.json`, `manifest-firefox.json` | The manifests. They differ only in `background` (`service_worker` vs `scripts`). |
| `background/service_worker.js` | Background entry point. Imports `hide_private_messages.js` and the copier's `timesheet/background.js`. |
| `background/hide_private_messages.js` | Registers and unregisters the CSS that hides private messages. |
| `content_scripts/` | Kantata page tweaks: CSS, side panel resize, the private-message toggle. |
| `timesheet/app.html`, `app.css`, `app.ts` | The copier page: settings, Preview / Copy / Stop, report. The run happens in this page. |
| `timesheet/options.html`, `options.ts` | Organization settings (the extension's options page): Kantata URL, Workday tenant, admin project. |
| `timesheet/background.ts` | The toolbar icon opens the copier window. |
| `timesheet/runner.ts` | One run: Kantata → plan → Workday → verify → report. |
| `timesheet/plan.ts` | Pure logic: dates, row classification (client p-code / admin / PTO), matching, comments. |
| `timesheet/wdflow.ts` | Workday steps: go to the week, add rows, open Details, add entries, set the location, save. |
| `timesheet/page/kantata.ts` | Kantata API reader (GET only). Runs in the copier page; falls back to running inside a Kantata tab. |
| `timesheet/page/workday.ts` | Functions injected into the Workday tab. They read the page (grid, search panel, Details sidebar), and `wdAct` performs one interaction with synthetic DOM events. |
| `timesheet/driver.ts` | Runs page functions with `chrome.scripting` and provides polling helpers. |
| `tool/` | `extool`, the Rust build tool. |

The copier uses synthetic DOM events, with no `debugger` permission:

- Pointer and mouse events for clicks and hover.
- The native value setter plus `input`/`change` events for text fields.
- `KeyboardEvent`s for Delete and Enter.

All of these were tested against a Workday timesheet in Edge. The copier hasn't been
tested in Firefox.
