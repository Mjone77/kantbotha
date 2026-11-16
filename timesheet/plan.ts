// Pure planning logic: dates, Kantata row classification, Workday row matching, and the
// list of entries to copy. No browser APIs here.

import type { DialogEntry, Flag, GridRow, GridScan, KtRow, OrgSettings, PlannedEntry, Role, SearchRow, Settings, Target } from "./types.js";

export const ROLES: Role[] = ["Director", "Project Lead", "Project Manager", "Engineer", "QA Analyst"];

// ------------------------------------------------------------------ organization settings

/** chrome.storage.local key for OrgSettings. */
export const ORG_KEY = "org";
/** Workday host; must match the extension's host permission. */
export const WORKDAY_HOST = "wd5.myworkday.com";

/** "acme.mavenlink.com", "https://acme.mavenlink.com/timesheets", … → "https://acme.mavenlink.com"; null if not a Kantata address. */
export function normalizeKantataUrl(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  if (!/^[a-z]+:\/\//i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    if (!/^[a-z0-9-]+\.mavenlink\.com$/i.test(u.hostname)) return null;
    return "https://" + u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** "acme" or a pasted Workday URL ("https://wd5.myworkday.com/acme/d/home.htmld") → "acme"; null if invalid. */
export function normalizeWorkdayTenant(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  if (/myworkday\.com/i.test(v)) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : "https://" + v);
      if (u.hostname.toLowerCase() !== WORKDAY_HOST) return null;
      v = u.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
}

/** What's missing or invalid in the organization settings (empty = ready). */
export function orgProblems(org: Partial<OrgSettings> | undefined): string[] {
  const p: string[] = [];
  if (!org?.kantataUrl || !normalizeKantataUrl(org.kantataUrl)) p.push("Kantata URL");
  if (!org?.workdayTenant || !normalizeWorkdayTenant(org.workdayTenant)) p.push("Workday tenant");
  if (!org?.adminProject?.trim()) p.push("Admin project");
  return p;
}

export function workdayHome(org: OrgSettings): string {
  return `https://${WORKDAY_HOST}/${org.workdayTenant}/d/home.htmld`;
}

/** URL match pattern for the tenant's Workday tabs. */
export function workdayTabPattern(org: OrgSettings): string {
  return `https://${WORKDAY_HOST}/${org.workdayTenant}/*`;
}

// ------------------------------------------------------------------ dates (all UTC, ISO YYYY-MM-DD)

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseIso(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + "T00:00:00Z");
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : d;
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = parseIso(iso);
  if (!d) throw new Error("Bad date " + iso);
  return toIso(new Date(d.getTime() + n * 86400000));
}

/** Monday of the Mon–Sun week that contains `iso`. */
export function mondayOf(iso: string): string {
  const d = parseIso(iso);
  if (!d) throw new Error("Bad date " + iso);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(iso, -back);
}

/** Workday sidebar day heading, e.g. "Saturday, November 14, 2026". */
export function dayLabel(iso: string): string {
  const d = parseIso(iso);
  if (!d) throw new Error("Bad date " + iso);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function shortDay(iso: string): string {
  const d = parseIso(iso);
  return d ? `${DAYS[d.getUTCDay()].slice(0, 3)} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}` : iso;
}

/**
 * Monday of a Workday timesheet header such as "Nov 9 – 15, 2026",
 * "Nov 30 – Dec 6, 2026", or "Dec 28, 2026 – Jan 3, 2027".
 */
export function parseHeader(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(/^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))? [–-] (?:([A-Z][a-z]{2}) )?(\d{1,2}), (\d{4})$/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.startsWith(m[1]));
  if (mon < 0) return null;
  let year = m[3] ? Number(m[3]) : Number(m[6]);
  const endMon = m[4] ? MONTHS.findIndex((x) => x.startsWith(m[4])) : mon;
  if (!m[3] && endMon < mon) year -= 1; // "Dec 29 – Jan 4, 2027" without a start year
  const iso = `${year}-${String(mon + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  return parseIso(iso) ? iso : null;
}

export function weeksBetween(fromMonday: string, toMonday: string): number {
  const a = parseIso(fromMonday);
  const b = parseIso(toMonday);
  if (!a || !b) throw new Error("Bad week");
  return Math.round((b.getTime() - a.getTime()) / (7 * 86400000));
}

// ------------------------------------------------------------------ settings

export function locationStrings(location: string): { match: string; search: string } | null {
  const v = location.trim().replace(/^["']|["']$/g, "").trim();
  if (!v || /^default$/i.test(v)) return null;
  const match = /^Location:\s*/i.test(v) ? "Location: " + v.replace(/^Location:\s*/i, "") : "Location: " + v;
  return { match, search: match.replace(/^Location: /, "") };
}

export function validateSettings(s: Settings): string | null {
  const missing = orgProblems(s.org);
  if (missing.length) return `Set the ${missing.join(", ")} in Organization settings.`;
  if (!ROLES.includes(s.role)) return "Pick a role.";
  if (!parseIso(s.week)) return "Pick a week (any date in it).";
  return null;
}

// ------------------------------------------------------------------ Kantata → plan

export type RowKind = "client" | "admin" | "pto" | "unknown";

export function classify(row: KtRow): RowKind {
  if (row.pcode) return "client";
  if (/admin project/i.test(row.project)) return "admin";
  if (/\bPTO\b|time off|holiday|vacation|\bleave\b/i.test(row.project + " " + row.task)) return "pto";
  return "unknown";
}

export function targetFor(row: KtRow, role: Role, adminProject: string): Target | null {
  const kind = classify(row);
  if (kind === "client" && row.pcode)
    return { key: "client:" + row.pcode, kind: "client", code: row.pcode, task: role, label: `${row.pcode} > ${role}` };
  if (kind === "admin") return { key: "admin", kind: "admin", code: adminProject, task: "General", label: `${adminProject} > General > General` };
  return null;
}

export interface Plan {
  targets: Target[];
  entries: PlannedEntry[];
  flags: Flag[];
  ptoDays: { date: string; hours: number; task: string }[];
  totals: { client: number; admin: number; pto: number; other: number; total: number; byCode: Record<string, number> };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildPlan(rows: KtRow[], settings: Settings): Plan {
  const targets: Target[] = [];
  const entries: PlannedEntry[] = [];
  const flags: Flag[] = [];
  const ptoDays: Plan["ptoDays"] = [];
  const totals: Plan["totals"] = { client: 0, admin: 0, pto: 0, other: 0, total: 0, byCode: {} };

  for (const row of rows) {
    const kind = classify(row);
    totals.total += row.totalHours;
    if (kind === "pto") {
      totals.pto += row.totalHours;
      for (const d of row.days) ptoDays.push({ date: d.date, hours: d.hours, task: row.task });
      continue;
    }
    if (kind === "unknown") {
      totals.other += row.totalHours;
      flags.push({ level: "warn", message: `Skipped "${row.project}" / "${row.task}" (${row.totalHours}h): no p-code and not the admin or PTO project.` });
      continue;
    }
    const target = targetFor(row, settings.role, settings.org.adminProject.trim())!;
    if (!targets.some((t) => t.key === target.key)) targets.push(target);
    if (kind === "client") totals.client += row.totalHours;
    else totals.admin += row.totalHours;
    totals.byCode[target.code] = round2((totals.byCode[target.code] || 0) + row.totalHours);
    for (const d of row.days) {
      if (d.hours <= 0) continue;
      entries.push({
        target,
        date: d.date,
        dayLabel: dayLabel(d.date),
        hours: d.hours,
        comment: d.comment,
        taskUrl: row.taskUrl,
        ktProject: row.project,
        ktTask: row.task,
      });
    }
  }
  for (const k of ["client", "admin", "pto", "other", "total"] as const) totals[k] = round2(totals[k]);
  // Mon → Sun within each target, targets in Kantata order.
  entries.sort((a, b) => targets.indexOf(a.target) - targets.indexOf(b.target) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { targets, entries, flags, ptoDays, totals };
}

// ------------------------------------------------------------------ Workday matching

function projectMatches(projectName: string, target: Target): boolean {
  if (target.kind === "admin") return projectName === target.code; // code = admin project name
  return projectName === target.code || projectName.startsWith(target.code + " ");
}

export interface LeafRow extends GridRow {
  project: string | null;
  phase: string | null;
}

/** Adds the Project/Phase context to each leaf row of the grid. */
export function leafRows(scan: GridScan): LeafRow[] {
  const out: LeafRow[] = [];
  let project: string | null = null;
  let phase: string | null = null;
  for (const r of scan.rows) {
    if (r.label.startsWith("Customer: ")) {
      project = null;
      phase = null;
    } else if (r.label.startsWith("Project: ")) {
      project = r.label.slice("Project: ".length);
      phase = null;
    } else if (r.label.startsWith("Phase: ")) {
      phase = r.label.slice("Phase: ".length);
    } else if (r.label !== "Total Hours") {
      out.push({ ...r, project, phase });
    }
  }
  return out;
}

export function rowsForTarget(scan: GridScan, target: Target): LeafRow[] {
  return leafRows(scan).filter(
    (r) => r.project !== null && projectMatches(r.project, target) && r.label === target.task && (target.kind !== "admin" || r.phase === "General"),
  );
}

/** Rows that aren't under any project (Holiday, Time Off, …). */
export function timeOffRows(scan: GridScan): LeafRow[] {
  return leafRows(scan).filter((r) => r.project === null);
}

export function searchMatches(rows: SearchRow[], target: Target): SearchRow[] {
  return rows.filter((r) => projectMatches(r.project, target) && r.task === target.task && (target.kind !== "admin" || r.phase === "General"));
}

export function hoursEqual(a: string | number, b: number): boolean {
  const n = typeof a === "number" ? a : Number(String(a).trim());
  return Number.isFinite(n) && Math.abs(n - b) < 0.005;
}

export function formatHours(h: number): string {
  return String(round2(h));
}

/** How an existing sidebar entry relates to a planned entry. */
export function compareExisting(existing: DialogEntry[], planned: PlannedEntry): { status: "exists" | "differs" | "add"; note?: string } {
  const sameTask = existing.filter((e) => e.comment === planned.taskUrl || e.comment.startsWith(planned.taskUrl + " "));
  if (sameTask.some((e) => e.comment === planned.comment && hoursEqual(e.hours, planned.hours))) return { status: "exists" };
  if (sameTask.length) {
    const e = sameTask[0];
    return { status: "differs", note: `Workday already has ${e.hours}h for this Kantata task with comment "${e.comment}". Left unchanged.` };
  }
  return { status: "add" };
}

export function isBlank(e: DialogEntry): boolean {
  return (e.hours.trim() === "" || hoursEqual(e.hours, 0)) && e.comment.trim() === "";
}
