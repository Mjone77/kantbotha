// Functions that run inside the Workday tab (chrome.scripting.executeScript, MAIN world).
//
// Rules for this file:
// - Every exported function must be fully self-contained (no references to module-level
//   code), because Chrome serializes the function source and runs it in the page.
// - The read functions (wdState, wdScanGrid, wdReadSearch, wdReadDialog,
//   wdWorktagResults) never change anything.
// - `wdAct` is the only function that interacts. It finds one element from a MarkSpec and
//   performs one action with synthetic DOM events (pointer/mouse events for clicks, the
//   native value setter + input/change events for fills, KeyboardEvents for keys). It
//   refuses to click anything labelled like Submit / Update / Delete / Bookmark.
// - Never read cookies, tokens, or headers.

import type { Action, ActResult, DialogRead, GridScan, MarkSpec, SearchRead, WdState, WorktagResults } from "../types.js";

// ------------------------------------------------------------------ page state

export function wdState(): WdState {
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const headerRe = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})? [–-] ([A-Z][a-z]{2} )?\d{1,2}, \d{4}$/;
  const header = Array.from(document.querySelectorAll("h2")).map(txt).find((t) => headerRe.test(t)) ?? null;
  const buttons = Array.from(document.querySelectorAll("button,[role=button]")).filter(vis);
  const btnText = buttons.map(txt);
  const dialogs = Array.from(document.querySelectorAll("[role=dialog]"))
    .filter(vis)
    .map((d) => {
      const ids = (d.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      const t = ids.map((i) => txt(document.getElementById(i))).join(" ").trim();
      return t || txt(d.querySelector("h2")) || "(untitled dialog)";
    });
  let page: WdState["page"] = "other";
  if (header && btnText.includes("Expand Search")) page = "timesheet";
  else if (btnText.some((t) => t.startsWith("This Week ("))) page = "hub";
  else if (document.querySelector("[data-automation-id=sidebarL1]") && /home\.htmld/.test(location.pathname)) page = "home";
  else if (document.readyState !== "complete" || !document.querySelector("[data-automation-id=sidebarL1]")) page = "loading";
  const bodyText = document.body ? document.body.innerText : "";
  return {
    page,
    visible: document.visibilityState === "visible",
    url: location.origin + location.pathname.slice(0, 60),
    header,
    dialogs,
    savedToast: bodyText.includes("Details saved"),
    discardPrompt: btnText.includes("Discard"),
  };
}

// ------------------------------------------------------------------ timesheet grid

/** Scrolls the (virtualized) timesheet grid top to bottom and collects every row. */
export async function wdScanGrid(): Promise<GridScan> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const txt = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const num = (s: string) => (s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);
  const headerRe = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})? [–-] ([A-Z][a-z]{2} )?\d{1,2}, \d{4}$/;
  const header = Array.from(document.querySelectorAll("h2")).map(txt).find((t) => headerRe.test(t)) ?? null;

  const scrollable = (d: Element) => /(auto|scroll)/.test(getComputedStyle(d).overflowY) && d.scrollHeight > d.clientHeight && !d.closest("[role=dialog]");
  // Use the innermost scroller that holds grid rows. In a small window the page container
  // around the grid scrolls too (by a pixel or more); scrolling that one renders nothing new.
  const candidates = Array.from(document.querySelectorAll("div")).filter(
    (d) => scrollable(d) && !!d.querySelector("[role=row][aria-rowindex] [role=gridcell]"),
  );
  const scroller = candidates.find((c) => !candidates.some((o) => o !== c && c.contains(o))) ?? null;
  // No scroller: either the timesheet is blank (the grid has only its header rows) or every
  // row fits without scrolling. Both are fine as long as the grid itself is there.
  if (!scroller) {
    const grid = Array.from(document.querySelectorAll("[role=treegrid],[role=grid]")).find(
      (g) => !g.closest("[role=dialog]") && /Time Types/.test(txt(g)),
    );
    if (!grid) return { ok: false, error: "Timesheet grid not found.", header, rows: [], summary: {} };
  }
  // The grid has a separate custom scrollbar with the same scroll height that drives the
  // virtualized rendering, so move it together with the grid body.
  const linked = scroller
    ? Array.from(document.querySelectorAll("div")).filter(
        (d) => d !== scroller && scrollable(d) && d.scrollHeight === scroller.scrollHeight && d.clientHeight === scroller.clientHeight,
      )
    : [];
  const setTop = (v: number) => {
    if (!scroller) return;
    scroller.scrollTop = v;
    for (const l of linked) {
      l.scrollTop = v;
      l.dispatchEvent(new Event("scroll"));
    }
    scroller.dispatchEvent(new Event("scroll"));
  };

  const rows = new Map<number, { label: string; values: (number | null)[]; total: number | null; pencil: "edit" | "view" | null }>();
  const collect = () => {
    for (const r of Array.from(document.querySelectorAll("[role=row][aria-rowindex]"))) {
      if (r.closest("[role=dialog]")) continue;
      const idx = Number(r.getAttribute("aria-rowindex"));
      if (!idx || idx < 2) continue;
      const cells = Array.from(r.querySelectorAll("[role=gridcell]"));
      const cur = rows.get(idx) || { label: "", values: [], total: null, pencil: null };
      if (cells.length >= 9) {
        cur.label = txt(cells[0]);
        cur.values = cells.slice(2, 9).map((c) => num(txt(c)));
        const pencil = r.querySelector('button[aria-label^="Details "]');
        const aria = pencil ? pencil.getAttribute("aria-label") || "" : "";
        cur.pencil = /Edit details Button$/.test(aria) ? "edit" : /View details Button$/.test(aria) ? "view" : null;
      } else if (cells.length === 1) {
        cur.total = num(txt(cells[0]));
      }
      rows.set(idx, cur);
    }
  };
  if (scroller) {
    const original = scroller.scrollTop;
    setTop(0);
    await sleep(500);
    for (let i = 0; i < 40; i++) {
      collect();
      const before = scroller.scrollTop;
      setTop(before + Math.max(100, Math.floor(scroller.clientHeight * 0.5)));
      await sleep(500);
      collect();
      // scrollTop can be fractional, so compare with a tolerance.
      if (Math.abs(scroller.scrollTop - before) < 1) break;
    }
    await sleep(300);
    collect();
    setTop(original);
    // Let the grid re-render at the restored position, so the next step doesn't find rows
    // left over from the bottom of the grid.
    await sleep(500);
  } else {
    collect();
  }

  const summary: Record<string, number> = {};
  for (const t of Array.from(document.querySelectorAll("table"))) {
    if (!/Total Hours/.test(t.textContent || "") || !/Chargeable/.test(t.textContent || "")) continue;
    for (const tr of Array.from(t.querySelectorAll("tr"))) {
      const cells = Array.from(tr.querySelectorAll("th,td")).map(txt);
      if (cells.length >= 2 && Number.isFinite(Number(cells[cells.length - 1]))) summary[cells[0]] = Number(cells[cells.length - 1]);
    }
  }
  const list = Array.from(rows.entries())
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.label !== "")
    .map(([rowIndex, v]) => ({ rowIndex, ...v }));
  return { ok: true, header, rows: list, summary };
}

// ------------------------------------------------------------------ locate + act

/** Finds one element, scrolls it into view, and performs one action on it with synthetic events. */
export async function wdAct(spec: MarkSpec, action: Action): Promise<ActResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const lab = (el: Element) => {
    const input = el as HTMLInputElement;
    const fromFor = Array.from(input.labels || []).map((l) => txt(l)).join(" ");
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const fromIds = ids.map((i) => txt(document.getElementById(i))).join(" ");
    return (fromFor || el.getAttribute("aria-label") || fromIds || "").trim();
  };
  const dialogTitled = (re: RegExp) =>
    Array.from(document.querySelectorAll("[role=dialog]")).find((d) => {
      if (!vis(d)) return false;
      const ids = (d.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      const t = ids.map((i) => txt(document.getElementById(i))).join(" ") || txt(d.querySelector("h2"));
      return re.test(t);
    }) || null;
  const buttonsIn = (root: ParentNode) => Array.from(root.querySelectorAll("button,[role=button]")).filter(vis);
  const outsideDialogs = (el: Element) => !el.closest("[role=dialog]");
  const details = () => dialogTitled(/^Details$/);
  const panel = () => dialogTitled(/^Search across projects/);
  const dayRe = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, [A-Z][a-z]+ \d{1,2}, \d{4}$/;

  // Walk the Details sidebar in document order: day headings, then per entry the
  // Hours input, Comment input, worktag input + selected options, and Remove button.
  interface EntryRefs {
    hours: Element;
    comment?: Element;
    worktagInput?: Element;
    options: Element[];
    remove?: Element;
  }
  const walkDetails = (d: Element) => {
    const days: { name: string; heading: Element; add?: Element; entries: EntryRefs[] }[] = [];
    let day: (typeof days)[number] | null = null;
    let entry: EntryRefs | null = null;
    const w = document.createTreeWalker(d, NodeFilter.SHOW_ELEMENT);
    for (let el = w.currentNode as Element | null; el; el = w.nextNode() as Element | null) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag) && dayRe.test(txt(el))) {
        day = { name: txt(el), heading: el, entries: [] };
        days.push(day);
        entry = null;
        continue;
      }
      if (!day) continue;
      if ((tag === "INPUT" || tag === "TEXTAREA") && (el as HTMLInputElement).type !== "checkbox" && (el as HTMLInputElement).type !== "hidden") {
        const l = lab(el);
        if (/^Hours/i.test(l) || el.getAttribute("data-automation-id") === "numericInput") {
          entry = { hours: el, options: [] };
          day.entries.push(entry);
        } else if (/^Comment/i.test(l) && entry) entry.comment = el;
        else if (/^(Worktags|Search)/i.test(l) && entry) entry.worktagInput = el;
        continue;
      }
      if (entry && el.getAttribute("role") === "option" && el.closest("[data-automation-id=selectedItemList]")) {
        if (!entry.options.includes(el)) entry.options.push(el);
        continue;
      }
      if (el.getAttribute("data-automation-id") === "panelSetRowDeleteButton" && entry) entry.remove = el;
      if (el.getAttribute("data-automation-id") === "panelSetAddButton" && !day.add) day.add = el;
    }
    return days;
  };

  // Innermost scroller holding grid rows (an outer page container can scroll too in a small window).
  const findGridScroller = () => {
    const candidates = Array.from(document.querySelectorAll("div")).filter((dv) => {
      const s = getComputedStyle(dv);
      return /(auto|scroll)/.test(s.overflowY) && dv.scrollHeight > dv.clientHeight && !!dv.querySelector("[role=row][aria-rowindex] [role=gridcell]") && !dv.closest("[role=dialog]");
    });
    return candidates.find((c) => !candidates.some((o) => o !== c && c.contains(o))) || null;
  };

  let el: Element | null = null;
  let label = "";
  switch (spec.kind) {
    case "pageButton":
      el = buttonsIn(document).find((b) => outsideDialogs(b) && txt(b) === spec.text) || null;
      break;
    case "ariaButton":
      el = buttonsIn(document).find((b) => outsideDialogs(b) && b.getAttribute("aria-label") === spec.aria) || null;
      break;
    case "navPersonal":
      el = Array.from(document.querySelectorAll("[data-automation-id=sidebarL1]")).find((b) => vis(b) && txt(b) === "Personal") || null;
      break;
    case "navTime":
      el = Array.from(document.querySelectorAll("a[data-automation-id=sidebarL2]")).find((a) => vis(a) && txt(a) === "Time") || null;
      break;
    case "hubThisWeek":
      el = buttonsIn(document).find((b) => txt(b).startsWith("This Week (")) || null;
      break;
    case "pencil": {
      const find = () =>
        document.querySelector(`[role=row][aria-rowindex="${spec.rowIndex}"] button[aria-label^="Details "][aria-label$="Edit details Button"]`);
      el = find();
      const sc = el ? null : findGridScroller();
      if (sc) {
        // Step through the virtualized grid (moving its linked custom scrollbar too) until
        // the row is rendered.
        const scrollable = (d: Element) => /(auto|scroll)/.test(getComputedStyle(d).overflowY) && d.scrollHeight > d.clientHeight && !d.closest("[role=dialog]");
        const linked = Array.from(document.querySelectorAll("div")).filter(
          (d) => d !== sc && scrollable(d) && d.scrollHeight === sc.scrollHeight && d.clientHeight === sc.clientHeight,
        );
        const setTop = (v: number) => {
          sc.scrollTop = v;
          for (const l of linked) {
            l.scrollTop = v;
            l.dispatchEvent(new Event("scroll"));
          }
          sc.dispatchEvent(new Event("scroll"));
        };
        setTop(0);
        await sleep(400);
        el = find();
        for (let i = 0; i < 40 && !el; i++) {
          const before = sc.scrollTop;
          setTop(before + Math.max(100, Math.floor(sc.clientHeight * 0.5)));
          await sleep(400);
          el = find();
          if (Math.abs(sc.scrollTop - before) < 1) break;
        }
      }
      // The grid renders rows asynchronously after a scroll, so the button found may be a
      // leftover from an earlier scroll position that the grid is about to remove. Scroll
      // it into view, let the grid re-render, and find it again until it's really there.
      for (let i = 0; i < 6 && el; i++) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(300);
        const again = find();
        const size = again ? again.getBoundingClientRect() : null;
        if (again && size && size.width > 0 && size.height > 0 && again === el) break;
        el = again;
      }
      break;
    }
    case "searchKeywords": {
      const p = panel();
      el = p ? Array.from(p.querySelectorAll("input[data-automation-id=textInputBox]")).find(vis) || null : null;
      break;
    }
    case "searchButton": {
      const p = panel();
      el = p ? buttonsIn(p).find((b) => b.tagName === "BUTTON" && txt(b) === "Search") || null : null;
      break;
    }
    case "searchAdd": {
      const p = panel();
      el = p ? buttonsIn(p).find((b) => b.getAttribute("data-automation-id") === "wd-CommandButton" && txt(b) === "Add") || null : null;
      break;
    }
    case "searchClose": {
      const p = panel();
      el = p ? p.querySelector("[data-automation-id=closeButton]") : null;
      break;
    }
    case "searchCheckbox": {
      const p = panel();
      const table = p
        ? Array.from(p.querySelectorAll("table")).find((t) => vis(t) && t.querySelector('input[type=checkbox][aria-label="Select Row"]'))
        : null;
      if (table) {
        const headers = Array.from(table.querySelectorAll("th")).map((h) => (h.textContent || "").replace(/Sort and filter.*$/i, "").trim());
        const col = (name: string) => headers.findIndex((h) => h === name);
        for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
          const cb = tr.querySelector('input[type=checkbox][aria-label="Select Row"]');
          if (!cb) continue;
          const cells = Array.from(tr.children).map((c) => txt(c));
          const off = cells.length - headers.length;
          const get = (n: string) => (col(n) >= 0 ? cells[col(n) + off] || "" : "");
          if (get("Project") === spec.project && get("Phase") === spec.phase && get("Task") === spec.task) {
            el = vis(cb) ? cb : cb.parentElement;
            break;
          }
        }
      }
      break;
    }
    case "discard":
      el = buttonsIn(document).find((b) => txt(b) === "Discard") || null;
      break;
    case "dayAdd": {
      const d = details();
      const day = d ? walkDetails(d).find((x) => x.name === spec.day) : undefined;
      el = day?.add || null;
      break;
    }
    case "entry": {
      const d = details();
      const day = d ? walkDetails(d).find((x) => x.name === spec.day) : undefined;
      const e = day?.entries[spec.index];
      if (e) {
        if (spec.field === "hours") el = e.hours;
        else if (spec.field === "comment") el = e.comment || null;
        else if (spec.field === "worktagInput") el = e.worktagInput || null;
        else if (spec.field === "worktagOption") el = e.options[spec.option ?? 0] || null;
        else if (spec.field === "remove") el = e.remove || null;
      }
      break;
    }
    case "detailsSave": {
      const d = details();
      el = d ? buttonsIn(d).find((b) => b.tagName === "BUTTON" && txt(b) === "Save") || null : null;
      break;
    }
    case "detailsCancel": {
      const d = details();
      el = d ? buttonsIn(d).find((b) => b.tagName === "BUTTON" && txt(b) === "Cancel") || null : null;
      break;
    }
    case "detailsBlank": {
      // The empty header bar between the "Details" title and the Close (X) button.
      // Clicking it closes an open worktag dropdown without touching any control.
      const d = details();
      const h2 = d ? Array.from(d.querySelectorAll("h2")).find((h) => txt(h) === "Details") : null;
      const close = d ? d.querySelector("[data-automation-id=closeButton]") : null;
      if (!d || !h2 || !close) return { ok: false, error: "Details sidebar header not found." };
      const hr = h2.getBoundingClientRect();
      const cr = close.getBoundingClientRect();
      const hit = document.elementFromPoint((hr.right + cr.left) / 2, hr.top + hr.height / 2);
      if (!hit || !d.contains(hit)) return { ok: false, error: "Blank header point is outside the sidebar." };
      if (hit.closest("button,a,input,textarea,select,[role=button],[role=option],[role=link]"))
        return { ok: false, error: "Blank header point is on a control." };
      el = hit;
      break;
    }
    case "worktagResult": {
      el =
        Array.from(document.querySelectorAll("[role=option]")).find(
          (o) => vis(o) && !o.closest("[data-automation-id=selectedItemList]") && txt(o).replace(/,? Press .*$/, "") === spec.text,
        ) || null;
      break;
    }
  }
  if (!el) return { ok: false, error: "Not found: " + JSON.stringify(spec) };

  if (spec.kind !== "detailsBlank") el.scrollIntoView({ block: "center", inline: "nearest" });
  await sleep(150);
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok: false, error: "Element has no size: " + JSON.stringify(spec) };
  label = (el.tagName === "INPUT" ? lab(el) : txt(el)) || el.getAttribute("aria-label") || "";

  // Safety: never interact with anything that could submit, update, or delete.
  const control = el.closest("button,a,[role=button],[role=link],[role=menuitem]") || el;
  // Workday appends screen-reader hints like ", Press delete to clear item., Press Alt + R
  // for related actions" to worktag chips; those aren't the control's name.
  const controlLabel = ((control.getAttribute("aria-label") || "") + " " + txt(control)).replace(/,?\s*Press (delete|Alt|enter|space)\b.*$/i, "");
  if (/\b(submit|update|delete|bookmark|approve|send back|cancel request)\b/i.test(controlLabel))
    return { ok: false, error: `Refused: "${controlLabel.trim().slice(0, 80)}" looks like a submit/update/delete control.` };

  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const mouse = (type: string, buttons: number): MouseEventInit => ({
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons,
    detail: type === "click" || type.endsWith("down") || type.endsWith("up") ? 1 : 0,
  });
  const pointer = (type: string, buttons: number) =>
    new PointerEvent(type, { ...mouse(type, buttons), pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0 });
  const hover = () => {
    el!.dispatchEvent(pointer("pointerover", 0));
    el!.dispatchEvent(new PointerEvent("pointerenter", { ...mouse("pointerenter", 0), bubbles: false, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el!.dispatchEvent(new MouseEvent("mouseover", mouse("mouseover", 0)));
    el!.dispatchEvent(new MouseEvent("mouseenter", { ...mouse("mouseenter", 0), bubbles: false }));
    el!.dispatchEvent(pointer("pointermove", 0));
    el!.dispatchEvent(new MouseEvent("mousemove", mouse("mousemove", 0)));
  };
  const keyCodes: Record<string, number> = { Enter: 13, Delete: 46, Backspace: 8, ArrowDown: 40, Escape: 27 };

  switch (action.type) {
    case "locate":
      break;
    case "hover":
      hover();
      break;
    case "click": {
      hover();
      el.dispatchEvent(pointer("pointerdown", 1));
      el.dispatchEvent(new MouseEvent("mousedown", mouse("mousedown", 1)));
      if (el instanceof HTMLElement && (el.tabIndex >= 0 || /^(INPUT|TEXTAREA|BUTTON|A|SELECT)$/.test(el.tagName))) el.focus();
      el.dispatchEvent(pointer("pointerup", 0));
      el.dispatchEvent(new MouseEvent("mouseup", mouse("mouseup", 0)));
      el.dispatchEvent(new MouseEvent("click", mouse("click", 0)));
      break;
    }
    case "fill": {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { ok: false, error: "Not a text field: " + JSON.stringify(spec) };
      el.focus();
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) return { ok: false, error: "No value setter." };
      // Clear first, then set, so frameworks see a real change even if the value matches.
      setter.call(el, "");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      setter.call(el, action.value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      break;
    }
    case "key": {
      const target = (document.activeElement as Element | null) && el.contains(document.activeElement) ? (document.activeElement as Element) : el;
      const code = keyCodes[action.key];
      const mk = (type: string) => {
        const e = new KeyboardEvent(type, { key: action.key, code: action.key, bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(e, "keyCode", { get: () => code });
        Object.defineProperty(e, "which", { get: () => code });
        return e;
      };
      target.dispatchEvent(mk("keydown"));
      if (action.key === "Enter") target.dispatchEvent(mk("keypress"));
      target.dispatchEvent(mk("keyup"));
      break;
    }
    case "blur": {
      if (el instanceof HTMLElement) {
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        el.blur();
      }
      break;
    }
  }
  return { ok: true, label: label.slice(0, 120) };
}

// ------------------------------------------------------------------ search panel

export function wdReadSearch(): SearchRead {
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const p = Array.from(document.querySelectorAll("[role=dialog]")).find((d) => {
    if (!vis(d)) return false;
    const ids = (d.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return /^Search across projects/.test(ids.map((i) => txt(document.getElementById(i))).join(" ") || txt(d.querySelector("h2")));
  });
  if (!p) return { open: false, tableFound: false, keywords: null, allMatch: null, rows: [] };
  const kw = Array.from(p.querySelectorAll("input[data-automation-id=textInputBox]")).find(vis) as HTMLInputElement | undefined;
  const keywords = kw ? kw.value.trim() : null;
  const table = Array.from(p.querySelectorAll("table")).find((t) => vis(t) && t.querySelector('input[type=checkbox][aria-label="Select Row"]'));
  if (!table) return { open: true, tableFound: false, keywords, allMatch: null, rows: [] };
  const headers = Array.from(table.querySelectorAll("th")).map((h) => (h.textContent || "").replace(/Sort and filter.*$/i, "").trim());
  const col = (name: string) => headers.findIndex((h) => h === name);
  const rows: SearchRead["rows"] = [];
  for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
    const cb = tr.querySelector('input[type=checkbox][aria-label="Select Row"]') as HTMLInputElement | null;
    if (!cb) continue;
    const cells = Array.from(tr.children).map((c) => txt(c));
    const off = cells.length - headers.length;
    const get = (n: string) => (col(n) >= 0 ? cells[col(n) + off] || "" : "");
    rows.push({
      index: rows.length,
      checked: cb.checked || cb.getAttribute("aria-checked") === "true",
      customer: get("Customer"),
      project: get("Project"),
      phase: get("Phase"),
      task: get("Task"),
    });
  }
  const allMatch = keywords && rows.length ? rows.every((r) => norm([r.project, r.phase, r.task].join(" ")).includes(norm(keywords))) : null;
  return { open: true, tableFound: true, keywords, allMatch, rows };
}

// ------------------------------------------------------------------ details sidebar

export function wdReadDialog(): DialogRead {
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const d = Array.from(document.querySelectorAll("[role=dialog]")).find((x) => vis(x) && txt(x.querySelector("h2")) === "Details");
  if (!d) return { open: false, timeType: "", days: [], errors: [] };
  const dayRe = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, [A-Z][a-z]+ \d{1,2}, \d{4}$/;
  const lab = (el: Element) => {
    const input = el as HTMLInputElement;
    const fromFor = Array.from(input.labels || []).map((l) => txt(l)).join(" ");
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const fromIds = ids.map((i) => txt(document.getElementById(i))).join(" ");
    return (fromFor || el.getAttribute("aria-label") || fromIds || "").trim();
  };
  const clean = (t: string) => t.replace(/\s+/g, " ").trim().replace(/,? Press delete.*$/, "");
  const timeType: string[] = [];
  const days: DialogRead["days"] = [];
  let day: DialogRead["days"][number] | null = null;
  let entry: DialogRead["days"][number]["entries"][number] | null = null;
  const w = document.createTreeWalker(d, NodeFilter.SHOW_ELEMENT);
  for (let el = w.currentNode as Element | null; el; el = w.nextNode() as Element | null) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag) && dayRe.test(txt(el))) {
      const name = txt(el);
      day = days.find((x) => x.day === name) || null;
      if (!day) {
        day = { day: name, entries: [] };
        days.push(day);
      }
      entry = null;
      continue;
    }
    if ((tag === "INPUT" || tag === "TEXTAREA") && (el as HTMLInputElement).type !== "checkbox" && (el as HTMLInputElement).type !== "hidden") {
      const l = lab(el);
      if ((/^Hours/i.test(l) || el.getAttribute("data-automation-id") === "numericInput") && day) {
        entry = { hours: (el as HTMLInputElement).value, comment: "", worktags: [] };
        day.entries.push(entry);
      } else if (/^Comment/i.test(l) && entry) entry.comment = (el as HTMLInputElement).value;
      continue;
    }
    // Submitted/approved entries are read-only: Comment is a textView and Worktags are
    // plain "instance" items instead of an input and selected-item chips.
    const aid = el.getAttribute("data-automation-id");
    if ((aid === "textView" || aid === "instance") && entry) {
      const fieldLabel = txt(el.closest("li")?.querySelector("label") ?? null);
      const t = clean(el.textContent || "");
      if (aid === "textView" && /^Comment/i.test(fieldLabel)) entry.comment = t;
      else if (aid === "instance" && /^Worktags/i.test(fieldLabel) && t && !entry.worktags.includes(t)) entry.worktags.push(t);
      continue;
    }
    if (el.getAttribute("role") === "option" && el.closest("[data-automation-id=selectedItemList]")) {
      const t = clean(el.textContent || el.getAttribute("aria-label") || "");
      if (!t) continue;
      if (!day) timeType.push(t);
      else if (entry && !entry.worktags.includes(t)) entry.worktags.push(t);
    }
  }
  // When the row's entries are submitted/approved, Workday shows Time Type as read-only text
  // (multiSelectReadOnly > instance) instead of selected-item chips, so fall back to the
  // field labelled "Time Type".
  if (!timeType.length) {
    const label = Array.from(d.querySelectorAll("label")).find((l) => txt(l) === "Time Type");
    const field = label?.closest("li");
    if (field) {
      const parts = Array.from(field.querySelectorAll("[data-automation-id=instance], [role=option]")).map((x) => clean(x.textContent || ""));
      for (const t of parts) if (t && !timeType.includes(t)) timeType.push(t);
    }
  }
  const errors = Array.from(d.querySelectorAll("[role=alert],[data-automation-id=errorWidgetBarMessageCount],[data-automation-id=errorMessage]"))
    .filter(vis)
    .map(txt)
    .filter(Boolean);
  return { open: true, timeType: timeType.join(" | "), days, errors };
}

/** Visible worktag typeahead results (not the already-selected worktags). */
export function wdWorktagResults(): WorktagResults {
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const txt = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const options = Array.from(document.querySelectorAll("[role=option]"))
    .filter((o) => vis(o) && !o.closest("[data-automation-id=selectedItemList]"))
    .map((o) => txt(o).replace(/,? Press .*$/, ""))
    .filter(Boolean);
  const loading = Array.from(document.querySelectorAll("[data-automation-id*=oading],[role=progressbar]")).some(vis);
  return { loading, options };
}
