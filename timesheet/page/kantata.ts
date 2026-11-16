// Reads one Mon–Sun week of the logged-in user's Kantata time through Kantata's REST API.
// Read-only: only GET requests. Never reads cookies or headers; returns only timesheet data.
//
// Runs in two places, so it must be fully self-contained:
// - In the extension page with `origin` = the Kantata URL from Organization settings (the
//   normal path; the extension's host permission lets the browser send the Kantata session).
// - Injected into a Kantata tab with `origin` = "" (fallback). Edge stalls network requests
//   from background tabs, so that tab has to be the visible one while this runs.

import type { KtResult } from "../types.js";

export async function ktApiWeek(monday: string, origin = ""): Promise<KtResult> {
  interface Entry {
    id: string;
    user_id: string | number;
    date_performed: string;
    time_in_minutes: number;
    notes: string | null;
    workspace_id: string;
    story_id: string;
  }
  interface Page {
    count: number;
    results: { key: string; id: string }[];
    time_entries?: Record<string, Entry>;
    workspaces?: Record<string, { title: string }>;
    stories?: Record<string, { title: string }>;
  }
  try {
    if (!origin && !/\.mavenlink\.com$/.test(location.hostname)) {
      return { ok: false, error: "Not a Kantata tab (" + location.hostname + ")." };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return { ok: false, error: "Week must be YYYY-MM-DD." };
    const start = new Date(monday + "T00:00:00Z");
    if (isNaN(start.getTime()) || start.getUTCDay() !== 1) return { ok: false, error: monday + " is not a Monday." };
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) dates.push(iso(new Date(start.getTime() + i * 86400000)));
    const sunday = dates[6];
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    const get = async <T>(path: string): Promise<T> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      let r: Response;
      try {
        r = await fetch(origin + path, {
          method: "GET",
          credentials: origin ? "include" : "same-origin",
          redirect: "error", // a redirect means the session is gone (login page)
          headers: { Accept: "application/json" },
          signal: ctl.signal,
        });
      } catch (e) {
        throw new Error("AUTH_OR_NETWORK: GET " + path.split("?")[0] + " failed (" + String((e as Error)?.message || e) + ")");
      } finally {
        clearTimeout(timer);
      }
      if (r.status === 401 || r.status === 403) throw new Error("AUTH_OR_NETWORK: GET " + path.split("?")[0] + " returned HTTP " + r.status + " (not logged in?)");
      if (!r.ok) throw new Error("GET " + path.split("?")[0] + " returned HTTP " + r.status);
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("json")) throw new Error("AUTH_OR_NETWORK: GET " + path.split("?")[0] + " returned " + ct + ", not JSON (logged out?)");
      return (await r.json()) as T;
    };

    // Filter with with_user_ids, and verify below that every entry belongs to the current user.
    const me = await get<{ results?: { id: string }[]; users?: Record<string, { full_name: string }> }>("/api/v1/users/me");
    const userId = me.results && me.results[0] && me.results[0].id;
    const user = userId && me.users ? me.users[userId] : undefined;
    if (!userId || !user) return { ok: false, error: "Couldn't identify the logged-in Kantata user." };

    const entries: Entry[] = [];
    const workspaces: Record<string, { title: string }> = {};
    const stories: Record<string, { title: string }> = {};
    let count = -1;
    for (let page = 1; page <= 20; page++) {
      const d = await get<Page>(
        "/api/v1/time_entries?with_user_ids=" + userId + "&date_performed_between=" + monday + ":" + sunday +
          "&include=workspace,story&per_page=200&page=" + page,
      );
      if (!Array.isArray(d.results) || typeof d.count !== "number") return { ok: false, error: "Unexpected time_entries response." };
      count = d.count;
      Object.assign(workspaces, d.workspaces || {});
      Object.assign(stories, d.stories || {});
      for (const r of d.results) {
        const e = r.key === "time_entries" && d.time_entries ? d.time_entries[r.id] : undefined;
        if (e) entries.push(e);
      }
      if (entries.length >= count || d.results.length === 0) break;
    }
    if (entries.length !== count) return { ok: false, error: "Got " + entries.length + " entries but the API reported " + count + "." };

    const problems: string[] = [];
    for (const e of entries) {
      if (String(e.user_id) !== String(userId)) problems.push("entry " + e.id + " belongs to another user");
      if (!dates.includes(e.date_performed)) problems.push("entry " + e.id + " is dated " + e.date_performed);
      if (typeof e.time_in_minutes !== "number") problems.push("entry " + e.id + " has no time");
      if (!workspaces[e.workspace_id]) problems.push("entry " + e.id + ": project not included");
      if (!stories[e.story_id]) problems.push("entry " + e.id + ": task not included");
    }
    if (problems.length) return { ok: false, error: "Sanity check failed: " + problems.slice(0, 5).join("; ") };

    // Entry order = ascending id (matches Kantata's Edit Time Entry modal).
    entries.sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const clean = (s: string | null | undefined) => String(s || "").replace(/\s+/g, " ").trim();
    const hours = (min: number) => Math.round((min / 60) * 100) / 100;
    interface Acc {
      project: string;
      pcode: string | null;
      task: string;
      taskUrl: string;
      minutes: number;
      days: Record<string, { date: string; weekday: string; minutes: number; notes: string[] }>;
    }
    const byKey: Record<string, Acc> = {};
    for (const e of entries) {
      const key = e.workspace_id + "/" + e.story_id; // group by IDs, never by title
      let row = byKey[key];
      if (!row) {
        const project = clean(workspaces[e.workspace_id].title);
        const m = project.match(/\((P\d+)\)/);
        row = byKey[key] = {
          project,
          pcode: m ? m[1] : null,
          task: clean(stories[e.story_id].title),
          taskUrl: (origin || location.origin) + "/workspaces/" + e.workspace_id + "/#tracker/" + e.story_id,
          minutes: 0,
          days: {},
        };
      }
      let day = row.days[e.date_performed];
      if (!day) day = row.days[e.date_performed] = { date: e.date_performed, weekday: weekdays[dates.indexOf(e.date_performed)], minutes: 0, notes: [] };
      day.minutes += e.time_in_minutes;
      row.minutes += e.time_in_minutes;
      const note = clean(e.notes);
      if (note) day.notes.push(note);
    }

    const dayTotals: Record<string, number> = {};
    dates.forEach((dt, i) => (dayTotals[weekdays[i] + " " + dt] = 0));
    const rows = Object.values(byKey)
      .sort((a, b) => a.project.localeCompare(b.project) || a.task.localeCompare(b.task))
      .map((row) => ({
        project: row.project,
        pcode: row.pcode,
        task: row.task,
        taskUrl: row.taskUrl,
        totalHours: hours(row.minutes),
        days: Object.values(row.days)
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .map((d) => {
            dayTotals[d.weekday + " " + d.date] += d.minutes;
            return {
              date: d.date,
              weekday: d.weekday,
              hours: hours(d.minutes),
              notes: d.notes,
              comment: d.notes.length ? row.taskUrl + " - " + d.notes.join("; ") : row.taskUrl,
            };
          }),
      }));
    for (const k of Object.keys(dayTotals)) dayTotals[k] = hours(dayTotals[k]);

    return {
      ok: true,
      user: { id: String(userId), name: user.full_name },
      week: { monday, sunday },
      entryCount: entries.length,
      totalHours: hours(entries.reduce((s, e) => s + e.time_in_minutes, 0)),
      dayTotals,
      rows,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}
