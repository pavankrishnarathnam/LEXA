import { describe, expect, it } from "vitest";
import { matchPage, parseCommand, stripWake, type Command } from "@/lib/voice/commands";
import { describeCron, isEcho, isLikelyHallucination, speakableApproval, speakableSummary, splitForTts, takeSpoken, toSpeakable } from "@/lib/voice/speech-text";

const type = (s: string) => parseCommand(s).type;
const cmd = (s: string): Command => parseCommand(s);

describe("wake phrase", () => {
  it("strips Hey LEXA and common speech-recognition spellings", () => {
    expect(stripWake("Hey LEXA, what's pending?")).toEqual({ text: "what's pending?", woke: true });
    expect(stripWake("ok alexa open tasks")).toEqual({ text: "open tasks", woke: true });
    expect(stripWake("Lexa, go to settings")).toEqual({ text: "go to settings", woke: true });
    expect(stripWake("LEXA")).toEqual({ text: "", woke: true });
  });
  it("does not eat names that merely start like the wake word", () => {
    expect(stripWake("Alexis sent me an email")).toEqual({ text: "Alexis sent me an email", woke: false });
    expect(stripWake("Lexington is far")).toEqual({ text: "Lexington is far", woke: false });
  });
});

describe("navigation", () => {
  it.each([
    ["go to tasks", "/tasks"],
    ["Open the settings page.", "/settings"],
    ["take me to my memory", "/memory"],
    ["show me usage", "/settings?tab=usage"],
    ["open approvals", "/tasks?tab=approvals"],
    ["go to the command center", "/"],
    ["Open voice settings, please", "/settings?tab=voice"],
    ["navigate to automations", "/automations"],
    ["open create agent", "/agents/new"],
    ["go home", "/"],
  ])("%s -> %s", (said, path) => {
    const c = cmd(said);
    expect(c.type).toBe("navigate");
    expect((c as Extract<Command, { type: "navigate" }>).path).toBe(path);
  });

  it("does NOT treat content requests as navigation", () => {
    for (const said of [
      "open a new email to Alex",
      "show me my emails from yesterday",
      "go to the store and buy milk",
      "open the pod bay doors",
      "show me flights to Berlin",
    ]) expect(type(said)).not.toBe("navigate");
  });

  it("knows back, forward and new conversation", () => {
    expect(type("go back")).toBe("back");
    expect(type("forward")).toBe("forward");
    expect(type("start a new conversation")).toBe("newConversation");
    expect(matchPage("the Tasks page")?.path).toBe("/tasks");
    expect(matchPage("narnia")).toBeNull();
  });
});

describe("conversation shortcuts", () => {
  it("opens the conversation behind a spoken answer", () => {
    for (const s of ["open the conversation", "show me the full answer", "take me to the chat", "show the reply in chat"]) expect(type(s)).toBe("openConversation");
    expect(type("open assistant")).toBe("navigate");
  });
  it("reads the latest reply on screen", () => {
    for (const s of ["read the last reply", "read me the answer", "read that aloud", "read the latest message out loud"]) expect(type(s)).toBe("readLast");
    expect(type("read the page")).toBe("readPage");
  });
});

describe("speaking, listening and reading", () => {
  it("maps stop words", () => {
    for (const s of ["stop", "Be quiet.", "enough", "that's enough", "shut up", "okay stop"]) expect(type(s)).toBe("stopSpeaking");
  });
  it("ends voice mode or goes on standby", () => {
    for (const s of ["stop listening", "goodbye", "turn off voice mode", "I'm done"]) expect(type(s)).toBe("exit");
    for (const s of ["go to sleep", "standby", "mute the mic"]) expect(type(s)).toBe("standby");
  });
  it("reads things aloud", () => {
    expect(type("read the page")).toBe("readPage");
    expect(type("what's on the screen")).toBe("readPage");
    expect(type("where am I")).toBe("where");
    expect(type("what can I click")).toBe("listActions");
    expect(type("read more")).toBe("readMore");
    expect(type("repeat that")).toBe("repeat");
    expect(type("read my notifications")).toBe("notifications");
    expect(type("any pending approvals")).toBe("approvals");
    // The phrases LEXA itself suggests must work word for word.
    for (const s of ["review approvals", "Review my pending approvals", "go through my approvals", "start approvals review"]) expect(type(s)).toBe("approvals");
    expect(type("open approvals")).toBe("navigate"); // opening the page is a different request
    expect(type("what's pending")).toBe("status");
    expect(type("catch me up")).toBe("status");
    expect(type("help")).toBe("help");
  });
  it("adjusts speed and scrolling", () => {
    expect(cmd("speak slower")).toEqual({ type: "speed", direction: "slower" });
    expect(cmd("speed up")).toEqual({ type: "speed", direction: "faster" });
    expect(cmd("scroll down")).toEqual({ type: "scroll", dir: "down" });
    expect(cmd("go to the bottom of the page")).toEqual({ type: "scroll", dir: "bottom" });
  });
  it("cancels a running task only when asked explicitly", () => {
    expect(type("cancel the task")).toBe("cancelTask");
    expect(type("cancel")).toBe("dismiss");
  });
});

describe("everything LEXA tells the user to say is understood, word for word", () => {
  it.each([
    "approve", "reject", "skip", "review approvals", "read more", "what can I click", "help", "read it again", "yes", "no",
    "cancel", "stop", "two", "go to sleep", "stop listening", "read the page", "speak slower", "speak faster",
    "what's pending", "read my notifications", "repeat that", "go back", "new conversation", "open the conversation",
  ])("%s", (said) => { expect(type(said)).not.toBe("ask"); });
});

describe("small talk is answered locally", () => {
  it("never reaches the AI", () => {
    for (const s of ["thanks", "Thank you so much", "great", "got it", "ok thanks"]) expect(type(s)).toBe("ack");
    for (const s of ["hello", "Hi there", "good morning", "are you there"]) expect(type(s)).toBe("greet");
    expect(type("thanks for sending the report to Alex")).toBe("ask");
  });
});

describe("approvals and choices", () => {
  it("distinguishes an explicit approve from a casual yes", () => {
    expect(cmd("approve")).toEqual({ type: "affirm", explicit: true });
    expect(cmd("Yes, approve it.")).toEqual({ type: "affirm", explicit: true });
    expect(cmd("confirm")).toEqual({ type: "affirm", explicit: true });
    expect(cmd("yes")).toEqual({ type: "affirm", explicit: false });
    expect(cmd("go ahead")).toEqual({ type: "affirm", explicit: false });
    // casual acknowledgements are not approvals
    for (const s of ["ok", "okay", "sure", "sounds good", "ok thanks"]) expect(type(s)).toBe("ack");
  });
  it("understands reject and skip", () => {
    for (const s of ["reject", "no", "decline it", "don't send it"]) expect(type(s)).toBe("negate");
    // Backing out of a question must never reject (or approve) anything.
    for (const s of ["never mind", "cancel", "forget it", "cancel that"]) expect(type(s)).toBe("dismiss");
    for (const s of ["skip", "not now", "ask me later", "next one"]) expect(type(s)).toBe("skip");
  });
  it("reads numbers as choices", () => {
    expect(cmd("two")).toEqual({ type: "choice", index: 2 });
    expect(cmd("the third one".replace("the ", ""))).toEqual({ type: "choice", index: 3 });
    expect(cmd("number 4")).toEqual({ type: "choice", index: 4 });
    expect(cmd("2nd")).toEqual({ type: "choice", index: 2 });
  });
});

describe("controlling the screen by voice", () => {
  it("clicks things by name, soft for open/select/choose", () => {
    expect(cmd("click create agent")).toEqual({ type: "click", target: "create agent", soft: false });
    expect(cmd("press the Approve and run button")).toEqual({ type: "click", target: "Approve and run", soft: false, kind: "button" });
    expect(cmd("open Travel Planner")).toEqual({ type: "click", target: "Travel Planner", soft: true });
    expect(cmd("select the second tab")).toEqual({ type: "click", target: "second", soft: true, kind: "tab" });
  });
  it("only treats click/press/tap/activate as certain clicks (push/hit/open may be requests for LEXA)", () => {
    expect(cmd("push my changes to GitHub")).toMatchObject({ type: "click", soft: true });
    expect(cmd("hit the send button")).toMatchObject({ type: "click", soft: true, kind: "button" });
    expect(cmd("tap save")).toMatchObject({ type: "click", soft: false });
    expect(cmd("click on the link that says read the full report in the news article today")).toMatchObject({ soft: true });
  });
  it("closes dialogs and menus", () => {
    for (const s of ["close", "close this", "close the dialog", "dismiss", "press escape"]) expect(type(s)).toBe("close");
  });
  it("fills fields keeping the capitalisation of the value", () => {
    expect(cmd("set name to Travel Planner")).toEqual({ type: "fill", field: "name", value: "Travel Planner" });
    expect(cmd("fill the email with a@b.com")).toEqual({ type: "fill", field: "email", value: "a@b.com" });
    expect(cmd("type Hello World in the message box")).toEqual({ type: "fill", field: "message box", value: "Hello World" });
    expect(cmd("change the budget to 200")).toEqual({ type: "fill", field: "budget", value: "200" });
  });
  it("dictates into the focused field and submits", () => {
    expect(cmd("type buy milk and eggs")).toEqual({ type: "dictate", text: "buy milk and eggs" });
    expect(type("submit")).toBe("submit");
    expect(type("press enter")).toBe("submit");
    expect(type("save changes")).toBe("submit");
  });
  it("toggles switches", () => {
    expect(cmd("turn on auto memory")).toEqual({ type: "toggle", target: "auto memory", on: true });
    expect(cmd("disable the speak responses")).toEqual({ type: "toggle", target: "speak responses", on: false });
    expect(cmd("check pinned")).toEqual({ type: "toggle", target: "pinned", on: true });
    expect(cmd("toggle dark mode")).toEqual({ type: "toggle", target: "dark mode", on: null });
  });
  it("focuses fields", () => {
    expect(cmd("focus on the message box")).toEqual({ type: "focus", target: "message" });
    expect(cmd("go to the search field")).toEqual({ type: "focus", target: "search" });
  });
});

describe("requests for LEXA are passed through unchanged", () => {
  it.each([
    "Find five remote backend jobs and score them",
    "What's on my calendar today?",
    "Draft a reply to Priya about Thursday",
    "Research the top competitors of Linear",
    "Summarize my unread emails",
    "Set a reminder for 5 pm to call mom",
    "Write an email to Alex about the launch",
    "What can you do?",
  ])("%s", (said) => {
    const c = cmd(said);
    // Only the soft "set ... to ..." pattern can look like a command; it is verified against the screen first.
    expect(["ask", "fill"]).toContain(c.type);
    if (c.type === "ask") expect(c.text).toBe(said);
  });
});

describe("speech text", () => {
  it("turns markdown into spoken sentences", () => {
    const md = "## Summary\n\n**Three** roles match:\n\n- Acme — *Senior Dev*\n- Globex → Staff Engineer\n\nSee [the posting](https://jobs.acme.com/123?x=1) or https://www.globex.io/careers. ✅";
    const out = toSpeakable(md);
    expect(out).not.toMatch(/[#*_\[\]()]|https?:|✅/);
    expect(out).toContain("Three roles match:");
    expect(out).toContain("Globex to Staff Engineer.");
    expect(out).toContain("link to globex.io");
    expect(out).toContain("the posting");
  });
  it("reads tables as lists and omits code", () => {
    expect(toSpeakable("| Name | Score |\n|---|---|\n| Acme | 91 |")).toBe("Name, Score. Acme, 91.");
    expect(toSpeakable("Run this:\n```bash\nrm -rf /\n```\nDone")).toBe("Run this: (code omitted) Done.");
  });
  it("chunks long text at sentence boundaries with a short first chunk", () => {
    const text = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i + 1} of the answer.`).join(" ");
    const chunks = splitForTts(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(240);
    expect(chunks.every((c) => c.length <= 700)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });
  it("splits one enormous sentence instead of failing", () => {
    const chunks = splitForTts(Array(300).fill("word").join(" "));
    expect(chunks.every((c) => c.length <= 700)).toBe(true);
  });
  it("cuts long replies for 'read more'", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} is here.`).join(" ");
    const { head, rest } = takeSpoken(text, 300);
    expect(head.length).toBeLessThanOrEqual(300);
    expect(head.endsWith(".")).toBe(true);
    expect(`${head} ${rest}`).toBe(text);
    expect(takeSpoken("short", 300)).toEqual({ head: "short", rest: "" });
  });
  it("describes cron schedules in words and refuses ones it cannot describe", () => {
    expect(describeCron("0 17 * * 5")).toBe("every Friday at 5 PM");
    expect(describeCron("30 7 * * 1-5")).toBe("every weekday at 7:30 AM");
    expect(describeCron("0 9 * * 1,3,5")).toBe("every Monday, Wednesday and Friday at 9 AM");
    expect(describeCron("0 8 * * *")).toBe("every day at 8 AM");
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("0 6 1 * *")).toBe("on the 1st of every month at 6 AM");
    expect(describeCron("0 0 * 3 *")).toBeNull();
    expect(describeCron("nonsense")).toBeNull();
  });
  it("reads notification titles with schedules in words, not as garbled symbols", () => {
    expect(speakableSummary("Done: Create automation “Weekly review” on cron `0 17 * * 5`: Summarize my week"))
      .toBe("Done: Create automation “Weekly review”, running every Friday at 5 PM: Summarize my week.");
    expect(speakableSummary("Failed: Send email to **alex@example.com**")).not.toMatch(/\*/);
  });
  it("narrates an approval with who, what, exact content and risk", () => {
    const text = speakableApproval({
      agent: "communication", tool: "gmail_send", risk_level: "high",
      summary: "Email to alex@example.com — “Project update”\n\nHi Alex, the project is on track for Friday.",
    });
    expect(text).toContain("communication agent wants to send an email");
    expect(text).toContain("alex@example.com");
    expect(text).toContain("on track for Friday");
    expect(text).toContain("high-risk");
    const auto = speakableApproval({ agent: "operations", tool: "automation_create", risk_level: "medium",
      summary: "Create automation “Weekly review” on cron `0 17 * * 5`: Summarize my week" });
    expect(auto).toContain("running every Friday at 5 PM");
    expect(auto).not.toContain("cron");
  });
});

describe("hearing LEXA's own voice and noise", () => {
  const spoken = "Approval needed. The communication agent wants to send an email to Alex. Say approve, reject, or skip.";
  it("recognises its own words coming back through the microphone", () => {
    expect(isEcho("say approve reject or skip", spoken)).toBe(true);
    expect(isEcho("communication agent wants to send", spoken)).toBe(true);
    expect(isEcho("approve", spoken)).toBe(true); // one word, present in the speech: treated as echo while speaking
  });
  it("does not mistake a real new request for echo", () => {
    expect(isEcho("what is the weather in Berlin", spoken)).toBe(false);
    expect(isEcho("cancel everything and open settings", spoken)).toBe(false);
  });
  it("drops typical hallucinations from silence but keeps real short replies", () => {
    expect(isLikelyHallucination("Thanks for watching!", 3000)).toBe(true);
    expect(isLikelyHallucination("you", 800)).toBe(true);
    expect(isLikelyHallucination("Thank you.", 700)).toBe(true);
    expect(isLikelyHallucination("Thank you for the update", 2500)).toBe(false);
    expect(isLikelyHallucination("okay", 500)).toBe(false);
    expect(isLikelyHallucination("approve", 600)).toBe(false);
  });
});
