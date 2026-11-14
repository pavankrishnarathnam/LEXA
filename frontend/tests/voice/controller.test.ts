import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@/types";
import {
  VoiceController, type ControllerDeps, type DashboardLite, type TaskLite, type VoiceApi, type VoiceConfig, type VoiceHost,
} from "@/lib/voice/controller";
import type { MicHandlers, MicLike } from "@/lib/voice/mic";
import type { SpeakEnd, SpeakerLike } from "@/lib/voice/speaker";

class FakeSpeaker implements SpeakerLike {
  spoken: string[] = [];
  speaking = false;
  recentText = "";
  private waiting: ((r: SpeakEnd) => void)[] = [];
  speak(text: string, opts?: { interrupt?: boolean }): Promise<SpeakEnd> {
    if (opts?.interrupt !== false) this.stop();
    this.spoken.push(text);
    this.speaking = true;
    this.recentText = text;
    return new Promise<SpeakEnd>((res) => this.waiting.push(res));
  }
  /** The current speech ends normally. */
  finish(): void { const w = this.waiting.shift(); this.speaking = this.waiting.length > 0; w?.("done"); }
  stop(): void { this.waiting.splice(0).forEach((w) => w("stopped")); this.speaking = false; }
  unlock(): void {}
  refreshRate(): void {}
  recent(): string { return this.recentText; }
  get last(): string { return this.spoken[this.spoken.length - 1] ?? ""; }
}

class FakeMic implements MicLike {
  running = false;
  handlers!: MicHandlers;
  failWith: unknown = null;
  async start(): Promise<void> { if (this.failWith) throw this.failWith; this.running = true; }
  stop(): void { this.running = false; }
  setEndSilence(): void {}
  ignoreFor(): void {}
}

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "a1", task_id: "t1", agent: "communication", tool: "gmail_send", risk_level: "medium", reason: "external action",
  summary: "Email to alex@example.com — “Project update”\n\nHi Alex, the project is on track for Friday.",
  arguments: {}, status: "pending", created_at: "2026-11-14T10:00:00Z", decided_at: null, result: null, expires_at: null, ...over,
});

const dashboard = (over: Partial<DashboardLite> = {}): DashboardLite => ({
  active_tasks: [], pending_approvals: [], unread_notifications: 0, schedule: { connected: false, events: [] },
  usage: { month_spend_usd: 1, budget_usd: 50 }, ...over,
});

function setup(opts: { approvals?: Approval[]; config?: Partial<VoiceConfig>; pathname?: string; openHelp?: () => void } = {}) {
  const speaker = new FakeSpeaker();
  const mic = new FakeMic();
  const cues: string[] = [];
  const config: VoiceConfig = { speed: 1, language: "en", patience: "normal", wakePhrase: false, cues: true, speakResponses: false, ...opts.config };
  const state = { approvals: opts.approvals ?? [], dash: dashboard(), tasks: {} as Record<string, TaskLite>, path: opts.pathname ?? "/" };
  const api: VoiceApi = {
    transcribe: vi.fn(async () => ({ text: "" })),
    approvals: vi.fn(async () => [...state.approvals]),
    decide: vi.fn(async () => undefined),
    dashboard: vi.fn(async () => state.dash),
    notifications: vi.fn(async () => []),
    markNotificationsRead: vi.fn(async () => undefined),
    task: vi.fn(async (id: string) => state.tasks[id] ?? { id, status: "COMPLETED", output: "Done." }),
    cancelTask: vi.fn(async () => undefined),
  };
  const host: VoiceHost = {
    navigate: vi.fn((p: string) => { state.path = p.split("?")[0]; }),
    back: vi.fn(), forward: vi.fn(), pathname: () => state.path,
    ask: vi.fn(async () => ({ taskId: "task-1" })),
  };
  const setSpeed = vi.fn((s: number) => { config.speed = s; });
  const deps: ControllerDeps = {
    api, host, speaker, config: () => config, setSpeed, playCue: (c) => { cues.push(c); },
    createMic: (h) => { mic.handlers = h; return mic; }, openHelp: opts.openHelp,
  };
  const c = new VoiceController(deps);
  return { c, speaker, mic, api, host, cues, config, state, setSpeed };
}
type Ctx = ReturnType<typeof setup>;
const flush = () => vi.advanceTimersByTimeAsync(0);
const say = async (t: Ctx, text: string, meta?: Parameters<VoiceController["hear"]>[1]) => { await t.c.hear(text, meta); await flush(); };

async function reading(t: Ctx) { // start a review and let the narration finish
  await t.c.reviewApprovals({ auto: false });
  await flush();
}

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("starting and stopping", () => {
  it("opens the microphone and reports the phase", async () => {
    const t = setup();
    expect(t.c.getSnapshot().phase).toBe("off");
    expect(await t.c.start({ quiet: true })).toBe(true);
    expect(t.mic.running).toBe(true);
    expect(t.c.getSnapshot()).toMatchObject({ active: true, phase: "listening" });
    t.c.onSpeakStart();
    expect(t.c.getSnapshot().phase).toBe("speaking");
    t.c.onSpeakEnd();
    await t.c.stop();
    expect(t.mic.running).toBe(false);
    expect(t.c.getSnapshot()).toMatchObject({ active: false, phase: "off" });
  });

  it("explains a blocked microphone out loud and in text", async () => {
    const t = setup();
    t.mic.failWith = Object.assign(new Error("x"), { code: "denied" });
    expect(await t.c.start({ quiet: true })).toBe(false);
    expect(t.c.getSnapshot().micProblem).toMatch(/blocked/i);
    expect(t.speaker.last).toMatch(/Allow the microphone/);
    expect(t.c.getSnapshot().active).toBe(false);
  });

  it("greets once with pending approvals mentioned", async () => {
    const t = setup();
    t.state.dash = dashboard({ pending_approvals: [approval(), approval({ id: "a2" })] });
    await t.c.start();
    await flush();
    expect(t.speaker.last).toMatch(/Voice mode is on/);
    expect(t.speaker.last).toMatch(/2 approvals waiting/);
  });
});

describe("approving by voice", () => {
  it("reads the whole action first, then asks for a decision", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t);
    expect(t.speaker.last).toContain("communication agent wants to send an email");
    expect(t.speaker.last).toContain("on track for Friday");
    expect(t.speaker.last).toMatch(/Say approve, reject, or skip\.$/);
    expect(t.c.getSnapshot().awaiting?.kind).toBe("approval");
  });

  it("refuses to approve until it has been read to the end", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t);
    await say(t, "approve"); // LEXA is still talking
    expect(t.api.decide).not.toHaveBeenCalled();
    expect(t.speaker.last).toMatch(/haven't finished reading/);
    // After "stop" the action also counts as unheard.
    await say(t, "read it again"); // grammar: repeat
    t.speaker.finish();
    await flush();
    await say(t, "stop");
    await say(t, "yes");
    expect(t.api.decide).not.toHaveBeenCalled();
  });

  it("approves after the narration finished, and moves on", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t);
    t.speaker.finish();
    await flush();
    await say(t, "approve");
    expect(t.api.decide).toHaveBeenCalledWith("a1", true);
    expect(t.speaker.last).toMatch(/Approved\. Running it now\. That was the last one\./);
    expect(t.c.getSnapshot().awaiting).toBeNull();
  });

  it("needs a second explicit approve for high-risk actions", async () => {
    const t = setup({ approvals: [approval({ risk_level: "high", tool: "payment_send", summary: "Pay invoice 42 to Acme: $1,200" })] });
    await t.c.start({ quiet: true });
    await reading(t);
    t.speaker.finish();
    await flush();
    await say(t, "yes");
    expect(t.api.decide).not.toHaveBeenCalled();
    expect(t.speaker.last).toMatch(/high risk.*approve once more/i);
    await say(t, "yes"); // a casual yes is still not enough
    expect(t.api.decide).not.toHaveBeenCalled();
    await say(t, "approve");
    expect(t.api.decide).toHaveBeenCalledWith("a1", true);
  });

  it("lets typed commands approve without waiting (the text is on screen)", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t); // still reading
    await say(t, "approve", { typed: true });
    expect(t.api.decide).toHaveBeenCalledWith("a1", true);
  });

  it("rejects only on a clear reject; 'never mind' and 'cancel' leave it pending", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t);
    t.speaker.finish();
    await flush();
    await say(t, "never mind");
    await say(t, "cancel");
    expect(t.api.decide).not.toHaveBeenCalled();
    expect(t.c.getSnapshot().awaiting).toBeNull();
    await reading(t);
    await say(t, "reject");
    expect(t.api.decide).toHaveBeenCalledWith("a1", false);
    expect(t.speaker.last).toMatch(/Rejected\./);
  });

  it("goes through several approvals with skip, and a casual 'ok thanks' never approves", async () => {
    const t = setup({ approvals: [approval({ id: "newer", summary: "Second thing" }), approval({ id: "older", summary: "First thing" })] });
    await t.c.start({ quiet: true });
    await reading(t);
    expect(t.speaker.last).toMatch(/Approval 1 of 2\. .*First thing/s); // oldest first
    t.speaker.finish();
    await flush();
    await say(t, "ok thanks");
    expect(t.api.decide).not.toHaveBeenCalled();
    await say(t, "skip");
    expect(t.speaker.last).toMatch(/Approval 2 of 2\. .*Second thing/s);
    t.speaker.finish();
    await flush();
    await say(t, "approve");
    expect(t.api.decide).toHaveBeenCalledWith("newer", true);
  });

  it("ignores approve / yes heard while LEXA is speaking (could be its own voice)", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t);
    t.speaker.finish();
    await flush();
    await say(t, "approve", { duringSpeech: true });
    await say(t, "yes", { duringSpeech: true });
    expect(t.api.decide).not.toHaveBeenCalled();
  });

  it("lets 'stop' interrupt the reading while LEXA is speaking", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await reading(t);
    expect(t.speaker.speaking).toBe(true);
    await say(t, "stop", { duringSpeech: true });
    expect(t.speaker.speaking).toBe(false);
  });

  it("reports an API failure instead of pretending it worked", async () => {
    const t = setup({ approvals: [approval()] });
    (t.api.decide as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Approval already decided"));
    await t.c.start({ quiet: true });
    await reading(t);
    t.speaker.finish();
    await flush();
    await say(t, "approve");
    expect(t.speaker.last).toMatch(/didn't go through: Approval already decided/);
    expect(t.c.getSnapshot().awaiting?.kind).toBe("approval"); // still pending, can retry
  });

  it("clicking the on-screen Approve button by voice follows the same read-first rule", async () => {
    document.body.innerHTML = `<div data-approval-id="a1"><p>Email to Alex</p><button>Approve &amp; run</button><button>Reject</button></div>`;
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    await say(t, "click approve");
    await flush();
    expect(t.api.decide).not.toHaveBeenCalled(); // it read the approval aloud instead
    expect(t.speaker.last).toContain("wants to send an email");
    t.speaker.finish();
    await flush();
    await say(t, "approve");
    expect(t.api.decide).toHaveBeenCalledWith("a1", true);
  });

  it("announces a new approval by itself and does not nag after a skip", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    t.c.handleEvent({ event: "notification", data: { kind: "approval", title: "Approval needed: Email to Alex", severity: "info" } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(t.speaker.last).toMatch(/You have an approval waiting\./);
    t.speaker.finish();
    await flush();
    await say(t, "skip");
    t.speaker.spoken.length = 0;
    t.c.handleEvent({ event: "notification", data: { kind: "approval", title: "Approval needed: Email to Alex", severity: "info" } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(t.speaker.spoken.join(" ")).not.toMatch(/approval waiting/);
  });
});

describe("hearing", () => {
  const utter = (t: Ctx, over: Partial<{ duringSpeech: boolean; speechMs: number }> = {}) =>
    t.mic.handlers.onUtterance({ wav: new Uint8Array(100), durationMs: 1500, speechMs: 1200, duringSpeech: false, ...over });

  it("transcribes an utterance and acts on it", async () => {
    const t = setup();
    (t.api.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: "Go to tasks." });
    await t.c.start({ quiet: true });
    utter(t);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.host.navigate).toHaveBeenCalledWith("/tasks");
    expect(t.c.getSnapshot().heard).toBe("Go to tasks.");
  });

  it("discards LEXA's own voice and Whisper-style hallucinations", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    void t.speaker.speak("You have three tasks running. Say review approvals to go through them.");
    (t.api.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: "say review approvals to go through them" });
    utter(t, { duringSpeech: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.host.ask).not.toHaveBeenCalled();
    t.speaker.stop();
    t.speaker.recentText = "";
    (t.api.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: "Thanks for watching!" });
    utter(t);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.host.ask).not.toHaveBeenCalled();
  });

  it("does not mistake you repeating a suggestion for an echo once LEXA has stopped talking", async () => {
    const t = setup({ approvals: [approval()] });
    await t.c.start({ quiet: true });
    // LEXA just said "Say review approvals..." and finished; the user now says exactly that.
    t.speaker.recentText = "You have 1 approval waiting. Say review approvals when you're ready.";
    (t.api.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: "review approvals" });
    utter(t, { duringSpeech: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.speaker.last).toContain("wants to send an email");
  });

  it("drops tiny bursts heard while LEXA talks (never even sent for transcription)", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    utter(t, { duringSpeech: true, speechMs: 150 });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.api.transcribe).not.toHaveBeenCalled();
  });

  it("speaks a clear message and switches voice off when speech recognition is not configured", async () => {
    const t = setup();
    (t.api.transcribe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("x"), { status: 503 }));
    await t.c.start({ quiet: true });
    utter(t);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.speaker.last).toMatch(/needs an OpenAI API key/);
    t.speaker.finish();
    await flush();
    expect(t.c.getSnapshot().active).toBe(false);
  });

  it("sleeps on command and only wakes for 'Hey LEXA'", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "go to sleep");
    t.speaker.finish();
    await flush();
    expect(t.c.getSnapshot().phase).toBe("sleeping");
    await say(t, "open tasks");
    expect(t.host.navigate).not.toHaveBeenCalled();
    await say(t, "Hey LEXA, open tasks");
    expect(t.host.navigate).toHaveBeenCalledWith("/tasks");
    expect(t.c.getSnapshot().phase).not.toBe("sleeping");
  });

  it("falls asleep after five quiet minutes", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 20_000);
    expect(t.c.getSnapshot().phase).toBe("sleeping");
  });

  it("with the wake phrase required, ignores chatter but keeps listening mid-conversation", async () => {
    const t = setup({ config: { wakePhrase: true } });
    await t.c.start({ quiet: true });
    await say(t, "open tasks");
    expect(t.host.navigate).not.toHaveBeenCalled();
    await say(t, "Hey LEXA open tasks");
    expect(t.host.navigate).toHaveBeenCalledWith("/tasks");
  });
});

describe("asking LEXA and hearing the answer", () => {
  it("sends requests as voice, typed boxes as text, and keeps small talk out of the AI", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "Find five remote backend jobs");
    expect(t.host.ask).toHaveBeenCalledWith("Find five remote backend jobs", { voice: true });
    await say(t, "Summarize my inbox", { typed: true });
    expect(t.host.ask).toHaveBeenLastCalledWith("Summarize my inbox", { voice: false });
    const calls = (t.host.ask as ReturnType<typeof vi.fn>).mock.calls.length;
    await say(t, "thanks");
    await say(t, "hello");
    expect((t.host.ask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("reads the finished answer as plain speech and offers the rest of a long one", async () => {
    const t = setup();
    t.state.tasks["task-1"] = { id: "task-1", status: "COMPLETED", output: `## Jobs\n\n${Array.from({ length: 50 }, (_, i) => `**Role ${i + 1}** at [Acme](https://acme.example/${i}) pays well.`).join("\n\n")}` };
    await t.c.start({ quiet: true });
    await say(t, "find jobs for me");
    expect(t.c.getSnapshot().phase).toBe("thinking");
    t.c.handleEvent({ event: "task.completed", data: { task_id: "task-1", status: "COMPLETED" } });
    await flush();
    expect(t.speaker.last).not.toMatch(/[*#\[\]]|https?:/);
    expect(t.speaker.last).toMatch(/Say read more for the rest\.$/);
    t.speaker.finish();
    await flush();
    await say(t, "read more");
    expect(t.speaker.last).toContain("Role");
    expect(t.c.getSnapshot().phase).not.toBe("thinking");
  });

  it("reports failures and starts the approvals conversation when a task is waiting", async () => {
    const t = setup({ approvals: [approval()] });
    t.state.tasks["task-1"] = { id: "task-1", status: "FAILED", error: "Gmail is not connected" };
    await t.c.start({ quiet: true });
    await say(t, "email Alex the update");
    t.c.handleEvent({ event: "task.status", data: { task_id: "task-1", status: "FAILED" } });
    await flush();
    expect(t.speaker.last).toMatch(/That didn't work\. Gmail is not connected/);

    t.state.tasks["task-2"] = { id: "task-2", status: "WAITING_FOR_APPROVAL" };
    (t.host.ask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ taskId: "task-2" });
    await say(t, "send the draft");
    t.c.handleEvent({ event: "task.status", data: { task_id: "task-2", status: "WAITING_FOR_APPROVAL" } });
    await vi.advanceTimersByTimeAsync(1700);
    expect(t.speaker.last).toContain("wants to send an email");
  });

  it("reassures during a slow task (once) and stops when it ends", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "research competitors");
    await vi.advanceTimersByTimeAsync(12_100);
    expect(t.speaker.last).toBe("Still working on it.");
  });

  it("reads Chat replies aloud when 'Speak responses' is on, even with the mic off", async () => {
    const t = setup({ config: { speakResponses: true } });
    t.state.tasks["x"] = { id: "x", status: "COMPLETED", output: "You have two meetings today." };
    t.c.handleEvent({ event: "task.created", data: { task_id: "x" } });
    t.c.handleEvent({ event: "task.completed", data: { task_id: "x", status: "COMPLETED" } });
    await flush();
    expect(t.speaker.last).toBe("You have two meetings today.");
  });

  it("answers status questions from the dashboard", async () => {
    const t = setup();
    t.state.dash = dashboard({
      active_tasks: [{ id: "1", title: "a", status: "IN_PROGRESS" }], pending_approvals: [approval()], unread_notifications: 3,
      schedule: { connected: true, events: [{ summary: "Standup", start: { dateTime: "2026-11-14T10:30:00" } }] },
      usage: { month_spend_usd: 45, budget_usd: 50 },
    });
    await t.c.start({ quiet: true });
    await say(t, "what's pending?");
    expect(t.speaker.last).toMatch(/1 task running, 1 approval waiting for you, 3 unread notifications\./);
    expect(t.speaker.last).toMatch(/Next on your calendar: Standup/);
    expect(t.speaker.last).toMatch(/90 percent of your monthly AI budget/);
  });
});

describe("going places and changing how LEXA talks", () => {
  it("navigates without any AI call, and says when you are already there", async () => {
    const t = setup({ pathname: "/tasks" });
    await t.c.start({ quiet: true });
    await say(t, "open approvals");
    expect(t.host.navigate).toHaveBeenCalledWith("/tasks?tab=approvals");
    await say(t, "go to tasks");
    expect(t.speaker.last).toMatch(/already on Tasks/);
    await say(t, "go back");
    expect(t.host.back).toHaveBeenCalled();
    expect(t.host.ask).not.toHaveBeenCalled();
  });

  it("speaks slower and faster within limits", async () => {
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "speak slower");
    expect(t.setSpeed).toHaveBeenLastCalledWith(0.85);
    t.config.speed = 0.6;
    await say(t, "speak slower");
    expect(t.speaker.last).toMatch(/as slow as I go/);
  });

  it("repeats the last thing it said and ends on request", async () => {
    const t = setup();
    t.state.dash = dashboard({ unread_notifications: 2 });
    await t.c.start({ quiet: true });
    await say(t, "status");
    const said = t.speaker.last;
    await say(t, "repeat that");
    expect(t.speaker.last).toBe(said);
    await say(t, "stop listening");
    t.speaker.finish();
    await flush();
    expect(t.c.getSnapshot().active).toBe(false);
  });

  it("answers help by voice and opens the help panel", async () => {
    const openHelp = vi.fn();
    const t = setup({ openHelp });
    await t.c.start({ quiet: true });
    await say(t, "help");
    expect(openHelp).toHaveBeenCalled();
    expect(t.speaker.last).toMatch(/go to tasks/i);
  });

  it("opens the conversation behind the last spoken request", async () => {
    const t = setup();
    (t.host.ask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ taskId: "task-9", conversationId: "conv-9" });
    await t.c.start({ quiet: true });
    await say(t, "find jobs for me");
    await say(t, "open the conversation");
    expect(t.host.navigate).toHaveBeenCalledWith("/assistant/conv-9");
  });
});

describe("operating the page by voice", () => {
  it("clicks a named button and says what changed", async () => {
    document.body.innerHTML = `<button id="b" aria-expanded="false">Show details</button>`;
    const b = document.getElementById("b")!;
    b.addEventListener("click", () => b.setAttribute("aria-expanded", "true"));
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "click show details");
    await vi.advanceTimersByTimeAsync(400);
    expect(t.speaker.last).toBe("Show details expanded.");
  });

  it("asks which one when several match, then acts on the number", async () => {
    document.body.innerHTML = `<ul>
      <li><strong>Weekly review</strong><button id="a">Open</button></li>
      <li><strong>Inbox triage</strong><button id="b">Open</button></li></ul>`;
    const hit: string[] = [];
    document.getElementById("a")!.addEventListener("click", () => hit.push("a"));
    document.getElementById("b")!.addEventListener("click", () => hit.push("b"));
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "click open");
    expect(t.speaker.last).toMatch(/2 matches for open\. 1, Open, button, in Weekly review\. 2, Open, button, in Inbox triage\./);
    expect(hit).toEqual([]);
    await say(t, "two");
    await vi.advanceTimersByTimeAsync(400);
    expect(hit).toEqual(["b"]);
  });

  it("asks for a spoken yes before anything destructive", async () => {
    document.body.innerHTML = `<ul><li><strong>Weekly review</strong><button id="d">Delete</button></li></ul>`;
    const clicked = vi.fn();
    document.getElementById("d")!.addEventListener("click", clicked);
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "click delete");
    expect(t.speaker.last).toMatch(/Are you sure you want to delete, in Weekly review\? Say yes or no\./);
    expect(clicked).not.toHaveBeenCalled();
    await say(t, "no");
    await say(t, "yes"); // too late: the question was cancelled
    await vi.advanceTimersByTimeAsync(400);
    expect(clicked).not.toHaveBeenCalled();
    await say(t, "click delete");
    await say(t, "yes");
    await vi.advanceTimersByTimeAsync(400);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("fills fields, keeps requests that merely look like 'set X to Y' for LEXA, and never dictates secrets", async () => {
    document.body.innerHTML = `<label>Agent name <input id="n"></label><label>Password <input id="p" type="password"></label>
      <label>Range<select id="r"><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>`;
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "set agent name to Travel Planner");
    expect((document.getElementById("n") as HTMLInputElement).value).toBe("Travel Planner");
    expect(t.speaker.last).toBe("Agent name set to Travel Planner.");
    await say(t, "set range to last 30 days");
    expect((document.getElementById("r") as HTMLSelectElement).value).toBe("30");
    await say(t, "set password to hunter2");
    expect((document.getElementById("p") as HTMLInputElement).value).toBe("");
    expect(t.speaker.last).toMatch(/don't fill password/);
    await say(t, "set a reminder for 5 pm to call mom");
    expect(t.host.ask).toHaveBeenCalledWith("set a reminder for 5 pm to call mom", { voice: true });
  });

  it("toggles switches to the requested state", async () => {
    document.body.innerHTML = `<button role="switch" aria-checked="true" aria-label="Auto memory" id="s"></button>`;
    const s = document.getElementById("s")!;
    s.addEventListener("click", () => s.setAttribute("aria-checked", s.getAttribute("aria-checked") === "true" ? "false" : "true"));
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "turn on auto memory");
    await vi.advanceTimersByTimeAsync(300);
    expect(t.speaker.last).toBe("Auto memory is already on.");
    await say(t, "turn off auto memory");
    await vi.advanceTimersByTimeAsync(300);
    expect(t.speaker.last).toBe("Auto memory is now off.");
    await say(t, "turn off the lights"); // not on this page: it is a request for LEXA
    expect(t.host.ask).toHaveBeenCalledWith("turn off the lights", { voice: true });
  });

  it("types dictated text into the focused field and submits it", async () => {
    document.body.innerHTML = `<form id="f"><textarea aria-label="Message"></textarea><button type="submit">Send</button></form>`;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    document.getElementById("f")!.addEventListener("submit", submitted);
    HTMLFormElement.prototype.requestSubmit ??= function (this: HTMLFormElement) { this.dispatchEvent(new Event("submit", { cancelable: true })); };
    const t = setup();
    await t.c.start({ quiet: true });
    (document.querySelector("textarea") as HTMLTextAreaElement).focus();
    await say(t, "type buy milk");
    await say(t, "type and eggs");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("buy milk and eggs");
    await say(t, "submit");
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("answers for open dialogs: yes / no operate the confirmation buttons, close closes", async () => {
    document.body.innerHTML = `<div role="alertdialog" aria-label="Confirm"><h2>Disconnect Gmail?</h2>
      <button data-voice-confirm="no" id="no">Cancel</button><button data-voice-confirm="yes" id="yes">Disconnect</button></div>`;
    const yes = vi.fn(); const no = vi.fn();
    document.getElementById("yes")!.addEventListener("click", yes);
    document.getElementById("no")!.addEventListener("click", no);
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "yes");
    expect(yes).toHaveBeenCalledTimes(1);
    await say(t, "no");
    expect(no).toHaveBeenCalledTimes(1);
  });

  it("does not talk over a confirmation dialog that reads its own question", async () => {
    document.body.innerHTML = `<button id="d" data-voice-confirms>Delete</button>`;
    document.getElementById("d")!.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", `<div role="alertdialog" aria-label="Confirm"><h2>Delete it?</h2><button data-voice-confirm="no">Cancel</button><button data-voice-confirm="yes">Delete</button></div>`);
    });
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "click delete");
    await vi.advanceTimersByTimeAsync(400);
    expect(t.speaker.spoken).toEqual([]); // the app's own dialog announces itself
  });

  it("reads and describes the page", async () => {
    document.body.innerHTML = `<main><h1>Task center</h1><h2>Active</h2><p>Two tasks are running.</p><button>Refresh</button></main>`;
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "where am i");
    expect(t.speaker.last).toBe("You are on Task center.");
    await say(t, "read the page");
    expect(t.speaker.last).toMatch(/Task center\. Sections: Active\. Two tasks are running/);
    await say(t, "what can i click");
    expect(t.speaker.last).toMatch(/Refresh, button/);
  });

  it("reads the newest chat reply aloud as plain speech", async () => {
    document.body.innerHTML = `<article data-voice-reply><p>Older reply.</p></article><article data-voice-reply><h2>Plan</h2><p><strong>Two</strong> meetings today.</p></article>`;
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "read the last reply");
    expect(t.speaker.last).toContain("meetings today");
    expect(t.speaker.last).not.toContain("Older reply");
  });

  it("says plainly when it cannot find what you asked it to click", async () => {
    document.body.innerHTML = `<button>Save</button>`;
    const t = setup();
    await t.c.start({ quiet: true });
    await say(t, "click launch the missiles");
    expect(t.speaker.last).toMatch(/can't find anything called launch the missiles/);
    await say(t, "push my changes to GitHub"); // soft verb with no such control: a request for LEXA
    expect(t.host.ask).toHaveBeenCalledWith("push my changes to GitHub", { voice: true });
  });
});
