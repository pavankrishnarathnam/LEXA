import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import {
  accessibleName, activate, activeScope, approvalIdOf, chooseOption, closeTopmost, collectItems, describeActions,
  describeDialog, describeItem, fieldValue, isChecked, isDestructive, matchTarget, normalizeSpokenValue, pageSummary, scoreName,
  setChecked, setValue, submitNearest, type Item,
} from "@/lib/voice/dom-actions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "@/components/ui/dropdown";
import { Field, Input, Select } from "@/components/ui/input";

beforeAll(() => {
  // Radix popper/measure helpers that jsdom does not implement.
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

const html = (s: string) => { document.body.innerHTML = s; };
// React flushes state caused by native events only inside act().
const press = (el: HTMLElement) => { act(() => { activate(el); }); };
const setState = (item: Item, on: boolean | null) => { let r!: ReturnType<typeof setChecked>; act(() => { r = setChecked(item, on); }); return r; };
const names = (items: Item[]) => items.map((i) => i.name);
const find = (spoken: string, opts?: Parameters<typeof matchTarget>[2]) => matchTarget(collectItems(document.body), spoken, opts);
const one = (spoken: string, opts?: Parameters<typeof matchTarget>[2]) => {
  const m = find(spoken, opts);
  if (m.type !== "one") throw new Error(`expected one match for "${spoken}", got ${m.type}`);
  return m.item;
};

describe("accessible names", () => {
  it("follows aria-labelledby, aria-label, labels, placeholder and text", () => {
    html(`
      <span id="n">Billing name</span>
      <input id="a" aria-labelledby="n">
      <button id="b" aria-label="Open menu"><svg aria-hidden="true"></svg></button>
      <label>Email address <input id="c" type="email"></label>
      <label for="d">Search jobs</label><input id="d">
      <input id="e" placeholder="Type here">
      <a id="f" href="/x"> Task   center </a>
      <input id="g" type="submit" value="Save changes">
    `);
    const n = (id: string) => accessibleName(document.getElementById(id)!);
    expect(n("a")).toBe("Billing name");
    expect(n("b")).toBe("Open menu");
    expect(n("c")).toBe("Email address");
    expect(n("d")).toBe("Search jobs");
    expect(n("e")).toBe("Type here");
    expect(n("f")).toBe("Task center");
    expect(n("g")).toBe("Save changes");
  });

  it("does not include a select's options in its label", () => {
    html(`<label><span>Range</span><select><option>Last 7 days</option><option>Last 30 days</option></select></label>`);
    expect(accessibleName(document.querySelector("select")!)).toBe("Range");
  });
});

describe("collecting what can be operated", () => {
  it("lists visible controls only and skips hidden / aria-hidden / voice UI", () => {
    html(`
      <button>Visible</button>
      <button hidden>Hidden attribute</button>
      <div style="display:none"><button>Display none</button></div>
      <div aria-hidden="true"><button>Aria hidden</button></div>
      <div data-voice-ui><button>Stop listening</button></div>
      <input type="hidden" name="csrf">
      <button disabled>Disabled one</button>
    `);
    const items = collectItems(document.body);
    expect(names(items)).toEqual(["Visible", "Disabled one"]);
    expect(items[1].disabled).toBe(true);
  });

  it("classifies kinds and states", () => {
    html(`
      <button role="switch" aria-checked="true" aria-label="Auto memory"></button>
      <button role="tab" aria-selected="true">Usage</button>
      <button aria-expanded="false">Show details</button>
      <input type="checkbox" checked aria-label="Pinned">
      <button aria-pressed="true">Speak responses</button>
      <a href="/tasks">Tasks</a>
      <textarea aria-label="Message"></textarea>
    `);
    const items = collectItems(document.body);
    const by = (n: string) => items.find((i) => i.name === n)!;
    expect(by("Auto memory")).toMatchObject({ kind: "switch", checked: true });
    expect(by("Usage")).toMatchObject({ kind: "tab", selected: true });
    expect(by("Show details")).toMatchObject({ kind: "button", expanded: false });
    expect(by("Pinned")).toMatchObject({ kind: "checkbox", checked: true });
    expect(by("Speak responses")).toMatchObject({ kind: "button", checked: true });
    expect(by("Tasks").kind).toBe("link");
    expect(by("Message").kind).toBe("field");
    expect(describeItem(by("Auto memory"))).toBe("Auto memory, switch, on");
    expect(describeItem(by("Show details"))).toBe("Show details, button, collapsed");
  });

  it("collapses duplicate links (same label and target) but keeps different ones", () => {
    html(`<a href="/tasks">Tasks</a><a href="/tasks">Tasks</a><a href="/tasks?x=1">Tasks</a>`);
    expect(collectItems(document.body)).toHaveLength(2);
  });

  it("scopes to the open dialog so the page behind cannot be clicked", () => {
    html(`<button>Behind</button><div role="dialog" aria-label="Create"><button>Save</button></div>`);
    const scope = activeScope();
    expect(scope.getAttribute("role")).toBe("dialog");
    expect(names(collectItems(scope))).toEqual(["Save"]);
    expect(describeDialog(scope)).toContain("Buttons: Save");
  });
});

describe("matching what was said to a control", () => {
  it("scores exact > phrase > words > fuzzy", () => {
    expect(scoreName("Create agent", "create agent")).toBe(100);
    expect(scoreName("Create agent", "agent")).toBeGreaterThan(80);
    expect(scoreName("Approve & run", "approve and run")).toBe(100);
    expect(scoreName("Approve & run", "approve")).toBeGreaterThan(80);
    expect(scoreName("Create agent", "agent create")).toBeGreaterThan(70);
    expect(scoreName("Settings", "settngs")).toBeGreaterThanOrEqual(50);
    expect(scoreName("Settings", "billing")).toBe(0);
  });

  it("finds a unique control by a partial spoken name", () => {
    html(`<button>Create agent</button><button>Cancel</button><button>Approve &amp; run</button><a href="/a">Agents</a>`);
    expect(one("create agent").name).toBe("Create agent");
    expect(one("approve").name).toBe("Approve & run");
    expect(one("cancel").name).toBe("Cancel");
  });

  it("asks when several controls match equally (and lists them with their context)", () => {
    html(`<ul>
      <li><strong>Weekly review</strong><button>Delete</button></li>
      <li><strong>Inbox triage</strong><button>Delete</button></li></ul>`);
    const m = find("delete");
    expect(m.type).toBe("many");
    if (m.type === "many") {
      expect(m.items.map((i) => i.context)).toEqual(["Weekly review", "Inbox triage"]);
      expect(describeItem(m.items[1], true)).toBe("Delete, button, in Inbox triage");
    }
  });

  it("uses the control-type hint to disambiguate", () => {
    html(`<a href="/t">Tasks</a><button role="tab">Tasks</button>`);
    expect(one("tasks", { kind: "tab" }).kind).toBe("tab");
    expect(one("tasks", { kind: "link" }).kind).toBe("link");
  });

  it("supports ordinals within a kind", () => {
    html(`<div role="tablist"><button role="tab">Alpha</button><button role="tab">Beta</button><button role="tab">Gamma</button></div>`);
    expect(one("second", { kind: "tab" }).name).toBe("Beta");
    expect(one("last", { kind: "tab" }).name).toBe("Gamma");
    expect(one("3rd", { kind: "tab" }).name).toBe("Gamma");
  });

  it("returns none rather than guessing", () => {
    html(`<button>Save</button>`);
    expect(find("launch the missiles").type).toBe("none");
  });

  it("ignores disabled controls unless nothing else exists", () => {
    html(`<button disabled>Send</button><button>Send now</button>`);
    expect(one("send").name).toBe("Send now");
    html(`<button disabled>Send</button>`);
    expect(one("send").name).toBe("Send");
  });

  it("flags destructive names", () => {
    expect(isDestructive("Delete automation")).toBe(true);
    expect(isDestructive("Disconnect Gmail")).toBe(true);
    expect(isDestructive("Sign out")).toBe(true);
    expect(isDestructive("Create agent")).toBe(false);
  });

  it("recognises the approval card a control belongs to", () => {
    html(`<div data-approval-id="abc"><button>Approve</button></div><button>Other</button>`);
    expect(approvalIdOf(one("approve").el)).toBe("abc");
    expect(approvalIdOf(one("other").el)).toBeNull();
  });
});

describe("acting on controls", () => {
  it("activate() sends the whole gesture once", () => {
    html(`<button id="x">Go</button>`);
    const b = document.getElementById("x")!;
    const seen: string[] = [];
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) b.addEventListener(t, () => seen.push(t));
    activate(b);
    expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  });

  it("types into controlled React inputs, so state follows", () => {
    function Form() {
      const [v, setV] = useState("");
      return <div><label>Agent name<input value={v} onChange={(e) => setV(e.target.value)} /></label><output>{v}</output></div>;
    }
    const { container } = render(<Form />);
    const input = container.querySelector("input")!;
    setValue(input, "Travel Planner");
    expect(container.querySelector("output")!.textContent).toBe("Travel Planner");
    setValue(input, "and Budget", true);
    expect(input.value).toBe("Travel Planner and Budget");
    expect(fieldValue(input)).toBe("Travel Planner and Budget");
  });

  it("chooses an option by name, number or loose match", () => {
    const { container } = render(<Select aria-label="Range"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></Select>);
    const sel = container.querySelector("select")!;
    expect(chooseOption(sel, "last 90 days")).toMatchObject({ ok: true, label: "Last 90 days" });
    expect(sel.value).toBe("90");
    expect(chooseOption(sel, "first").label).toBe("Last 7 days");
    expect(chooseOption(sel, "thirty")).toMatchObject({ ok: false });
    expect(chooseOption(sel, "30").ok).toBe(true);
  });

  it("cleans spoken values by field type", () => {
    expect(normalizeSpokenValue("jo at example dot com", "email")).toBe("jo@example.com");
    expect(normalizeSpokenValue("1,250", "number")).toBe("1250");
    expect(normalizeSpokenValue("+1 (555) 010-2000", "tel")).toBe("+15550102000");
    expect(normalizeSpokenValue("Travel Planner", "text")).toBe("Travel Planner");
  });

  it("sets switches to a state, and only clicks when needed", () => {
    function S() { return <Field label="Auto memory"><Switch defaultChecked aria-label="Auto memory" /></Field>; }
    render(<S />);
    const item = one("auto memory");
    expect(item.checked).toBe(true);
    expect(setState(item, true)).toEqual({ changed: false, want: true });
    expect(isChecked(one("auto memory"))).toBe(true);
    expect(setState(item, false)).toEqual({ changed: true, want: false });
    expect(isChecked(one("auto memory"))).toBe(false);
    expect(setState(one("auto memory"), null)).toEqual({ changed: true, want: true });
    expect(isChecked(one("auto memory"))).toBe(true);
  });

  it("submits the focused field's form, else the nearby primary button", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    html(`<form id="f"><input aria-label="Command"><button type="submit">Run</button></form>`);
    (document.getElementById("f") as HTMLFormElement).addEventListener("submit", onSubmit);
    HTMLFormElement.prototype.requestSubmit ??= function (this: HTMLFormElement) { this.dispatchEvent(new Event("submit", { cancelable: true })); };
    (document.querySelector("input") as HTMLInputElement).focus();
    expect(submitNearest()).toEqual({ ok: true, via: "form" });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    html(`<section><textarea aria-label="Message"></textarea><button id="s">Send</button></section>`);
    const clicked = vi.fn();
    document.getElementById("s")!.addEventListener("click", clicked);
    (document.querySelector("textarea") as HTMLTextAreaElement).focus();
    expect(submitNearest().ok).toBe(true);
    expect(clicked).toHaveBeenCalled();
  });
});

describe("works against the real Radix components used in the app", () => {
  it("switches tabs (Radix activates on mousedown/focus, not click)", () => {
    function T() {
      return (
        <Tabs defaultValue="a">
          <TabsList><TabsTrigger value="a">Permissions</TabsTrigger><TabsTrigger value="b">Usage</TabsTrigger></TabsList>
          <TabsContent value="a">First panel</TabsContent>
          <TabsContent value="b">Second panel</TabsContent>
        </Tabs>
      );
    }
    const { container } = render(<T />);
    expect(container.textContent).toContain("First panel");
    press(one("usage", { kind: "tab" }).el);
    expect(container.textContent).toContain("Second panel");
    expect(one("usage", { kind: "tab" }).selected).toBe(true);
  });

  it("opens a dialog, scopes to it, and closes it", () => {
    function D() {
      return (
        <Dialog>
          <DialogTrigger asChild><button>New thing</button></DialogTrigger>
          <DialogContent title="Create thing" description="Give it a name">
            <Field label="Name"><Input /></Field>
            <button>Save thing</button>
          </DialogContent>
        </Dialog>
      );
    }
    render(<D />);
    press(one("new thing").el);
    const scope = activeScope();
    expect(scope.getAttribute("role")).toBe("dialog");
    const summary = describeDialog(scope);
    expect(summary).toContain("Create thing");
    expect(summary).toContain("Name");
    expect(names(collectItems(scope))).toContain("Save thing");
    let closed = false;
    act(() => { closed = closeTopmost(); });
    expect(closed).toBe(true);
    expect(activeScope()).toBe(document.body);
  });

  it("opens a dropdown menu and selects an item", () => {
    const picked = vi.fn();
    function M() {
      return (
        <Dropdown>
          <DropdownTrigger aria-label="Account menu">Account</DropdownTrigger>
          <DropdownContent><DropdownItem onSelect={picked}>Sign out</DropdownItem><DropdownItem>Settings</DropdownItem></DropdownContent>
        </Dropdown>
      );
    }
    render(<M />);
    press(one("account menu").el);
    expect(activeScope().getAttribute("role")).toBe("menu");
    const item = collectItems(activeScope()).find((i) => i.name === "Sign out")!;
    expect(item.kind).toBe("menuitem");
    press(item.el);
    expect(picked).toHaveBeenCalledTimes(1);
  });
});

describe("reading the page", () => {
  it("summarises headings, text and control counts, leaving out voice UI and buttons' labels", () => {
    html(`
      <main><h1>Task center</h1><h2>Active</h2><p>Two tasks are running.</p><ul><li>Research competitors</li><li>Draft reply</li></ul>
      <h2>Finished</h2><p>Nothing yet.</p><button>Refresh</button><a href="/x">Open</a><input aria-label="Filter"></main>
      <div data-voice-ui><p>Listening</p></div>`);
    const s = pageSummary();
    expect(s.heading).toBe("Task center");
    expect(s.sections).toEqual(["Active", "Finished"]);
    expect(s.lines).toEqual(expect.arrayContaining(["Two tasks are running.", "Research competitors", "Nothing yet."]));
    expect(s.lines.join(" ")).not.toMatch(/Listening|Refresh/);
    expect(s.counts).toEqual({ buttons: 1, links: 1, fields: 1 });
  });

  it("describes available actions compactly", () => {
    html(`<main><button>Create agent</button><button>Import</button><a href="/a">Agent one</a><a href="/b">Agent two</a><input aria-label="Search"></main>`);
    const { text } = describeActions(collectItems(document.body));
    expect(text).toContain("Create agent, button; Import, button");
    expect(text).toContain("Fields: Search");
    expect(text).toContain("2 links");
  });
});
