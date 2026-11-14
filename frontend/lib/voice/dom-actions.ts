/**
 * Operates the page the way a person would, from what is *accessible* (names, roles, states), so voice control
 * works on every screen without per-page code. Pure DOM: no React, testable in jsdom.
 */

export type Kind =
  | "button" | "link" | "tab" | "checkbox" | "switch" | "radio" | "menuitem" | "option"
  | "field" | "select" | "file" | "other";

export interface Item {
  el: HTMLElement;
  /** Accessible name, truncated for speech. Empty when the control is unlabelled. */
  name: string;
  kind: Kind;
  disabled: boolean;
  /** checkbox/switch/radio, or a toggle button with aria-pressed. */
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  inputType?: string;
  /** Nearest heading / list-item text, used to tell apart identical names ("Delete" in two cards). */
  context?: string;
}

export const KIND_LABEL: Record<Kind, string> = {
  button: "button", link: "link", tab: "tab", checkbox: "checkbox", switch: "switch", radio: "radio button",
  menuitem: "menu item", option: "option", field: "text field", select: "drop-down", file: "file picker", other: "control",
};

const INTERACTIVE = [
  "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
  "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
  "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=option]", "[role=combobox]", "[role=textbox]",
  "[role=searchbox]", "[contenteditable='']", "[contenteditable=true]",
].join(",");

const SCOPE_SELECTOR = '[role="alertdialog"], [role="dialog"], [role="menu"], [cmdk-root]';
/** Voice UI controls themselves are excluded from "what can I click" and page reading. */
const VOICE_UI = "[data-voice-ui]";

// ---------------------------------------------------------------------------------------------------- visibility

function hasLayout(): boolean {
  return typeof navigator !== "undefined" && !/jsdom/i.test(navigator.userAgent);
}

export function isVisible(el: Element, cache?: Map<Element, boolean>): boolean {
  if (!el.isConnected) return false;
  const hiddenAncestor = (n: Element | null): boolean => {
    if (!n) return false;
    const cached = cache?.get(n);
    if (cached !== undefined) return cached;
    let hidden = n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true" || n.hasAttribute("inert");
    if (!hidden) {
      const cs = getComputedStyle(n);
      hidden = cs.display === "none" || (n === el && cs.visibility === "hidden");
    }
    if (!hidden) hidden = hiddenAncestor(n.parentElement);
    cache?.set(n, hidden);
    return hidden;
  };
  if (hiddenAncestor(el)) return false;
  if (hasLayout() && el.getClientRects().length === 0) return false;
  return true;
}

/** The part of the page voice commands act on: the top-most open dialog/menu, otherwise the whole page. */
export function activeScope(doc: Document = document): HTMLElement {
  const open = Array.from(doc.querySelectorAll<HTMLElement>(SCOPE_SELECTOR))
    .filter((n) => n.getAttribute("data-state") !== "closed" && !n.closest(VOICE_UI) && isVisible(n));
  return open.length ? open[open.length - 1] : doc.body;
}

export function isModalScope(scope: Element): boolean {
  return scope.matches('[role="alertdialog"], [role="dialog"]');
}

// -------------------------------------------------------------------------------------------------------- naming

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function textOf(node: Node, skipControls: boolean): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.localName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "svg" || tag === "template") return "";
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return "";
  if (tag === "img") return el.getAttribute("alt") ?? "";
  if (skipControls && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) return "";
  let out = "";
  el.childNodes.forEach((c) => { out += ` ${textOf(c, skipControls)}`; });
  return out;
}

function byIds(el: Element, ids: string): string {
  return collapse(ids.split(/\s+/).map((id) => {
    const t = el.ownerDocument.getElementById(id);
    return t ? textOf(t, false) : "";
  }).join(" "));
}

export function accessibleName(el: HTMLElement): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const n = byIds(el, labelledby);
    if (n) return n;
  }
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return collapse(aria);
  const tag = el.localName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const input = el as HTMLInputElement;
    const type = (input.type || "").toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes(type) && input.value) return collapse(input.value);
    if (tag === "input" && type === "image") return collapse(el.getAttribute("alt") ?? "");
    const labels = Array.from(input.labels ?? []);
    const text = collapse(labels.map((l) => textOf(l, true)).join(" "));
    if (text) return text;
    const ph = el.getAttribute("placeholder")?.trim();
    if (ph) return collapse(ph);
    return collapse(el.getAttribute("title") ?? el.getAttribute("name") ?? "");
  }
  const text = collapse(textOf(el, false));
  if (text) return text;
  return collapse(el.getAttribute("title") ?? "");
}

function kindOf(el: HTMLElement): Kind {
  const role = el.getAttribute("role");
  switch (role) {
    case "button": return "button";
    case "link": return "link";
    case "tab": return "tab";
    case "checkbox": case "menuitemcheckbox": return "checkbox";
    case "radio": case "menuitemradio": return "radio";
    case "switch": return "switch";
    case "menuitem": return "menuitem";
    case "option": return "option";
    case "combobox": case "textbox": case "searchbox": return el.localName === "select" ? "select" : "field";
    default: break;
  }
  const tag = el.localName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "field";
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "file";
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "range") return "other";
    return "field";
  }
  if (el.isContentEditable) return "field";
  return "other";
}

const CONTEXT_SELECTOR = "li, tr, article, [role=listitem], [role=row], section, form, [data-approval-id], [role=dialog]";

function contextOf(el: HTMLElement): string | undefined {
  const host = el.parentElement?.closest(CONTEXT_SELECTOR);
  if (!host) return undefined;
  const heading = host.querySelector("h1, h2, h3, h4, h5, h6, strong, th, [data-title], legend");
  const own = heading && !el.contains(heading) ? collapse(textOf(heading, true)) : "";
  const text = own || collapse(textOf(host, true));
  return text ? text.slice(0, 48) : undefined;
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

export function buildItem(el: HTMLElement): Item {
  const kind = kindOf(el);
  const item: Item = { el, name: accessibleName(el).slice(0, 100), kind, disabled: isDisabled(el) };
  const ariaChecked = el.getAttribute("aria-checked");
  const ariaPressed = el.getAttribute("aria-pressed");
  if (kind === "checkbox" || kind === "radio" || kind === "switch") {
    item.checked = el instanceof HTMLInputElement ? el.checked : ariaChecked === "true";
  } else if (ariaPressed === "true" || ariaPressed === "false") item.checked = ariaPressed === "true";
  if (el.getAttribute("aria-selected") != null) item.selected = el.getAttribute("aria-selected") === "true";
  if (el.getAttribute("aria-expanded") != null) item.expanded = el.getAttribute("aria-expanded") === "true";
  if (el instanceof HTMLInputElement) item.inputType = el.type.toLowerCase();
  return item;
}

/** Everything operable inside `root`, in reading order. */
export function collectItems(root: ParentNode = activeScope()): Item[] {
  const cache = new Map<Element, boolean>();
  const inVoiceUi = root instanceof Element && !!root.closest(VOICE_UI);
  const seen = new Set<Element>();
  const out: Item[] = [];
  root.querySelectorAll<HTMLElement>(INTERACTIVE).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!inVoiceUi && el.closest(VOICE_UI)) return;
    if (!isVisible(el, cache)) return;
    const item = buildItem(el);
    if (item.kind === "other" && !item.name) return;
    out.push(item);
  });
  const hrefs = new Set<string>();
  return out.filter((i) => {
    if (i.kind !== "link") return true;
    const key = `${i.name}|${(i.el as HTMLAnchorElement).getAttribute("href")}`;
    if (hrefs.has(key)) return false;
    hrefs.add(key);
    return true;
  }).map((i) => ({ ...i, context: contextOf(i.el) }));
}

// ------------------------------------------------------------------------------------------------------ matching

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ")
  .replace(/[^a-z0-9\s']/g, " ").replace(/'/g, "").replace(/\s+/g, " ").trim();

const STOP = new Set(["the", "a", "an", "my", "please", "on", "to", "of"]);
const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4,
  fifth: 5, "5th": 5, five: 5, sixth: 6, "6th": 6, six: 6, seventh: 7, "7th": 7, seven: 7, eighth: 8, "8th": 8, eight: 8,
  ninth: 9, "9th": 9, nine: 9, tenth: 10, "10th": 10, ten: 10,
};

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function scoreName(nameRaw: string, targetRaw: string): number {
  const name = norm(nameRaw);
  const target = norm(targetRaw).split(" ").filter((w) => !STOP.has(w) || targetRaw.trim().split(/\s+/).length === 1).join(" ");
  if (!name || !target) return 0;
  if (name === target) return 100;
  const nw = name.split(" ");
  const tw = target.split(" ");
  if (` ${name} `.includes(` ${target} `)) return 92 - Math.min(24, Math.max(0, nw.length - tw.length) * 3);
  if (name.length >= 3 && ` ${target} `.includes(` ${name} `)) return 72;
  const present = tw.filter((w) => nw.includes(w) || (w.length >= 3 && nw.some((x) => x.startsWith(w) || w.startsWith(x) && x.length >= 4)));
  if (present.length === tw.length) return 80 - Math.min(24, (nw.length - tw.length) * 2);
  if (tw.length >= 2 && present.length / tw.length >= 0.75) return 58;
  // Speech recognition errors: "create a gent", "approved" for "approve".
  const a = nw.join("");
  const b = tw.join("");
  if (b.length >= 4 && a.length >= 3) {
    const ratio = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    if (ratio >= 0.8) return Math.round(50 + (ratio - 0.8) * 100);
    if (a.length > b.length && a.startsWith(b)) return 60;
  }
  return 0;
}

const KIND_HINT: Record<string, Kind[]> = {
  button: ["button"], link: ["link"], tab: ["tab"], option: ["option", "menuitem", "radio"],
  checkbox: ["checkbox", "switch"], switch: ["switch", "checkbox"], menu: ["menuitem", "button"],
  item: ["menuitem", "option", "link", "button"], icon: ["button", "link"],
};

export type Match = { type: "one"; item: Item } | { type: "many"; items: Item[] } | { type: "none" };

export function parseOrdinal(spoken: string): { index: number | "last"; rest: string } | null {
  const words = norm(spoken).split(" ").filter((w) => !STOP.has(w));
  if (!words.length) return null;
  if (words[0] === "last") return { index: "last", rest: words.slice(1).join(" ") };
  const n = ORDINALS[words[0]] ?? (/^\d{1,2}$/.test(words[0]) ? Number(words[0]) : undefined);
  if (n && words.length === 1) return { index: n, rest: "" };
  if (n && ["one", "item", "result", "link", "button", "tab", "option"].includes(words[1] ?? "")) return { index: n, rest: words.slice(2).join(" ") };
  return null;
}

export function matchTarget(items: Item[], spoken: string, opts: { kind?: string; kinds?: Kind[]; fields?: boolean } = {}): Match {
  let pool = items.filter((i) => !i.disabled || items.every((x) => x.disabled));
  const kinds = opts.kinds ?? (opts.kind ? KIND_HINT[opts.kind] : undefined);
  if (kinds) {
    const narrowed = pool.filter((i) => kinds.includes(i.kind));
    if (narrowed.length) pool = narrowed;
  }
  const ord = parseOrdinal(spoken);
  if (ord && !ord.rest) {
    const list = opts.kind || opts.kinds ? pool : pool.filter((i) => i.kind !== "field" && i.kind !== "select");
    const pick = ord.index === "last" ? list[list.length - 1] : list[ord.index - 1];
    return pick ? { type: "one", item: pick } : { type: "none" };
  }
  const scored = pool.map((item, order) => ({ item, order, score: scoreName(item.name, ord?.rest || spoken) }))
    .filter((s) => s.score >= 50)
    .sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length || a.order - b.order);
  if (!scored.length) return { type: "none" };
  const top = scored[0];
  const close = scored.filter((s) => top.score - s.score <= (top.score >= 90 ? 4 : 10));
  if (close.length === 1) return { type: "one", item: top.item };
  // Several controls with the same name inside the same list/card context are one choice to the user.
  return { type: "many", items: close.slice(0, 6).map((s) => s.item) };
}

// ------------------------------------------------------------------------------------------------------- acting

const DESTRUCTIVE = /\b(delete|remove|disconnect|reset|revoke|sign out|log out|logout|erase|purge|clear all|wipe|unlink|uninstall|deactivate|cancel (?:subscription|plan))\b/i;
export const isDestructive = (name: string) => DESTRUCTIVE.test(name);

export function approvalIdOf(el: Element): string | null {
  return el.closest("[data-approval-id]")?.getAttribute("data-approval-id") ?? null;
}

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, init);
}

/** A full click gesture. Radix triggers listen for pointerdown/mousedown, not just click. */
export function activate(el: HTMLElement): void {
  el.scrollIntoView?.({ block: "center", inline: "nearest" });
  el.focus?.({ preventScroll: true });
  const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
  const Pointer = typeof PointerEvent !== "undefined" ? PointerEvent : undefined;
  const pointer = (type: string, extra: MouseEventInit) =>
    Pointer ? new Pointer(type, { ...extra, pointerType: "mouse", isPrimary: true, pointerId: 1 }) : mouse(type, extra);
  el.dispatchEvent(pointer("pointerdown", init));
  el.dispatchEvent(mouse("mousedown", init));
  const up = { ...init, buttons: 0 };
  el.dispatchEvent(pointer("pointerup", up));
  el.dispatchEvent(mouse("mouseup", up));
  el.click();
}

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
}

/** Types into an input the way a keyboard would, so React/controlled components see the change. */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, append = false): string {
  el.focus?.({ preventScroll: true });
  const next = append && el.value ? `${el.value}${/\s$/.test(el.value) ? "" : " "}${value}` : value;
  nativeSet(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return next;
}

export function chooseOption(el: HTMLSelectElement, spoken: string): { ok: boolean; label?: string; options: string[] } {
  const opts = Array.from(el.options).filter((o) => !o.disabled);
  const options = opts.map((o) => collapse(o.textContent ?? o.value));
  const ord = parseOrdinal(spoken);
  let pick: HTMLOptionElement | undefined;
  if (ord && !ord.rest) pick = ord.index === "last" ? opts[opts.length - 1] : opts[ord.index - 1];
  if (!pick) {
    const scored = opts.map((o) => ({ o, s: Math.max(scoreName(o.textContent ?? "", spoken), scoreName(o.value, spoken)) }))
      .filter((x) => x.s >= 50).sort((a, b) => b.s - a.s);
    pick = scored[0]?.o;
  }
  if (!pick) return { ok: false, options };
  nativeSet(el, pick.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, label: collapse(pick.textContent ?? pick.value), options };
}

export function isChecked(item: Item): boolean {
  return buildItem(item.el).checked === true;
}

/**
 * Sets a switch/checkbox to a state (null = flip). React applies the click asynchronously, so the caller re-reads
 * the final state with isChecked() after a short settle.
 */
export function setChecked(item: Item, on: boolean | null): { changed: boolean; want: boolean } {
  const before = isChecked(item);
  const want = on === null ? !before : on;
  if (before !== want) activate(item.el);
  return { changed: before !== want, want };
}

/** Values spoken into fields are cleaned for the field type ("jo at example dot com" → jo@example.com). */
export function normalizeSpokenValue(value: string, type: string | undefined): string {
  let v = value.trim().replace(/[.]+$/, (m) => (m.length === 1 && /\d\.$/.test(value) ? "" : m));
  if (type === "email") {
    v = v.replace(/\s+at\s+/gi, "@").replace(/\s+dot\s+/gi, ".").replace(/\s+/g, "").toLowerCase();
  } else if (type === "url") {
    v = v.replace(/\s+dot\s+/gi, ".").replace(/\s+slash\s+/gi, "/").replace(/\s+/g, "");
  } else if (type === "number") {
    v = v.replace(/,/g, "").replace(/\s+/g, "").replace(/\.$/, "");
  } else if (type === "tel") {
    v = v.replace(/[^\d+]/g, "");
  }
  return v;
}

const SECRET_NAME = /\b(password|passcode|passphrase|secret|token|api[ -]?key|private key|client secret|pin)\b/i;

/** Fields whose content must never be dictated (it would be sent to speech recognition) or read back aloud. */
export function isSecretField(item: Item): boolean {
  return item.inputType === "password" || SECRET_NAME.test(item.name);
}

export function fieldValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement && el.type === "password") return "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el instanceof HTMLSelectElement) return collapse(el.selectedOptions[0]?.textContent ?? "");
    return el.value;
  }
  return collapse(el.textContent ?? "");
}

function pressKey(el: Element, key: string): void {
  const init = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** Escape / the dialog's own close button. Returns true if something was closed. */
export function closeTopmost(doc: Document = document): boolean {
  const scope = activeScope(doc);
  if (scope === doc.body) return false;
  const closer = collectItems(scope).find((i) => /^(close|dismiss|cancel|no|done)\b/i.test(i.name) && i.kind === "button");
  if (closer) activate(closer.el);
  else pressKey((doc.activeElement as Element) || scope, "Escape");
  return true;
}

/** "Submit": the focused field's form, else the obvious primary action nearby. */
export function submitNearest(doc: Document = document): { ok: boolean; via?: string } {
  const active = doc.activeElement as HTMLElement | null;
  const form = active?.closest("form");
  if (form instanceof HTMLFormElement && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return { ok: true, via: "form" };
  }
  const scope = (active && active !== doc.body ? active.closest("section, [role=dialog], main, form") : null) as HTMLElement | null;
  const verbs = /^(send|submit|save|create|add|search|sign in|log in|continue|run|apply|update|confirm|done|ok)\b/i;
  for (const root of [scope, activeScope(doc)].filter(Boolean) as HTMLElement[]) {
    const btn = collectItems(root).find((i) => i.kind === "button" && !i.disabled && verbs.test(i.name));
    if (btn) { activate(btn.el); return { ok: true, via: btn.name }; }
  }
  return { ok: false };
}

// ------------------------------------------------------------------------------------------------------ reading

export function pageHeading(doc: Document = document): string {
  const h1 = doc.querySelector("main h1, h1");
  return collapse(h1 ? textOf(h1, true) : "") || doc.title.replace(/\s*[|·—-]\s*LEXA.*$/i, "").trim() || "this page";
}

function walkerText(root: Element): string {
  const blocks = new Set(["p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "div", "section", "article", "td", "th", "pre", "dt", "dd"]);
  const lines: string[] = [];
  let cur = "";
  const flush = () => { const t = collapse(cur); if (t) lines.push(t); cur = ""; };
  const visit = (n: Node) => {
    if (n.nodeType === 3) { cur += n.textContent ?? ""; return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.localName.toLowerCase();
    if (["script", "style", "svg", "template", "button", "input", "select", "textarea"].includes(tag)) return;
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden") || el.closest(VOICE_UI)) return;
    const block = blocks.has(tag);
    if (block) flush();
    el.childNodes.forEach(visit);
    if (block) flush();
  };
  visit(root);
  flush();
  return lines.join("\n");
}

export interface PageSummary {
  heading: string;
  sections: string[];
  /** Visible text, one line per block, voice UI excluded. */
  lines: string[];
  counts: { buttons: number; links: number; fields: number };
}

export function pageSummary(doc: Document = document): PageSummary {
  const main = (doc.querySelector("main") as HTMLElement | null) ?? doc.body;
  const scope = activeScope(doc);
  const root = scope === doc.body ? main : scope;
  const raw = walkerText(root);
  const lines = raw.split("\n").map((l) => l.trim()).filter((l, i, a) => l.length > 1 && l !== a[i - 1]);
  const heading = pageHeading(doc);
  const sections = Array.from(root.querySelectorAll("h2, h3")).filter((h) => isVisible(h)).map((h) => collapse(textOf(h, true)))
    .filter(Boolean).slice(0, 8);
  const items = collectItems(root);
  return {
    heading, sections,
    lines: lines.filter((l) => l !== heading),
    counts: {
      buttons: items.filter((i) => i.kind === "button" || i.kind === "tab" || i.kind === "menuitem").length,
      links: items.filter((i) => i.kind === "link").length,
      fields: items.filter((i) => ["field", "select", "checkbox", "switch", "radio"].includes(i.kind)).length,
    },
  };
}

export function describeItem(i: Item, withContext = false): string {
  const parts = [i.name || "unlabelled", KIND_LABEL[i.kind]];
  if (i.checked !== undefined) parts.push(i.checked ? "on" : "off");
  if (i.selected) parts.push("selected");
  if (i.expanded !== undefined) parts.push(i.expanded ? "expanded" : "collapsed");
  if (i.disabled) parts.push("unavailable");
  let text = parts.join(", ");
  if (withContext && i.context && !i.name.toLowerCase().includes(i.context.toLowerCase())) text += `, in ${i.context}`;
  return text;
}

/** Spoken list of what can be operated. Fields and links are summarised so the list stays short. */
export function describeActions(items: Item[], max = 10): { text: string; shown: Item[] } {
  const usable = items.filter((i) => i.name && !i.disabled && i.kind !== "file");
  const primary = usable.filter((i) => i.kind !== "link" && i.kind !== "field");
  const fields = usable.filter((i) => i.kind === "field" || i.kind === "select").slice(0, 5);
  const links = usable.filter((i) => i.kind === "link");
  const shown = [...primary.slice(0, max), ...fields.slice(0, 3)];
  const bits: string[] = [];
  if (primary.length) bits.push(`${primary.slice(0, max).map((i) => describeItem(i)).join("; ")}${primary.length > max ? `; and ${primary.length - max} more` : ""}`);
  if (fields.length) bits.push(`Fields: ${fields.map((i) => i.name).join(", ")}`);
  if (links.length) bits.push(`${links.length} link${links.length === 1 ? "" : "s"}, for example ${links.slice(0, 3).map((i) => i.name).join(", ")}`);
  return { text: bits.length ? bits.join(". ") : "I can't find anything to operate here.", shown };
}

// ----------------------------------------------------------------------------------------------------- scrolling

function scrollerFor(doc: Document): Element {
  const x = Math.floor((doc.defaultView?.innerWidth ?? 800) / 2);
  const y = Math.floor((doc.defaultView?.innerHeight ?? 600) / 2);
  let el: Element | null = doc.elementFromPoint?.(x, y) ?? null;
  for (; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) return el;
  }
  return doc.scrollingElement ?? doc.documentElement;
}

export function scrollPage(dir: "up" | "down" | "top" | "bottom", doc: Document = document): string {
  const el = scrollerFor(doc);
  const page = Math.max(120, Math.round((el === doc.scrollingElement ? (doc.defaultView?.innerHeight ?? 600) : el.clientHeight) * 0.8));
  const max = el.scrollHeight - el.clientHeight;
  const before = el.scrollTop;
  const to = dir === "top" ? 0 : dir === "bottom" ? max : dir === "up" ? before - page : before + page;
  el.scrollTo?.({ top: Math.max(0, Math.min(max, to)), behavior: "auto" });
  if (!el.scrollTo) el.scrollTop = Math.max(0, Math.min(max, to));
  if (max <= 4) return "There is nothing to scroll here.";
  if (dir === "top" || (dir === "up" && to <= 0)) return "At the top.";
  if (dir === "bottom" || (dir === "down" && to >= max)) return "At the bottom.";
  return dir === "up" ? "Scrolled up." : "Scrolled down.";
}

/** Short description of a dialog that just opened: its title and the fields it asks for. */
export function describeDialog(scope: HTMLElement): string {
  const title = collapse(textOf(scope.querySelector("[role=heading], h1, h2, h3, [data-title]") ?? scope, true)).slice(0, 80);
  const items = collectItems(scope);
  const fields = items.filter((i) => i.kind === "field" || i.kind === "select").map((i) => i.name).filter(Boolean);
  const buttons = items.filter((i) => i.kind === "button" && i.name).map((i) => i.name);
  const bits = [title ? `Dialog: ${title}.` : "A dialog opened."];
  if (fields.length) bits.push(`It asks for ${fields.slice(0, 5).join(", ")}.`);
  if (buttons.length) bits.push(`Buttons: ${buttons.slice(0, 4).join(", ")}.`);
  return bits.join(" ");
}
