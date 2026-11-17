// Organization settings page (the extension's options page). Stores OrgSettings in
// chrome.storage.local; the copier page listens for changes. Nothing has a default.

import { ORG_KEY, normalizeKantataUrl, normalizeWorkdayTenant } from "./plan.js";
import type { OrgSettings } from "./types.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("org-form");
const kantataEl = $<HTMLInputElement>("kantata-url");
const tenantEl = $<HTMLInputElement>("workday-tenant");
const adminEl = $<HTMLInputElement>("admin-project");
const statusEl = $<HTMLParagraphElement>("save-status");

function setStatus(text: string, state: "done" | "error"): void {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

async function load(): Promise<void> {
  const org = ((await chrome.storage.local.get(ORG_KEY))[ORG_KEY] as Partial<OrgSettings> | undefined) ?? {};
  kantataEl.value = org.kantataUrl ?? "";
  tenantEl.value = org.workdayTenant ?? "";
  adminEl.value = org.adminProject ?? "";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const kantataUrl = normalizeKantataUrl(kantataEl.value);
  const workdayTenant = normalizeWorkdayTenant(tenantEl.value);
  const adminProject = adminEl.value.trim();
  const problems: string[] = [];
  if (!kantataUrl) problems.push(kantataEl.value.trim() ? "Kantata URL must be a https://<name>.mavenlink.com address." : "Enter the Kantata URL.");
  if (!workdayTenant)
    problems.push(tenantEl.value.trim() ? "Workday tenant must be the name after wd5.myworkday.com/ (letters, numbers, - and _)." : "Enter the Workday tenant.");
  if (!adminProject) problems.push("Enter the admin project.");
  if (problems.length || !kantataUrl || !workdayTenant) {
    setStatus(problems.join(" "), "error");
    return;
  }
  const org: OrgSettings = { kantataUrl, workdayTenant, adminProject };
  void chrome.storage.local.set({ [ORG_KEY]: org }).then(() => {
    // Show the normalized values that were saved.
    kantataEl.value = kantataUrl;
    tenantEl.value = workdayTenant;
    adminEl.value = adminProject;
    setStatus("Saved.", "done");
  });
});

// The copier opens this page in its own window; Back returns there.
$("back").addEventListener("click", () => location.assign("app.html"));

void load();
