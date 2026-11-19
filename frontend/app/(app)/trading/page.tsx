"use client";
import { RefreshCw, TrendingUp } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RulesPanel } from "@/components/trading/rules-panel";
import { ToolPanel, type FieldDef } from "@/components/trading/tool-panel";
import type { TradingStatus } from "@/components/trading/types";
import { useApi } from "@/hooks/use-api";

const tickers = (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ kind: "list", name, label, upper: true, placeholder: "TSLA, NVDA, AMD", ...extra }) as FieldDef;

const SCAN: FieldDef[] = [
  { kind: "select", name: "mode", label: "What to look for", options: [
    { value: "daily", label: "Setups from daily closes (before the open)" },
    { value: "orb", label: "Opening-range breakouts (after 9:50 AM New York)" }] },
  tickers("symbols", "Tickers", { placeholder: "TSLA, NVDA, AMD. Empty = the whole US market", hint: "A short list is fast; the whole market takes minutes." }),
  { kind: "text", name: "at", label: "Breakouts: as of (New York HH:MM)", placeholder: "10:15" },
  { kind: "number", name: "min_price", label: "Ignore stocks under ($)", min: 0, placeholder: "5" },
  { kind: "number", name: "show", label: "Hits to list", step: "1", min: 1, placeholder: "25" },
];
const QUOTE: FieldDef[] = [tickers("symbols", "Tickers", { required: true, hint: "Up to 20" })];
const NEWS: FieldDef[] = [
  tickers("tickers", "Tickers", { placeholder: "Empty = my watchlist, plan and portfolio" }),
  { kind: "number", name: "hours", label: "Look back (hours)", min: 1, placeholder: "48" },
  { kind: "check", name: "only_new", label: "Only what is new since my last check" },
  { kind: "check", name: "include_sec_filings", label: "Headlines only (skip SEC filings)", invert: true },
];
const EARNINGS: FieldDef[] = [tickers("tickers", "Tickers (up to 3)", { required: true, placeholder: "AAPL" })];
const CONGRESS: FieldDef[] = [
  { kind: "list", name: "members", label: "Members of Congress", split: "comma", placeholder: "Pelosi, Nancy Pelosi" },
  { kind: "text", name: "since", label: "Filed since", type: "date" },
  { kind: "number", name: "year", label: "Year", step: "1", min: 2012, placeholder: "this year" },
  { kind: "check", name: "only_new", label: "Only filings I have not seen yet" },
  { kind: "text", name: "report_id", label: "Read one filing (document id)", placeholder: "20035143", hint: "Needs pdftotext on the server" },
];
const ENTRY: FieldDef[] = [
  { kind: "text", name: "symbol", label: "Ticker", upper: true, placeholder: "TSLA" },
  { kind: "check", name: "watchlist", label: "Check every ticker on my watchlist instead" },
  { kind: "select", name: "setup", label: "Setup", options: [{ value: "", label: "Opening-range breakout" }, { value: "level", label: "Close above a level" }] },
  { kind: "number", name: "level", label: "Level (for “close above a level”)", min: 0 },
  { kind: "number", name: "or_minutes", label: "Opening range (minutes)", step: "1", min: 5, placeholder: "15" },
];
const EXIT: FieldDef[] = [
  { kind: "check", name: "show", label: "Only show my saved plan" },
  { kind: "text", name: "symbol", label: "Ticker (if not from the entry check)", upper: true },
  { kind: "number", name: "entry", label: "Entry price", min: 0 },
  { kind: "text", name: "stop", label: "Stop", placeholder: "or-mid · or-low · price:358.5 · pct:1.5 · atr:1.5" },
  { kind: "text", name: "target", label: "Target", placeholder: "2R · 1R · 1.5R · price:375" },
  { kind: "text", name: "flat_by", label: "Be out by (New York HH:MM)", placeholder: "15:55" },
];
const SIMULATE: FieldDef[] = [
  { kind: "number", name: "replays", label: "Replays", step: "100", min: 100, placeholder: "10000" },
  { kind: "number", name: "seed", label: "Random seed", step: "1", min: 0, placeholder: "19" },
  { kind: "text", name: "until", label: "End each replay at (New York HH:MM)", placeholder: "my flat-by time" },
];
const ALERTS: FieldDef[] = [
  { kind: "select", name: "action", label: "What to do", options: [
    { value: "list", label: "Show my alerts" }, { value: "check", label: "Check them now" }, { value: "add", label: "Add an alert" }] },
  { kind: "text", name: "symbol", label: "Ticker (price alerts)", upper: true },
  { kind: "number", name: "above", label: "Price at or above", min: 0 },
  { kind: "number", name: "below", label: "Price at or below", min: 0 },
  { kind: "number", name: "stop", label: "Stop price", min: 0 },
  { kind: "number", name: "target", label: "Target price", min: 0 },
  { kind: "number", name: "pct", label: "Move from previous close (%)", min: 0 },
  { kind: "text", name: "at_time", label: "At a time (New York HH:MM)" },
  { kind: "check", name: "opening_bell", label: "At the opening bell" },
  { kind: "check", name: "from_plan", label: "Stop, target and flat-by from my saved plan" },
  { kind: "check", name: "rearm", label: "Ring again after it has rung" },
];

export default function TradingPage() {
  const status = useApi<TradingStatus>("/api/trading/status");
  const [tab, setTab] = useState("find");
  const s = status.data;
  const rulesReady = s ? s.missing.length === 0 : true;
  const needRules = () => setTab("rules");
  const panel = { rulesReady, onNeedRules: needRules };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={TrendingUp} title="Trading desk"
        description="US stocks: find setups, read the news, plan the stop and target, size it to your limits. Analysis only." />

      <Card>
        <CardContent className="grid gap-4 pt-4 md:grid-cols-[1fr_auto]">
          <div className="space-y-1.5 text-sm">
            <p><strong>No AI key needed.</strong> Everything on this page runs on your own server with free public data. No AI model is called, so it costs nothing and works without an OpenAI key.</p>
            <p className="text-xs text-muted">
              US markets only (NYSE and Nasdaq). LEXA never places an order: you make every trade yourself, at your own broker. Data is free, unofficial and can lag by minutes.
              This is education and analysis, not financial advice, and most people who day trade lose money.
            </p>
          </div>
          <div className="min-w-56 space-y-1.5" aria-live="polite">
            {!s ? <Skeleton className="h-16" /> : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={s.market.open ? "success" : "neutral"}>{s.market.open === null ? "Market status unknown" : s.market.open ? "Market open" : "Market closed"}</Badge>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void status.reload()}><RefreshCw />Refresh</Button>
                </div>
                {s.market.text && <p className="whitespace-pre-line text-xs text-muted">{s.market.text}</p>}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {s && !rulesReady && (
        <div role="note" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span>To size a trade or check its risk, set your budget and the most you accept to lose on one trade. Nothing is guessed for you.</span>
          <Button type="button" size="sm" variant="secondary" onClick={needRules}>Set my rules</Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Trading desk sections">
          <TabsTrigger value="find">Find setups</TabsTrigger>
          <TabsTrigger value="research">Research</TabsTrigger>
          <TabsTrigger value="plan">Plan a trade</TabsTrigger>
          <TabsTrigger value="rules">My rules</TabsTrigger>
        </TabsList>

        <TabsContent value="find" className="space-y-4">
          <ToolPanel tool="trader_scan" title="Scan for setups" slow runLabel="Scan" fields={SCAN}
            description="Charts that matched a rule: a 20-day closing high, a bull flag, a reclaimed 20-day average, oversold, or an opening-range breakout. A match is not a buy." />
          <ToolPanel tool="trader_quote" title="Quotes" runLabel="Get quotes" fields={QUOTE}
            description="Delayed prices from Yahoo Finance (free, unofficial, can lag). Your broker's price is the one that fills." />
        </TabsContent>

        <TabsContent value="research" className="space-y-4">
          <ToolPanel tool="trader_news" title="News and filings" runLabel="Get the news" fields={NEWS}
            description="Headlines and SEC 8-K filings, tagged, with how far each stock is from yesterday's close. Headlines are leads, not facts: open the story before you believe it." />
          <ToolPanel tool="trader_earnings" title="Earnings check" runLabel="Check earnings" fields={EARNINGS}
            description="Reported revenue, margins and earnings per share by quarter against a year earlier, from SEC filings. Needs an SEC contact under My rules." />
          <ToolPanel tool="trader_congress_trades" title="Congress trades" runLabel="Look up filings" fields={CONGRESS}
            description="Stock trades members of the US House must disclose. Public filings made up to 45 days after the trade: not inside information, not a signal. Amounts are ranges." />
        </TabsContent>

        <TabsContent value="plan" className="space-y-4">
          <p className="text-sm text-muted">Work through these in order. The stop and target are set before you get in, never after.</p>
          <ToolPanel tool="trader_entry" title="1. Has it triggered?" runLabel="Check the entry" fields={ENTRY}
            description="Opening-range breakout timed bar by bar: waiting, triggered (time and price), expired or not open yet. Long side only." />
          <ToolPanel tool="trader_exit_plan" title="2. Stop and target" runLabel="Plan the exit" fields={EXIT}
            description="Sets the stop (the opening-range midpoint by default) and the target (2R by default) from the entry above, and refuses a stop at or above the entry." />
          <ToolPanel tool="trader_simulate" title="3. Replay the odds" runLabel="Run the time machine" fields={SIMULATE}
            description="10,000 replays of the day from the stock's own last 60 days, plus the real history of the same rule. A simulation, not a prediction." />
          <ToolPanel tool="trader_size" title="4. How many shares" runLabel="Size it" needsRules {...panel}
            description="Whole shares that fit your budget and your max loss, which limit decided, and a proposed order. Nothing is placed." />
          <ToolPanel tool="trader_risk_check" title="5. Check it against my rules" runLabel="Check the risk" needsRules {...panel}
            description="PASS or BLOCK with the reason. A PASS is a rules check, not a recommendation. LEXA cannot see trades you placed elsewhere today: count them yourself." />
          <ToolPanel tool="trader_alerts" title="6. Alerts" runLabel="Go" fields={ALERTS}
            description="Stop, target, price, percent-move and time alerts. They report when you press Go on “Check them now”; they never act." />
        </TabsContent>

        <TabsContent value="rules">
          {s ? <RulesPanel status={s} onChanged={() => void status.reload()} /> : <Skeleton className="h-96" />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
