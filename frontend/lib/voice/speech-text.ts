/** Turning LEXA's markdown replies into something pleasant to listen to, and splitting text for streaming TTS. */

const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "a website";
  }
}

/** Markdown -> plain spoken text: no symbols, tables read as lists, URLs reduced to their site, code omitted. */
export function toSpeakable(markdown: string): string {
  let t = markdown.replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?```/g, "\n(code omitted)\n");
  t = t.replace(/`([^`\n]+)`/g, "$1");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt || "image");
  t = t.replace(/\[([^\]]+)\]\([^)\s]+(?:\s+"[^"]*")?\)/g, "$1");
  t = t.replace(/<[^>\n]+>/g, " ");
  t = t.replace(/https?:\/\/[^\s)<>\]]+/g, (url) => `link to ${hostOf(url)}`);
  const lines: string[] = [];
  for (const raw of t.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    if (/^[-*_]{3,}$/.test(line)) continue; // horizontal rule
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) continue; // table separator
    if (/^\|.*\|$/.test(line)) line = line.slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    line = line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^[-*+•]\s+/, "");
    line = line
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2")
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1$2")
      .replace(/~~([^~]+)~~/g, "$1");
    line = line.replace(EMOJI, "").replace(/&/g, " and ").replace(/\s*(?:→|->)\s*/g, " to ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    lines.push(/[.!?…:;)]$/.test(line) ? line : `${line}.`);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function longSplit(sentence: string, max: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const word of sentence.split(/\s+/)) {
    if (cur && cur.length + word.length + 1 > max) {
      parts.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Splits at sentence boundaries into chunks; the first is short so audio starts quickly. */
export function splitForTts(text: string, firstMax = 240, restMax = 700): string[] {
  const sentences = (text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  let max = firstMax;
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = "";
    max = restMax;
  };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      for (const piece of longSplit(s, restMax)) chunks.push(piece);
    } else if (cur && cur.length + s.length + 1 > max) {
      flush();
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  flush();
  return chunks;
}

/** First part of a long text (cut at a sentence end) and the remainder, for "read more". */
export function takeSpoken(text: string, max = 1100): { head: string; rest: string } {
  if (text.length <= max) return { head: text, rest: "" };
  const window = text.slice(0, max);
  let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (cut < max * 0.4) cut = window.lastIndexOf(" ");
  if (cut <= 0) cut = max;
  return { head: text.slice(0, cut + 1).trim(), rest: text.slice(cut + 1).trim() };
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timeText(h: number, m: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function parseDays(expr: string): number[] | null {
  const days = new Set<number>();
  for (const part of expr.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7);
    } else if (/^\d$/.test(part)) days.add(Number(part) % 7);
    else return null;
  }
  return [...days].sort((a, b) => a - b);
}

/** Plain-English version of common cron expressions, or null when it is not one we can describe safely. */
export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const every = (s: string) => s.match(/^\*\/(\d+)$/)?.[1];
  if (every(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${every(min)} minutes`;
  if (min === "0" && every(hour) && dom === "*" && mon === "*" && dow === "*") return `every ${every(hour)} hours`;
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return "every hour";
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || mon !== "*") return null;
  const time = timeText(Number(hour), Number(min));
  if (dom === "*" && dow === "*") return `every day at ${time}`;
  if (dom === "*") {
    const days = parseDays(dow);
    if (!days?.length) return null;
    const key = days.join(",");
    if (key === "1,2,3,4,5") return `every weekday at ${time}`;
    if (key === "0,6") return `every Saturday and Sunday at ${time}`;
    const names = days.map((d) => DOW[d]);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    return `every ${list} at ${time}`;
  }
  if (dow === "*" && /^\d+$/.test(dom)) return `on the ${ordinal(Number(dom))} of every month at ${time}`;
  return null;
}

const TOOL_LABELS: Record<string, string> = {
  gmail_send: "send an email",
  gmail_create_draft: "create an email draft",
  whatsapp_send: "send a WhatsApp message",
  sms_send: "send a text message",
  calendar_create_event: "create a calendar event",
  github_create_branch: "create a GitHub branch",
  github_create_issue: "open a GitHub issue",
  github_create_pull_request: "open a pull request",
  automation_create: "create an automation",
  n8n_trigger_workflow: "run an n8n workflow",
  mcp_call_tool: "call an external tool",
  application_submit_email: "submit a job application by email",
};

export interface ApprovalLike {
  agent: string;
  tool: string;
  summary: string;
  risk_level: string;
}

/** A one-line tool summary (approval text, notification title) turned into something pleasant to hear. */
export function speakableSummary(text: string): string {
  const withCron = text.replace(/ on cron `([^`]+)`/g, (_m, expr: string) => {
    const d = describeCron(expr);
    return d ? `, running ${d}` : ` on schedule ${expr}`;
  });
  return toSpeakable(withCron);
}

/** What LEXA says when asking for approval: who wants to do what, the exact content, and the risk. */
export function speakableApproval(a: ApprovalLike): string {
  const what = TOOL_LABELS[a.tool] ?? a.tool.replace(/_/g, " ");
  const risk = a.risk_level === "high" ? " This is a high-risk action." : "";
  return `The ${a.agent} agent wants to ${what}. ${speakableSummary(a.summary)}${risk}`;
}

const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** True when `heard` is mostly words LEXA itself was just speaking (its voice picked up by the microphone). */
export function isEcho(heard: string, spoken: string): boolean {
  const h = tokens(heard);
  if (h.length === 0) return true;
  const s = new Set(tokens(spoken));
  const hit = h.filter((w) => s.has(w)).length;
  return h.length <= 2 ? hit === h.length : hit / h.length >= 0.6;
}

const HALLUCINATIONS = /^(?:thanks for watching!?|thank you for watching!?|please subscribe|like and subscribe|subtitles by .*|transcribed by .*|you|\.+|hmm+|uh+|um+|mm+|ah+)$/i;
const SHORT_HALLUCINATIONS = /^(?:thank you|thanks|bye)$/i;

/** Speech models sometimes invent text for noise or silence. Drops the usual suspects. */
export function isLikelyHallucination(text: string, durationMs: number): boolean {
  const t = text.trim().replace(/[.!?,]+$/g, "");
  if (t.length < 2) return true;
  if (HALLUCINATIONS.test(t)) return true;
  return durationMs > 0 && durationMs < 1200 && SHORT_HALLUCINATIONS.test(t);
}
