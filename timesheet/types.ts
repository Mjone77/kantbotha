// Shared types. Type-only: nothing here exists at runtime, so page functions can import
// from this file and still be self-contained when injected.

export type Role = "Director" | "Project Lead" | "Project Manager" | "Engineer" | "QA Analyst";

/** Organization settings, set once on the options page. No defaults. */
export interface OrgSettings {
  /** Kantata address, normalized to "https://<subdomain>.mavenlink.com". */
  kantataUrl: string;
  /** Workday tenant: the path segment after wd5.myworkday.com/. */
  workdayTenant: string;
  /** Exact name of the Workday project that Kantata admin-project time is copied to. */
  adminProject: string;
}

export interface Settings {
  role: Role;
  /** Workday location worktag exactly as Workday shows it, e.g. "Location: <name>". Empty = keep Workday's default. */
  location: string;
  /** Any date in the target week, YYYY-MM-DD. */
  week: string;
  org: OrgSettings;
}

// ------------------------------------------------------------------ Kantata

export interface KtDay {
  date: string;
  weekday: string;
  hours: number;
  notes: string[];
  comment: string;
}

export interface KtRow {
  project: string;
  pcode: string | null;
  task: string;
  taskUrl: string;
  totalHours: number;
  days: KtDay[];
}

export type KtResult =
  | {
      ok: true;
      user: { id: string; name: string };
      week: { monday: string; sunday: string };
      entryCount: number;
      totalHours: number;
      dayTotals: Record<string, number>;
      rows: KtRow[];
    }
  | { ok: false; error: string };

// ------------------------------------------------------------------ Workday page reads

export type WdPage = "timesheet" | "hub" | "home" | "loading" | "other";

export interface WdState {
  page: WdPage;
  /** False when the tab is in the background or its window is minimized/covered. Workday
   * barely renders then (e.g. the virtualized grid never updates), so the run waits. */
  visible: boolean;
  url: string;
  header: string | null;
  dialogs: string[];
  savedToast: boolean;
  discardPrompt: boolean;
}

export interface GridRow {
  rowIndex: number;
  label: string;
  /** Mon..Sun values, null when the cell is blank (header rows). */
  values: (number | null)[];
  total: number | null;
  pencil: "edit" | "view" | null;
}

export interface GridScan {
  ok: boolean;
  error?: string;
  header: string | null;
  rows: GridRow[];
  summary: Record<string, number>;
}

export interface SearchRow {
  index: number;
  checked: boolean;
  customer: string;
  project: string;
  phase: string;
  task: string;
}

export interface SearchRead {
  open: boolean;
  tableFound: boolean;
  keywords: string | null;
  allMatch: boolean | null;
  rows: SearchRow[];
}

export interface DialogEntry {
  hours: string;
  comment: string;
  worktags: string[];
}

export interface DialogDay {
  day: string;
  entries: DialogEntry[];
}

export interface DialogRead {
  open: boolean;
  timeType: string;
  days: DialogDay[];
  errors: string[];
}

/** Things `wdAct` can locate on the Workday page. */
export type MarkSpec =
  | { kind: "pageButton"; text: string }
  | { kind: "ariaButton"; aria: string }
  | { kind: "navPersonal" }
  | { kind: "navTime" }
  | { kind: "hubThisWeek" }
  | { kind: "pencil"; rowIndex: number }
  | { kind: "searchKeywords" }
  | { kind: "searchButton" }
  | { kind: "searchCheckbox"; project: string; phase: string; task: string }
  | { kind: "searchAdd" }
  | { kind: "searchClose" }
  | { kind: "discard" }
  | { kind: "dayAdd"; day: string }
  | { kind: "entry"; day: string; index: number; field: "hours" | "comment" | "worktagInput" | "worktagOption" | "remove"; option?: number }
  | { kind: "detailsSave" }
  | { kind: "detailsCancel" }
  | { kind: "detailsBlank" }
  | { kind: "worktagResult"; text: string };

/** What `wdAct` does to the element it found (all synthetic DOM events). */
export type Action =
  | { type: "locate" }
  | { type: "click" }
  | { type: "hover" }
  | { type: "fill"; value: string }
  | { type: "key"; key: "Enter" | "Delete" | "Backspace" | "ArrowDown" | "Escape" }
  | { type: "blur" };

export type ActResult = { ok: true; label: string } | { ok: false; error: string };

export interface WorktagResults {
  loading: boolean;
  options: string[];
}

// ------------------------------------------------------------------ plan / report

export type TargetKind = "client" | "admin";

export interface Target {
  key: string;
  kind: TargetKind;
  /** p-code for client targets; the admin project name for admin. */
  code: string;
  /** Leaf row label in Workday (role, or "General" for admin). */
  task: string;
  label: string;
}

export interface PlannedEntry {
  target: Target;
  date: string;
  /** Workday sidebar day heading, e.g. "Saturday, November 14, 2026". */
  dayLabel: string;
  hours: number;
  comment: string;
  taskUrl: string;
  ktProject: string;
  ktTask: string;
}

export type EntryStatus = "add" | "added" | "exists" | "differs" | "skipped" | "failed" | "unknown";

export interface EntryOutcome extends PlannedEntry {
  status: EntryStatus;
  note?: string;
}

export interface Flag {
  level: "warn" | "error" | "info";
  message: string;
}

export interface Report {
  mode: "preview" | "apply";
  startedAt: string;
  finishedAt?: string;
  week?: { monday: string; sunday: string; source: string };
  user?: string;
  entries: EntryOutcome[];
  flags: Flag[];
  kantataTotals?: { client: number; admin: number; pto: number; other: number; total: number; byCode: Record<string, number> };
  workdaySummaryBefore?: Record<string, number>;
  workdaySummaryAfter?: Record<string, number>;
  done: boolean;
  aborted?: string;
}
