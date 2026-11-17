// One run of the copier: read Kantata, plan, open the Workday timesheet, then either
// Load Timesheet or apply (add missing entries and Save each row). Never submits.

import { Driver, StopError, poll, sleep } from "./driver.js";
import { ktApiWeek } from "./page/kantata.js";
import {
  addDays,
  buildPlan,
  compareExisting,
  locationStrings,
  mondayOf,
  rowsForTarget,
  shortDay,
  timeOffRows,
  validateSettings,
  workdayHome,
  workdayTabPattern,
} from "./plan.js";
import type { EntryOutcome, Flag, GridScan, Report, Settings, Target } from "./types.js";
import { Workday } from "./wdflow.js";

export interface RunHooks {
  log: (msg: string) => void;
  update: (report: Report) => void;
  shouldStop: () => boolean;
}

async function findOrOpenTab(match: string, url: string, prefer?: (t: chrome.tabs.Tab) => boolean): Promise<number> {
  const tabs = await chrome.tabs.query({ url: match });
  const pick = (prefer && tabs.find(prefer)) || tabs[0];
  if (pick?.id !== undefined) return pick.id;
  const created = await chrome.tabs.create({ url, active: false });
  if (created.id === undefined) throw new Error("Couldn't open " + url);
  await poll(
    () => chrome.tabs.get(created.id!),
    (t) => t.status === "complete",
    { timeout: 60000, interval: 1000 },
  );
  await sleep(2000);
  return created.id;
}

export async function run(settings: Settings, mode: "preview" | "apply", hooks: RunHooks): Promise<Report> {
  const report: Report = { mode, startedAt: new Date().toISOString(), entries: [], flags: [], done: false };
  const flag = (level: Flag["level"], message: string) => {
    report.flags.push({ level, message });
    hooks.log((level === "info" ? "" : level.toUpperCase() + ": ") + message);
    hooks.update(report);
  };
  const log = hooks.log;

  let wd: Workday | null = null;
  try {
    const bad = validateSettings(settings);
    if (bad) throw new Error(bad);
    const monday = mondayOf(settings.week);
    const sunday = addDays(monday, 6);
    report.week = { monday, sunday, source: `week setting ${settings.week}` };
    log(`Week: ${shortDay(monday)} – ${shortDay(sunday)}.`);
    const location = locationStrings(settings.location);
    const kantataOrigin = settings.org.kantataUrl;

    // ---------------------------------------------------------------- Kantata
    log("Reading Kantata through its API…");
    let kt = await ktApiWeek(monday, kantataOrigin);
    if (!kt.ok && kt.error.startsWith("AUTH_OR_NETWORK")) {
      // Fallback: run the same read inside a Kantata tab. Edge stalls requests from
      // background tabs, so bring it to the front for the few seconds this takes.
      log(`Direct API call didn't work (${kt.error.replace("AUTH_OR_NETWORK: ", "")}); trying from a Kantata tab.`);
      const ktTab = await findOrOpenTab(kantataOrigin + "/*", kantataOrigin + "/timesheets");
      await chrome.tabs.update(ktTab, { active: true });
      await sleep(1500);
      kt = await new Driver(ktTab, hooks.shouldStop).run(ktApiWeek, monday, "");
    }
    if (!kt.ok) throw new Error("Kantata: " + kt.error.replace("AUTH_OR_NETWORK: ", "") + " Log in to Kantata in this browser and try again.");
    report.user = kt.user.name;
    log(`Kantata: ${kt.entryCount} entries, ${kt.totalHours}h for ${kt.user.name}.`);
    if (kt.entryCount === 0) flag("warn", "Kantata has no time for this week. Nothing to copy.");

    const plan = buildPlan(kt.rows, settings);
    report.kantataTotals = plan.totals;
    plan.flags.forEach((f) => flag(f.level, f.message));
    report.entries = plan.entries.map((e): EntryOutcome => ({ ...e, status: "unknown" }));
    hooks.update(report);

    // ---------------------------------------------------------------- Workday
    const wdTab = await findOrOpenTab(workdayTabPattern(settings.org), workdayHome(settings.org), (t) => /^Enter Time by Type/.test(t.title || ""));
    wd = new Workday(new Driver(wdTab, hooks.shouldStop), log, workdayHome(settings.org));
    const st = await wd.state();
    if (st.dialogs.length) throw new Error(`A Workday dialog is open (${st.dialogs.join(", ")}). Close it, then run again.`);
    await wd.ensureTimesheet(monday);
    log("Scanning the Workday timesheet…");
    await wd.ensureVisible();
    let scan: GridScan = await wd.scan();
    if (!scan.ok) throw new Error(scan.error);
    report.workdaySummaryBefore = scan.summary;
    hooks.update(report);

    // PTO in Kantata should match Holiday / Time Off in Workday (Workday fills those itself).
    const offRows = timeOffRows(scan);
    for (const p of plan.ptoDays) {
      const idx = (new Date(p.date + "T00:00:00Z").getUTCDay() + 6) % 7;
      const wdOff = offRows.reduce((s, r) => s + (r.values[idx] ?? 0), 0);
      if (wdOff <= 0) flag("warn", `Kantata has ${p.hours}h PTO on ${shortDay(p.date)} (${p.task}), but Workday shows no Holiday/Time Off that day.`);
      else log(`PTO ${shortDay(p.date)} ${p.hours}h matches Workday Holiday/Time Off ${wdOff}h.`);
    }

    // ---------------------------------------------------------------- per Workday row
    for (const target of plan.targets) {
      if (hooks.shouldStop()) throw new StopError();
      const mine = report.entries.filter((e) => e.target.key === target.key);
      const setAll = (status: EntryOutcome["status"], note?: string) => {
        for (const e of mine) if (e.status === "unknown" || e.status === "add") Object.assign(e, { status, note });
        hooks.update(report);
      };
      log(`— ${target.label}: ${mine.length} Kantata day entr${mine.length === 1 ? "y" : "ies"}.`);
      await wd.ensureVisible();

      let rows = rowsForTarget(scan, target);
      if (rows.length > 1) {
        flag("warn", `${target.label}: ${rows.length} matching Workday rows (different phases?). Skipped; copy it by hand.`);
        setAll("skipped", "Ambiguous Workday row");
        continue;
      }
      if (rows.length === 0) {
        if (mode === "preview") {
          log(`${target.label}: no row on the timesheet yet; it will be added through Expand Search.`);
          setAll("add", "Row will be added");
          continue;
        }
        const err = await wd.addRowViaSearch(target);
        if (err) {
          flag("error", `${target.label}: ${err}`);
          setAll("skipped", "Couldn't add the Workday row");
          continue;
        }
        rows = await wd.findRows(target, 30000);
        scan = await wd.scan();
        if (rows.length !== 1) {
          flag("error", `${target.label}: after adding, found ${rows.length} matching rows. Skipped.`);
          setAll("skipped", "Row not found after Add");
          continue;
        }
      }

      const dlg = await wd.openDetails(rows[0], target);
      for (const e of mine) {
        const existing = dlg.days.find((d) => d.day === e.dayLabel)?.entries ?? [];
        const c = compareExisting(existing, e);
        e.status = c.status;
        e.note = c.note;
        if (c.status === "differs") flag("warn", `${target.label} ${shortDay(e.date)}: ${c.note}`);
      }
      hooks.update(report);
      const toAdd = mine.filter((e) => e.status === "add");
      if (mode === "preview" || toAdd.length === 0) {
        if (!toAdd.length) log(`${target.label}: nothing to add.`);
        await wd.cancelDetails();
        continue;
      }

      try {
        for (const e of toAdd) {
          log(`${target.label}: adding ${shortDay(e.date)} ${e.hours}h.`);
          await wd.addEntry(e.dayLabel, e.hours, e.comment, location);
          e.status = "added";
          hooks.update(report);
        }
        // Final check of the whole sidebar before saving.
        const final = await wd.readDialogSettled();
        for (const e of toAdd) {
          const entries = final.days.find((d) => d.day === e.dayLabel)?.entries ?? [];
          if (compareExisting(entries, e).status !== "exists") throw new Error(`${shortDay(e.date)} entry didn't read back before Save.`);
        }
        const blanks = final.days.flatMap((d) => d.entries).filter((x) => x.comment.trim() === "" && (x.hours.trim() === "" || Number(x.hours) === 0));
        if (blanks.length) throw new Error(`${blanks.length} blank entr${blanks.length === 1 ? "y" : "ies"} in the sidebar before Save.`);
        log(`${target.label}: saving ${toAdd.length} entr${toAdd.length === 1 ? "y" : "ies"}.`);
        await wd.saveDetails();
        log(`${target.label}: saved.`);
      } catch (err) {
        if (err instanceof StopError) throw err;
        flag("error", `${target.label}: ${(err as Error).message} Unsaved changes for this row were discarded.`);
        for (const e of toAdd) if (e.status === "added" || e.status === "add") Object.assign(e, { status: "failed", note: (err as Error).message });
        hooks.update(report);
        try {
          await wd.cancelDetails();
        } catch (e2) {
          flag("error", "Couldn't close the Details sidebar: " + (e2 as Error).message + " Close it by hand (Cancel → Discard).");
          break;
        }
      }
      scan = await wd.scan();
    }

    // ---------------------------------------------------------------- verify
    if (mode === "apply") {
      log("Verifying totals…");
      await sleep(1000);
      await wd.ensureVisible();
      scan = await wd.scan();
      report.workdaySummaryAfter = scan.summary;
      verifyTotals(scan, plan.targets, report, flag);
    }
    report.done = true;
  } catch (err) {
    if (err instanceof StopError) report.aborted = err.message;
    else report.aborted = (err as Error).message || String(err);
    flag("error", "Stopped: " + report.aborted);
    if (wd) {
      try {
        await wd.cleanup();
      } catch {
        flag("warn", "A Workday panel may still be open. Close it with Cancel → Discard (that only discards unsaved changes).");
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    hooks.update(report);
  }
  return report;
}

function verifyTotals(scan: GridScan, targets: Target[], report: Report, flag: (l: Flag["level"], m: string) => void): void {
  const days = Array.from({ length: 7 }, (_, i) => addDays(report.week!.monday, i));
  for (const target of targets) {
    const rows = rowsForTarget(scan, target);
    const mine = report.entries.filter((e) => e.target.key === target.key);
    for (let i = 0; i < 7; i++) {
      const expected = mine.filter((e) => e.date === days[i]).reduce((s, e) => s + e.hours, 0);
      const actual = rows.reduce((s, r) => s + (r.values[i] ?? 0), 0);
      if (Math.abs(expected - actual) > 0.005)
        flag("warn", `${target.label} ${shortDay(days[i])}: Kantata ${round(expected)}h, Workday ${round(actual)}h.`);
    }
  }
  const t = report.kantataTotals!;
  const s = scan.summary;
  const cmp = (label: string, kt: number, wdKey: string) => {
    const w = s[wdKey];
    if (w === undefined) return;
    if (Math.abs(kt - w) > 0.005) flag("warn", `${label}: Kantata ${kt}h vs Workday ${w}h.`);
    else flag("info", `${label}: ${w}h in both.`);
  };
  cmp("Chargeable (client p-codes)", t.client, "Chargeable Project Hours");
  cmp("Non-chargeable (admin)", t.admin, "Non-Chargeable Project Hours");
  const off = (s["Time Off Hours"] ?? 0) + (s["Holiday Hours"] ?? 0);
  if (Math.abs(off - t.pto) > 0.005) flag("warn", `PTO: Kantata ${t.pto}h vs Workday Time Off + Holiday ${off}h.`);
  cmp("Total", t.total - t.other, "Total Hours");
}

const round = (n: number) => Math.round(n * 100) / 100;
