// The extension's page (opened by clicking the toolbar icon). Holds the settings form,
// runs previews / copies, and renders the report. The run happens in this page, so keep
// the tab open until it finishes.

import { ORG_KEY, addDays, mondayOf, orgProblems, parseIso, shortDay, toIso } from "./plan.js";
import { run } from "./runner.js";
import type { OrgSettings, Report, Role, Settings } from "./types.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const roleEl = $<HTMLSelectElement>("role");
const locationEl = $<HTMLInputElement>("location");
const weekEl = $<HTMLInputElement>("week");
const weekLabel = $<HTMLSpanElement>("week-label");
const previewBtn = $<HTMLButtonElement>("preview");
const applyBtn = $<HTMLButtonElement>("apply");
const stopBtn = $<HTMLButtonElement>("stop");
const statusEl = $<HTMLParagraphElement>("status");
const logEl = $<HTMLPreElement>("log");
const orgBanner = $<HTMLDivElement>("org-banner");
const orgMissing = $<HTMLSpanElement>("org-missing");

const WEEK_KEY = "kantbotha.week";
let running = false;
let stopRequested = false;
/** Settings of the last successful preview; Copy is only enabled for the same settings. */
let previewedFor: string | null = null;
/** Organization settings from the options page (no defaults). */
let org: Partial<OrgSettings> = {};

function currentSettings(): Settings {
  return {
    role: roleEl.value as Role,
    location: locationEl.value.trim(),
    week: weekEl.value,
    org: { kantataUrl: org.kantataUrl ?? "", workdayTenant: org.workdayTenant ?? "", adminProject: org.adminProject ?? "" },
  };
}

async function loadOrg(): Promise<void> {
  org = ((await chrome.storage.local.get(ORG_KEY))[ORG_KEY] as Partial<OrgSettings> | undefined) ?? {};
}

async function loadSettings(): Promise<void> {
  const stored = (await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined;
  const today = toIso(new Date(Date.now() - new Date().getTimezoneOffset() * 60000));
  roleEl.value = stored?.role ?? "";
  locationEl.value = stored?.location ?? "";
  // The week starts on today's date (only role and location are remembered), except when
  // coming back from Organization settings in the same window.
  const kept = sessionStorage.getItem(WEEK_KEY);
  sessionStorage.removeItem(WEEK_KEY);
  weekEl.value = kept && parseIso(kept) ? kept : today;
}

function saveSettings(): void {
  const { role, location, week } = currentSettings();
  void chrome.storage.local.set({ settings: { role, location, week } });
  updateWeekLabel();
  syncButtons();
}

function updateWeekLabel(): void {
  const s = currentSettings();
  if (!parseIso(s.week)) {
    weekLabel.textContent = "";
    return;
  }
  const mon = mondayOf(s.week);
  weekLabel.textContent = `${shortDay(mon)} – ${shortDay(addDays(mon, 6))}`;
}

function syncButtons(): void {
  // Until Organization settings are complete, show the setup prompt and block runs.
  const missing = orgProblems(org);
  orgBanner.hidden = missing.length === 0;
  orgMissing.textContent = missing.join(", ");
  const orgReady = missing.length === 0;
  previewBtn.disabled = running || !orgReady;
  previewBtn.title = orgReady ? "" : "Finish Organization settings first";
  stopBtn.disabled = !running;
  // Leaving the page would end a run, so settings wait until it's finished.
  for (const id of ["open-options", "org-setup"]) {
    const b = $<HTMLButtonElement>(id);
    b.disabled = running;
    b.title = running ? "Available when the run finishes" : "";
  }
  const ok = orgReady && previewedFor !== null && previewedFor === JSON.stringify(currentSettings());
  applyBtn.disabled = running || !ok;
  applyBtn.title = ok ? "" : orgReady ? "Run a preview with these settings first" : "Finish Organization settings first";
}

function log(msg: string): void {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text: string, state: "idle" | "running" | "done" | "error"): void {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function render(r: Report): void {
  $("report-card").hidden = false;
  $("report-json").textContent = JSON.stringify(r);
  const t = r.kantataTotals;
  const before = r.workdaySummaryBefore;
  const after = r.workdaySummaryAfter;
  const counts: Record<string, number> = {};
  for (const e of r.entries) counts[e.status] = (counts[e.status] || 0) + 1;
  $("report-summary").innerHTML = [
    `<p><strong>${r.mode === "preview" ? "Preview" : "Copy"}</strong>${r.week ? ` for ${shortDay(r.week.monday)} – ${shortDay(r.week.sunday)}` : ""}${r.user ? ` · ${esc(r.user)}` : ""}${r.done ? " · finished" : r.aborted ? " · stopped" : " · running…"}. Nothing was submitted.</p>`,
    t
      ? `<p>Kantata: client ${t.client}h · admin ${t.admin}h · PTO ${t.pto}h${t.other ? ` · skipped ${t.other}h` : ""} · total ${t.total}h. By code: ${Object.entries(t.byCode)
          .map(([k, v]) => `${esc(k)} ${v}h`)
          .join(", ")}</p>`
      : "",
    before ? `<p>Workday before: ${Object.entries(before).map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}</p>` : "",
    after ? `<p>Workday after: ${Object.entries(after).map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}</p>` : "",
    `<p>Entries: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}</p>`,
  ].join("");
  $("flags").innerHTML = r.flags.length ? r.flags.map((f) => `<li class="${f.level}">${esc(f.message)}</li>`).join("") : "<li>None.</li>";
  $("entries").querySelector("tbody")!.innerHTML = r.entries
    .map(
      (e) =>
        `<tr><td>${shortDay(e.date)}</td><td>${esc(e.target.label)}</td><td>${e.hours}</td><td class="st-${e.status}">${e.status}${e.note ? `<br><small>${esc(e.note)}</small>` : ""}</td><td class="comment">${esc(e.comment)}</td></tr>`,
    )
    .join("");
}

async function start(mode: "preview" | "apply"): Promise<void> {
  if (running) return;
  const settings = currentSettings();
  if (mode === "apply" && previewedFor !== JSON.stringify(settings)) return;
  running = true;
  stopRequested = false;
  syncButtons();
  logEl.textContent = "";
  setStatus(mode === "preview" ? "Previewing (read-only)…" : "Copying to Workday… keep this tab open.", "running");
  const report = await run(settings, mode, { log, update: render, shouldStop: () => stopRequested });
  running = false;
  if (report.done) {
    if (mode === "preview") previewedFor = JSON.stringify(settings);
    const adds = report.entries.filter((e) => e.status === (mode === "preview" ? "add" : "added")).length;
    const problems = report.flags.filter((f) => f.level !== "info").length;
    setStatus(
      mode === "preview"
        ? `Preview done: ${adds} entr${adds === 1 ? "y" : "ies"} to add${problems ? `, ${problems} flag(s)` : ""}. Nothing was changed.`
        : `Done: ${adds} entr${adds === 1 ? "y" : "ies"} added${problems ? `, ${problems} flag(s)` : ""}. Nothing was submitted.`,
      problems ? "error" : "done",
    );
  } else {
    setStatus("Stopped: " + (report.aborted || "unknown error"), "error");
  }
  syncButtons();
}

roleEl.addEventListener("change", saveSettings);
locationEl.addEventListener("input", saveSettings);
weekEl.addEventListener("change", saveSettings);
previewBtn.addEventListener("click", () => void start("preview"));
applyBtn.addEventListener("click", () => void start("apply"));
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  setStatus("Stopping after the current step…", "running");
});
window.addEventListener("beforeunload", (e) => {
  if (running) e.preventDefault();
});
// Organization settings open in this window; its Back button returns here. Keep the chosen
// week for this window's session so it survives the round trip.
for (const id of ["open-options", "org-setup"])
  $(id).addEventListener("click", () => {
    if (running) return;
    sessionStorage.setItem(WEEK_KEY, weekEl.value);
    location.assign("options.html");
  });
// Pick up Organization settings as soon as they're saved on the options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(ORG_KEY in changes)) return;
  org = (changes[ORG_KEY].newValue as Partial<OrgSettings> | undefined) ?? {};
  syncButtons();
});

void Promise.all([loadOrg(), loadSettings()]).then(() => {
  updateWeekLabel();
  syncButtons();
});
