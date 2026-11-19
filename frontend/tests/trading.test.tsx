import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Linked, isSafeLink } from "@/components/trading/job-output";
import { RulesPanel, rulesPayload } from "@/components/trading/rules-panel";
import { ToolPanel, buildArgs, type FieldDef } from "@/components/trading/tool-panel";
import type { RuleRow, TradingStatus } from "@/components/trading/types";
import { api, del, get, post, put } from "@/services/api";
import TradingPage from "@/app/(app)/trading/page";

vi.mock("@/services/api", () => ({ api: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1", tool: "trader_scan", args: {}, status: "running", content: "", is_error: false, untrusted: false,
  started_at: Date.now() / 1000, finished_at: null, seconds: null, ...over,
});

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.mocked(get).mockReset().mockRejectedValue(new Error("none")); // no earlier result unless a test says otherwise
  vi.mocked(post).mockReset();
  vi.mocked(put).mockReset().mockResolvedValue({});
  vi.mocked(del).mockReset().mockResolvedValue(undefined);
  vi.mocked(api).mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const FIELDS: FieldDef[] = [
  { kind: "select", name: "mode", label: "Mode", options: [{ value: "daily", label: "Daily" }, { value: "orb", label: "Breakouts" }] },
  { kind: "list", name: "symbols", label: "Tickers", upper: true },
  { kind: "list", name: "members", label: "Members", split: "comma" },
  { kind: "number", name: "show", label: "How many" },
  { kind: "text", name: "stop", label: "Stop" },
  { kind: "text", name: "symbol", label: "Ticker", upper: true },
  { kind: "check", name: "only_new", label: "Only new" },
  { kind: "check", name: "include_sec_filings", label: "Headlines only", invert: true },
];

describe("buildArgs", () => {
  it("builds the tool's arguments and leaves empty boxes out so the tool's defaults apply", () => {
    expect(buildArgs(FIELDS, form({ mode: "orb", symbols: " tsla, nvda  amd ", members: "Nancy Pelosi, Pelosi", show: "10",
      stop: " or-mid ", symbol: "tsla", only_new: "on", include_sec_filings: "on" }), { action: "x" })).toEqual({
      action: "x", mode: "orb", symbols: ["TSLA", "NVDA", "AMD"], members: ["Nancy Pelosi", "Pelosi"], show: 10, stop: "or-mid",
      symbol: "TSLA", only_new: true, include_sec_filings: false,
    });
    expect(buildArgs(FIELDS, form({ mode: "", symbols: "  ", show: "", stop: "", symbol: "" }))).toEqual({});
    expect(buildArgs(FIELDS, form({ show: "abc" }))).toEqual({}); // not a number: dropped, the server would refuse it anyway
  });
});

describe("links in results", () => {
  it("only turns public market-data sites into links", () => {
    for (const ok of ["https://finance.yahoo.com/markets/a", "https://www.sec.gov/Archives/x.htm",
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/1.pdf"]) expect(isSafeLink(ok)).toBe(true);
    for (const bad of ["http://finance.yahoo.com/x", "https://evil.example/x", "javascript:alert(1)", "https://user:pw@www.sec.gov/x",
      "https://www.sec.gov.evil.example/x", "https://sec.gov@evil.example/x", "not a url"]) expect(isSafeLink(bad)).toBe(false);
    render(<Linked text={'Tesla https://finance.yahoo.com/a?b=1 and https://evil.example/x <img src=x onerror=alert(1)>'} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://finance.yahoo.com/a?b=1");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(document.querySelector("img")).toBeNull(); // text stays text
    expect(screen.getByText(/https:\/\/evil\.example\/x/)).toBeTruthy();
  });
});

describe("ToolPanel", () => {
  it("starts the analysis on the server, follows it and shows the result (no AI model involved)", async () => {
    vi.useFakeTimers();
    vi.mocked(post).mockResolvedValue(job());
    vi.mocked(get).mockImplementation(async (url: string) => {
      if (url.startsWith("/api/trading/jobs/latest")) throw new Error("none");
      return job({ status: "done", content: "2 charts matched a rule.\n  BAC  $51.23  oversold", finished_at: Date.now() / 1000, seconds: 1.2, untrusted: true });
    });
    render(<ToolPanel tool="trader_scan" title="Scan for setups" slow runLabel="Scan" fields={FIELDS} />);
    fireEvent.change(screen.getByLabelText("Tickers"), { target: { value: "bac, xom" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(post).toHaveBeenCalledWith("/api/trading/jobs", { tool: "trader_scan", args: { mode: "daily", symbols: ["BAC", "XOM"] } });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Running");
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    const out = screen.getByRole("region", { name: "Scan for setups: output" });
    expect(out.textContent).toContain("2 charts matched a rule.");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText(/from public market data/)).toBeTruthy();
  });

  it("stops a running analysis", async () => {
    vi.useFakeTimers();
    vi.mocked(post).mockResolvedValue(job());
    vi.mocked(get).mockImplementation(async (url: string) => {
      if (url.startsWith("/api/trading/jobs/latest")) throw new Error("none");
      return job();
    });
    render(<ToolPanel tool="trader_scan" title="Scan" fields={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(del).toHaveBeenCalledWith("/api/trading/jobs/j1");
  });

  it("shows a refusal from the server instead of failing silently", async () => {
    vi.mocked(post).mockRejectedValue(new Error("Several analyses are already running. Wait for one to finish, or stop it."));
    render(<ToolPanel tool="trader_quote" title="Quotes" fields={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already running");
  });

  it("brings back the latest result after a reload", async () => {
    vi.mocked(get).mockResolvedValue(job({ status: "done", content: "TSLA   $366.48", finished_at: 1_700_000_000, started_at: 1_700_000_000, seconds: 0.3 }));
    render(<ToolPanel tool="trader_quote" title="Quotes" fields={[]} />);
    expect((await screen.findByRole("region", { name: "Quotes: output" })).textContent).toContain("TSLA   $366.48");
    expect(get).toHaveBeenCalledWith("/api/trading/jobs/latest?tool=trader_quote");
  });

  it("will not size a trade until the user has set their own numbers", () => {
    const onNeed = vi.fn();
    render(<ToolPanel tool="trader_size" title="How many shares" needsRules rulesReady={false} onNeedRules={onNeed} />);
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Set my rules" }));
    expect(onNeed).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

const DEFAULTS: [string, unknown][] = [
  ["budget", null], ["max_loss_per_trade_usd", 50], ["max_daily_loss_usd", 150], ["max_position_pct", 75], ["cash_buffer_pct", 10],
  ["max_order_usd", 4000], ["min_order_usd", 5], ["max_trades_per_day", 3], ["max_orders_per_day", 10], ["min_reward_risk", 1],
  ["no_entries_before", "09:45"], ["no_entries_after", "15:30"], ["flat_by", "15:55"], ["blocked", []], ["pdt_guard", false],
];
const rows = (set: Record<string, unknown> = {}): RuleRow[] => DEFAULTS.map(([rule, def]) =>
  ({ rule, value: rule in set ? set[rule] : def, source: rule in set ? "set by you" : "default", meaning: "" }));

const status = (over: Partial<TradingStatus> = {}): TradingStatus => ({
  llm_required: false, market: { text: "New York 2026-10-19 10:15 (Monday): NYSE OPEN, regular session.", open: true },
  rules: rows(), missing: ["budget", "max_loss_per_trade_usd"], fixed: ["Paper trading only", "LEXA never places an order"],
  sec_contact: { value: null, source: null, configured: false }, pdftotext: false, tools: ["trader_scan"], ...over,
});

describe("rules", () => {
  it("sends what was filled in and puts emptied rules back to their default", () => {
    const set = rows({ budget: 5000, max_loss_per_trade_usd: 40, blocked: ["TSLA"], pdt_guard: true });
    expect(rulesPayload(set, form({ budget: "6000", max_loss_per_trade_usd: "", blocked: "TSLA, GME", max_daily_loss_usd: "100" }))).toEqual({
      values: { budget: 6000, blocked: "TSLA, GME", max_daily_loss_usd: 100 },
      reset: ["max_loss_per_trade_usd", "pdt_guard"],
    });
    expect(rulesPayload(rows(), form({}))).toEqual({ values: {}, reset: [] });
  });

  it("saves the user's own numbers directly and says what is still missing", async () => {
    const onChanged = vi.fn();
    render(<RulesPanel status={status()} onChanged={onChanged} />);
    expect(screen.getByText(/Still needed: budget, max loss per trade usd/)).toBeTruthy();
    expect(screen.getByLabelText("Largest position (% of account)").getAttribute("placeholder")).toBe("75"); // the default is shown, not stored
    fireEvent.change(screen.getByLabelText("Budget ($)"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Most you accept to lose on one trade ($)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save my rules" }));
    await act(async () => { await Promise.resolve(); });
    expect(put).toHaveBeenCalledWith("/api/trading/rules", { values: { budget: 5000, max_loss_per_trade_usd: 50 }, reset: [] });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText("Paper trading only")).toBeTruthy();
  });

  it("shows the server's reason when a rule is refused", async () => {
    vi.mocked(put).mockRejectedValue(new Error("max_loss_per_trade_usd cannot be more than the budget"));
    render(<RulesPanel status={status()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Budget ($)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save my rules" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be more than the budget");
  });

  it("saves and removes the user's own SEC contact", async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<RulesPanel status={status()} onChanged={onChanged} />);
    expect(screen.getByText(/SEC filings and earnings are skipped/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your name and email"), { target: { value: "Jane Doe jane@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await act(async () => { await Promise.resolve(); });
    expect(put).toHaveBeenCalledWith("/api/trading/sec-contact", { value: "Jane Doe jane@example.org" });
    rerender(<RulesPanel status={status({ sec_contact: { value: "Jane Doe jane@example.org", source: "you", configured: true } })} onChanged={onChanged} />);
    expect(screen.getByText("Using your contact.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await act(async () => { await Promise.resolve(); });
    expect(put).toHaveBeenLastCalledWith("/api/trading/sec-contact", { value: null });
  });
});

describe("Trading page", () => {
  it("opens without any AI key, explains its limits and sends the user to their rules", async () => {
    vi.mocked(api).mockResolvedValue(status());
    render(<TradingPage />);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("Trading desk");
    expect(screen.getByText("No AI key needed.")).toBeTruthy();
    expect(screen.getByText(/LEXA never places an order/, { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Market open")).toBeTruthy();
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/trading/status");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Nothing is guessed for you");
    expect(screen.getByRole("tab", { name: "Find setups" }).getAttribute("data-state")).toBe("active");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "My rules" }));
    expect(await screen.findByRole("form", { name: "My trading rules" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Find setups" }));
    fireEvent.click(within(note).getByRole("button", { name: "Set my rules" }));
    expect(await screen.findByRole("form", { name: "My trading rules" })).toBeTruthy();
  });

  it("does not nag once the rules are set", async () => {
    vi.mocked(api).mockResolvedValue(status({ rules: rows({ budget: 5000, max_loss_per_trade_usd: 50 }), missing: [], market: { text: "NYSE closed.", open: false } }));
    render(<TradingPage />);
    expect(await screen.findByText("Market closed")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
