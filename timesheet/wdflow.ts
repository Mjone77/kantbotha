// Workday steps built from the page functions in page/workday.ts: open the timesheet for
// the week, find or add the row, open the Details sidebar, add entries (Hours, Comment,
// Location worktag), verify, Save.
// Never clicks Submit or Update (wdAct refuses them as a second line of defence).

import { Driver, poll, sleep } from "./driver.js";
import { wdAct, wdReadDialog, wdReadSearch, wdScanGrid, wdState, wdWorktagResults } from "./page/workday.js";
import { formatHours, hoursEqual, isBlank, parseHeader, rowsForTarget, searchMatches, weeksBetween, type LeafRow } from "./plan.js";
import type { Action, DialogEntry, DialogRead, GridScan, MarkSpec, SearchRead, Target, WdState } from "./types.js";

export type Log = (msg: string) => void;

export class Workday {
  /**
   * The panel that was clicked open but hasn't been seen open yet. A panel can take a few
   * seconds to appear, so cleanup after a stop in that gap has to wait for it.
   */
  private opening: "details" | "search" | null = null;

  constructor(
    private readonly d: Driver,
    private readonly log: Log,
    /** The tenant's Workday home page URL (from Organization settings). */
    private readonly home: string,
  ) {}

  // -------------------------------------------------------------- primitives

  state(): Promise<WdState> {
    return this.d.run(wdState);
  }

  scan(): Promise<GridScan> {
    return this.d.run(wdScanGrid);
  }

  readDialog(): Promise<DialogRead> {
    return this.d.run(wdReadDialog);
  }

  readSearch(): Promise<SearchRead> {
    return this.d.run(wdReadSearch);
  }

  private async act(spec: MarkSpec, action: Action, what: string): Promise<void> {
    const r = await this.d.run(wdAct, spec, action);
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
  }

  private click(spec: MarkSpec, what: string) {
    return this.act(spec, { type: "click" }, what);
  }

  private async exists(spec: MarkSpec): Promise<boolean> {
    const r = await this.d.run(wdAct, spec, { type: "locate" });
    return r.ok;
  }

  /** Reads the sidebar until two reads ~0.6 s apart agree (Workday re-renders after each action). */
  async readDialogSettled(timeout = 7000): Promise<DialogRead> {
    let prev = JSON.stringify(await this.readDialog());
    const start = Date.now();
    for (;;) {
      await sleep(600);
      const cur = await this.readDialog();
      const s = JSON.stringify(cur);
      if (s === prev || Date.now() - start > timeout) return cur;
      prev = s;
    }
  }

  // -------------------------------------------------------------- visibility

  /**
   * Makes the Workday tab the active tab in its window and waits until the page is
   * actually visible. Browsers pause rendering in hidden tabs (minimized or covered
   * window, background tab), and Workday's grid and sidebar don't update then.
   */
  async ensureVisible(): Promise<void> {
    if ((await this.state()).visible) return;
    const tab = await chrome.tabs.update(this.d.tabId, { active: true });
    if ((await poll(() => this.state(), (s) => s.visible, { timeout: 1500, interval: 300 })).ok) return;
    if (tab?.windowId !== undefined) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        if (win.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
        // Bring it in front of other windows (e.g. the copier popup covering a smaller window).
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        // Ignore; we wait below.
      }
      if ((await poll(() => this.state(), (s) => s.visible, { timeout: 2000, interval: 300 })).ok) return;
    }
    this.log("Waiting for the Workday window to be visible. Bring the browser window with Workday to the front (not minimized or covered).");
    const r = await poll(() => this.state(), (s) => s.visible, { timeout: 10 * 60000, interval: 1000, check: () => this.d.checkStop() });
    if (!r.ok) throw new Error("The Workday tab stayed hidden for 10 minutes.");
    this.log("Workday is visible again; continuing.");
    await sleep(500);
  }

  // -------------------------------------------------------------- navigation

  /** Gets the Workday tab onto the timesheet for the week starting `monday`. */
  async ensureTimesheet(monday: string): Promise<void> {
    for (let step = 0; step < 60; step++) {
      this.d.checkStop();
      await this.ensureVisible();
      const st = await this.state();
      if (st.page === "timesheet") {
        const shown = parseHeader(st.header);
        if (!shown) throw new Error(`Can't read the timesheet week from "${st.header}".`);
        const diff = weeksBetween(shown, monday);
        if (diff === 0) return;
        if (Math.abs(diff) > 52) throw new Error(`The target week is ${diff} weeks away from the one shown; open it in Workday first.`);
        this.log(`Timesheet shows ${st.header}; moving ${Math.abs(diff)} week(s) ${diff < 0 ? "back" : "forward"}.`);
        await this.click({ kind: "ariaButton", aria: diff < 0 ? "Previous Week" : "Next Week" }, "Change week");
        const r = await poll(() => this.state(), (s) => s.page === "timesheet" && s.header !== st.header, { timeout: 20000, interval: 400 });
        if (!r.ok) throw new Error("The timesheet week didn't change.");
        await sleep(800);
        continue;
      }
      if (st.page === "hub") {
        this.log("On the Time hub; opening This Week.");
        await this.click({ kind: "hubThisWeek" }, "Open This Week");
        await poll(() => this.state(), (s) => s.page === "timesheet", { timeout: 30000, interval: 500 });
        await sleep(800);
        continue;
      }
      if (st.page === "home") {
        this.log("On Workday home; opening Personal > Time.");
        await this.act({ kind: "navPersonal" }, { type: "hover" }, "Hover Personal");
        let found = await poll(() => this.exists({ kind: "navTime" }), (v) => v, { timeout: 4000, interval: 300 });
        if (!found.ok) {
          await this.click({ kind: "navPersonal" }, "Open Personal");
          found = await poll(() => this.exists({ kind: "navTime" }), (v) => v, { timeout: 6000, interval: 300 });
        }
        if (!found.ok) throw new Error("The Personal menu didn't show a Time link.");
        await this.click({ kind: "navTime" }, "Open Time");
        await poll(() => this.state(), (s) => s.page === "hub" || s.page === "timesheet", { timeout: 30000, interval: 500 });
        continue;
      }
      if (st.page === "loading") {
        await sleep(1000);
        continue;
      }
      this.log("Opening Workday home.");
      await chrome.tabs.update(this.d.tabId, { url: this.home });
      await sleep(3000);
      await poll(() => this.state(), (s) => s.page !== "loading" && s.page !== "other", { timeout: 45000, interval: 1000 });
    }
    throw new Error("Couldn't reach the Workday timesheet.");
  }

  // -------------------------------------------------------------- rows

  /** Adds the Workday row for `target` through Expand Search. Returns an error message or null. */
  async addRowViaSearch(target: Target): Promise<string | null> {
    const keyword = target.code; // p-code, or the admin project name
    this.log(`Adding the Workday row for ${target.label} (Expand Search "${keyword}").`);
    this.opening = "search";
    await this.click({ kind: "pageButton", text: "Expand Search" }, "Expand Search");
    const opened = await poll(() => this.readSearch(), (s) => s.open, { timeout: 20000, interval: 500 });
    if (!opened.ok) return "The Search across projects panel didn't open.";
    this.opening = null;
    await poll(() => this.exists({ kind: "searchKeywords" }), (v) => v, { timeout: 10000, interval: 400 });
    await this.act({ kind: "searchKeywords" }, { type: "fill", value: keyword }, "Fill Keywords");
    await this.click({ kind: "searchButton" }, "Search");

    // Right after Search, the old unfiltered list is still shown. Wait for a filtered list
    // (every row contains the keyword) that stays the same for two reads.
    let last = "";
    const filtered = await poll(
      () => this.readSearch(),
      (s) => {
        const sig = JSON.stringify(s.rows.map((r) => [r.project, r.phase, r.task]));
        const stable = s.allMatch === true && sig === last;
        last = sig;
        return stable;
      },
      { timeout: 20000, interval: 700 },
    );
    if (!filtered.ok) {
      await this.closeSearch();
      return `Search results for "${keyword}" didn't settle (${filtered.value.rows.length} rows, allMatch=${filtered.value.allMatch}).`;
    }
    const matches = searchMatches(filtered.value.rows, target);
    if (matches.length !== 1) {
      await this.closeSearch();
      const seen = filtered.value.rows.map((r) => `${r.project} > ${r.phase} > ${r.task}`).join("; ");
      return `${matches.length === 0 ? "No" : matches.length} matching search row(s) for ${target.label}. Results: ${seen || "(none)"}`;
    }
    const m = matches[0];
    await this.click({ kind: "searchCheckbox", project: m.project, phase: m.phase, task: m.task }, "Select search row");
    const checked = await poll(
      () => this.readSearch(),
      (s) => s.rows.filter((r) => r.checked).length === 1 && s.rows.some((r) => r.checked && r.project === m.project && r.phase === m.phase && r.task === m.task),
      { timeout: 8000, interval: 400 },
    );
    if (!checked.ok) {
      await this.closeSearch();
      return "Couldn't select exactly the intended search row.";
    }
    this.log(`Selected ${m.project} > ${m.phase} > ${m.task}; clicking Add.`);
    await this.click({ kind: "searchAdd" }, "Add selected row");
    const closed = await poll(() => this.readSearch(), (s) => !s.open, { timeout: 45000, interval: 800 });
    if (!closed.ok) return "The search panel didn't close after Add.";
    await sleep(1500);
    return null;
  }

  async closeSearch(): Promise<void> {
    if (!(await this.readSearch()).open) return;
    await this.click({ kind: "searchClose" }, "Close search panel");
    await sleep(1000);
    if ((await this.state()).discardPrompt) await this.click({ kind: "discard" }, "Discard search");
    await poll(() => this.readSearch(), (s) => !s.open, { timeout: 10000, interval: 500 });
  }

  /** Finds the target's row, scanning again until it shows up (after an Add). */
  async findRows(target: Target, timeout = 0): Promise<LeafRow[]> {
    const r = await poll(
      async () => rowsForTarget(await this.scan(), target),
      (rows) => rows.length > 0,
      { timeout, interval: 1500 },
    );
    return r.value;
  }

  // -------------------------------------------------------------- details sidebar

  async openDetails(row: LeafRow, target: Target): Promise<DialogRead> {
    this.opening = "details";
    await this.click({ kind: "pencil", rowIndex: row.rowIndex }, `Open details for ${target.label}`);
    const r = await poll(() => this.readDialog(), (d) => d.open && d.days.length > 0, { timeout: 20000, interval: 500 });
    if (!r.ok) throw new Error(`The Details sidebar for ${target.label} didn't open.`);
    this.opening = null;
    const dlg = await this.readDialogSettled();
    // Time Type reads "<project> > <phase> > <task>"; the p-code (or admin project) must be in it.
    if (!dlg.timeType.includes(target.code)) {
      await this.cancelDetails();
      throw new Error(`The Details sidebar shows "${dlg.timeType}", not ${target.label}.`);
    }
    return dlg;
  }

  /**
   * After a stop or error: closes the search panel and the Details sidebar (discarding only
   * unsaved changes), including one that was clicked open just before and is still loading.
   * Runs even though Stop was pressed.
   */
  async cleanup(): Promise<void> {
    this.d.beginCleanup();
    const opening = this.opening;
    this.opening = null;
    if (opening === "search") await poll(() => this.readSearch(), (s) => s.open, { timeout: 20000, interval: 500 });
    if (opening === "details") await poll(() => this.readDialog(), (d) => d.open && d.days.length > 0, { timeout: 20000, interval: 500 });
    if ((await this.readSearch()).open) await this.closeSearch();
    if ((await this.readDialog()).open) {
      // Cancel only works once the sidebar has finished loading.
      await poll(() => this.readDialog(), (d) => !d.open || d.days.length > 0, { timeout: 20000, interval: 500 });
      await this.cancelDetails();
    }
  }

  /** Closes the sidebar without saving (discarding only unsaved changes made in it). */
  async cancelDetails(): Promise<void> {
    if (!(await this.readDialog()).open) return;
    await this.click({ kind: "detailsCancel" }, "Cancel details");
    await sleep(1000);
    if ((await this.state()).discardPrompt) await this.click({ kind: "discard" }, "Discard details");
    const r = await poll(() => this.readDialog(), (d) => !d.open, { timeout: 15000, interval: 500 });
    if (!r.ok) throw new Error("The Details sidebar didn't close.");
  }

  private entryOf(d: DialogRead, day: string, index: number): DialogEntry | undefined {
    return d.days.find((x) => x.day === day)?.entries[index];
  }

  private countOn(d: DialogRead, day: string): number {
    return d.days.find((x) => x.day === day)?.entries.length ?? 0;
  }

  /**
   * Adds one entry on `day` and fills it. Returns the new entry's index on that day.
   * Clicks the day's Add exactly once (a second click would create a duplicate).
   */
  async addEntry(day: string, hours: number, comment: string, location: { match: string; search: string } | null): Promise<number> {
    const before = this.countOn(await this.readDialogSettled(), day);
    await this.click({ kind: "dayAdd", day }, `Add on ${day}`);
    const added = await poll(() => this.readDialog(), (d) => this.countOn(d, day) === before + 1, { timeout: 12000, interval: 400 });
    if (!added.ok) throw new Error(`Clicking Add on ${day} didn't create an entry.`);
    const index = before;
    const fresh = this.entryOf(await this.readDialogSettled(), day, index);
    if (!fresh || !isBlank(fresh)) throw new Error(`The new entry on ${day} isn't blank (${JSON.stringify(fresh)}).`);

    const at = (field: "hours" | "comment" | "worktagInput" | "worktagOption" | "remove", option?: number): MarkSpec => ({ kind: "entry", day, index, field, option });

    await this.act(at("hours"), { type: "fill", value: formatHours(hours) }, "Fill Hours");
    await this.act(at("hours"), { type: "blur" }, "Leave Hours");
    await sleep(500);
    await this.act(at("comment"), { type: "fill", value: comment }, "Fill Comment");
    await this.act(at("comment"), { type: "blur" }, "Leave Comment");
    await sleep(500);

    if (location) await this.setLocation(day, index, location);

    const check = await poll(
      async () => this.entryOf(await this.readDialog(), day, index),
      (e) => !!e && hoursEqual(e.hours, hours) && e.comment === comment && (!location || (e.worktags.length === 1 && e.worktags[0] === location.match)),
      { timeout: 8000, interval: 500 },
    );
    if (!check.ok) throw new Error(`The new entry on ${day} doesn't read back correctly: ${JSON.stringify(check.value)}`);
    return index;
  }

  private async setLocation(day: string, index: number, location: { match: string; search: string }): Promise<void> {
    const at = (field: "worktagInput" | "worktagOption", option?: number): MarkSpec => ({ kind: "entry", day, index, field, option });
    const tags = async () => this.entryOf(await this.readDialog(), day, index)?.worktags ?? [];
    let current = await tags();
    if (current.length === 1 && current[0] === location.match) return;

    // Remove the pre-filled worktag(s): select the chip, press Delete.
    for (let i = 0; i < 5 && current.length > 0; i++) {
      await this.click(at("worktagOption", 0), "Select pre-filled worktag");
      await this.act(at("worktagOption", 0), { type: "key", key: "Delete" }, "Delete pre-filled worktag");
      const n = current.length;
      const r = await poll(tags, (t) => t.length < n, { timeout: 5000, interval: 300 });
      if (!r.ok) throw new Error(`Couldn't remove the worktag "${current[0]}".`);
      current = r.value;
    }

    // Type the location and press Enter: Workday searches and auto-selects a single match.
    await this.click(at("worktagInput"), "Focus Worktags");
    await this.act(at("worktagInput"), { type: "fill", value: location.search }, "Type location");
    await sleep(1500);
    await this.act(at("worktagInput"), { type: "key", key: "Enter" }, "Search location");
    let done = await poll(tags, (t) => t.length > 0, { timeout: 10000, interval: 400 });
    if (!done.ok) {
      // Several matches: pick the exact one from the result list, if it's there.
      const res = await this.d.run(wdWorktagResults);
      if (res.options.includes(location.match)) await this.click({ kind: "worktagResult", text: location.match }, "Pick location");
      done = await poll(tags, (t) => t.length > 0, { timeout: 6000, interval: 400 });
    }
    // The "Search Results" list stays open and would swallow the next click. Close it by
    // clicking the blank sidebar header (not a control, not a day heading).
    await this.click({ kind: "detailsBlank" }, "Close worktag list");
    await sleep(500);
    done = await poll(tags, (t) => t.length === 1 && t[0] === location.match, { timeout: 6000, interval: 400 });
    if (!done.ok) throw new Error(`Location worktag is ${JSON.stringify(done.value)}, expected "${location.match}".`);
  }

  /** Removes an entry this run added but hasn't saved (only used to clean up a failed add). */
  async removeUnsavedEntry(day: string, index: number): Promise<void> {
    await this.click({ kind: "entry", day, index, field: "remove" }, "Remove unsaved entry");
    await sleep(800);
  }

  async saveDetails(): Promise<void> {
    await this.click({ kind: "detailsSave" }, "Save details");
    const r = await poll(() => this.readDialog(), (d) => !d.open || d.errors.length > 0, { timeout: 45000, interval: 700 });
    if (!r.ok) throw new Error("Save didn't finish (the sidebar is still open).");
    if (r.value.open) throw new Error("Workday rejected the save: " + r.value.errors.join(" | "));
  }
}
