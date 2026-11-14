/**
 * Spoken command grammar. Everything the user says is first matched here (instant, free, works offline of the
 * AI); only what is not a command is sent to LEXA as a request.
 *
 * Patterns are deliberately anchored (^...$) so ordinary requests such as "show me my emails from yesterday"
 * or "open a new email to Alex" are NOT mistaken for navigation or clicks.
 */

export interface PageDef {
  label: string;
  path: string;
  aliases: string[];
}

export const PAGES: PageDef[] = [
  { label: "Command Center", path: "/", aliases: ["home", "home page", "command center", "command centre", "dashboard", "main page", "start page"] },
  { label: "Assistant", path: "/assistant", aliases: ["assistant", "chat", "chats", "conversation", "conversations"] },
  { label: "Tasks", path: "/tasks", aliases: ["tasks", "task", "task center", "task centre", "task list", "activity"] },
  { label: "Approvals", path: "/tasks?tab=approvals", aliases: ["approvals", "approval", "approval queue", "pending approvals", "approval center"] },
  { label: "Agents", path: "/agents", aliases: ["agents", "agent", "agent directory"] },
  { label: "New agent", path: "/agents/new", aliases: ["new agent", "create agent", "create an agent", "add agent", "add an agent", "create a new agent"] },
  { label: "Career", path: "/career", aliases: ["career", "career center", "career centre", "jobs", "job search", "job board", "job applications", "applications"] },
  { label: "Communication", path: "/communication", aliases: ["communication", "communications", "email", "emails", "inbox", "contacts", "messages", "messaging"] },
  { label: "Research", path: "/research", aliases: ["research", "research center", "research centre", "reports", "research reports"] },
  { label: "Developer", path: "/developer", aliases: ["developer", "developer center", "developer centre", "dev", "github", "code", "repositories", "repos"] },
  { label: "Finance", path: "/finance", aliases: ["finance", "finances", "budget", "expenses", "money", "spending"] },
  { label: "Automations", path: "/automations", aliases: ["automations", "automation", "workflows", "workflow", "schedules"] },
  { label: "Memory", path: "/memory", aliases: ["memory", "memories", "profile", "knowledge"] },
  { label: "Integrations", path: "/integrations", aliases: ["integrations", "integration", "connections", "connected apps", "apps"] },
  { label: "Settings", path: "/settings", aliases: ["settings", "setting", "preferences", "options", "account"] },
  { label: "Usage and cost", path: "/settings?tab=usage", aliases: ["usage", "cost", "costs", "billing", "api usage", "usage and cost", "ai usage"] },
  { label: "Security and audit", path: "/settings?tab=security", aliases: ["security", "audit", "audit log", "activity log", "logs"] },
  { label: "Voice settings", path: "/settings?tab=voice", aliases: ["voice settings", "voice options", "voice preferences", "voice"] },
];

export type Command =
  | { type: "stopSpeaking" }
  | { type: "cancelTask" }
  | { type: "exit" }
  | { type: "standby" }
  | { type: "help" }
  | { type: "repeat" }
  | { type: "readMore" }
  | { type: "readPage" }
  | { type: "where" }
  | { type: "listActions" }
  | { type: "status" }
  | { type: "notifications" }
  | { type: "approvals" }
  | { type: "affirm"; explicit: boolean }
  | { type: "negate" }
  | { type: "dismiss" }
  | { type: "openConversation" }
  | { type: "readLast" }
  | { type: "ack" }
  | { type: "greet" }
  | { type: "skip" }
  | { type: "navigate"; path: string; label: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "newConversation" }
  | { type: "scroll"; dir: "up" | "down" | "top" | "bottom" }
  | { type: "click"; target: string; soft: boolean; kind?: string }
  | { type: "close" }
  | { type: "toggle"; target: string; on: boolean | null }
  | { type: "fill"; field: string; value: string }
  | { type: "dictate"; text: string }
  | { type: "submit" }
  | { type: "focus"; target: string }
  | { type: "choice"; index: number }
  | { type: "speed"; direction: "slower" | "faster" }
  | { type: "ask"; text: string };

const WAKE_GREETED = /^(?:hey|hi|hello|ok|okay|yo)[\s,]+(?:lexa|lexar|lexi|lexie|alexa|alexia)\b[\s,:;.!-]*/i;
const WAKE_BARE = /^(?:lexa|lexar|alexa)\b[\s,:;.!-]*/i;

/** Removes a leading "Hey LEXA" (and spelling variants speech recognition produces). */
export function stripWake(raw: string): { text: string; woke: boolean } {
  const t = raw.trim();
  const m = t.match(WAKE_GREETED) ?? t.match(WAKE_BARE);
  if (!m) return { text: t, woke: false };
  return { text: t.slice(m[0].length).trim(), woke: true };
}

function clean(raw: string): string {
  let t = raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:(?:please|kindly|just|so|um+|uh+|er+|well|now)[\s,]+)+/i, "");
  t = t.replace(/[\s,]+(?:please|thanks|thank you)$/i, "");
  t = t.replace(/[.!?,;:]+$/g, "");
  return t.trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

/** Maps "the settings page" / "my tasks" etc. to a page, or null if it is not exactly a known page. */
export function matchPage(target: string): PageDef | null {
  let t = norm(target);
  for (let i = 0; i < 3; i++) t = t.replace(/^(?:the|my|a|an)\s+/, "");
  t = t.replace(/\s+(?:page|screen|section|tab|center|centre|view)$/, (m) => (PAGES.some((p) => p.aliases.includes(t)) ? m : ""));
  return PAGES.find((p) => p.aliases.includes(t)) ?? null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

type Rule = [RegExp, (m: RegExpMatchArray, original: string) => Command];

// Exact-phrase intents (matched against the lower-cased text).
const PHRASES: Rule[] = [
  [/^(?:stop|quiet|silence|enough|shush|hush|pause|be quiet|stop (?:talking|speaking|reading|it)|that'?s enough|ok(?:ay)? stop|shut up)$/, () => ({ type: "stopSpeaking" })],
  [/^(?:cancel|stop|abort) (?:the |that |this |my )?(?:task|request|job|work)$/, () => ({ type: "cancelTask" })],
  [/^(?:close|dismiss|close (?:this|that|it|the (?:dialog|menu|popup|window|panel|palette|drawer|modal|sidebar))|exit (?:this|the dialog)|press escape|escape)$/, () => ({ type: "close" })],
  [/^(?:stop listening|turn off (?:the )?voice(?: mode)?|(?:end|exit|leave|close|quit) voice(?: mode)?|voice (?:mode )?off|goodbye|good ?bye|that'?s all|i'?m done|i am done|we'?re done|see you(?: later)?)$/, () => ({ type: "exit" })],
  [/^(?:go to sleep|standby|stand by|sleep|go quiet|sleep mode|pause listening|mute(?: yourself)?|mic off|microphone off|mute (?:the )?(?:mic|microphone))$/, () => ({ type: "standby" })],
  [/^(?:help|help me|what can i say|voice help|voice commands|list (?:the )?(?:voice )?commands|show (?:the )?(?:voice )?commands|how do i use (?:voice|this))$/, () => ({ type: "help" })],
  [/^(?:repeat(?: that)?|say (?:that )?again|what did you say|read (?:that|it|this) again|again|come again|pardon)$/, () => ({ type: "repeat" })],
  [/^(?:read more|more|continue|keep (?:reading|going)|go on|carry on|next part)$/, () => ({ type: "readMore" })],
  [/^(?:read (?:me )?(?:the |this )?(?:page|screen|everything)|what'?s on (?:the |my )?screen|describe (?:the |this )?(?:page|screen))$/, () => ({ type: "readPage" })],
  [/^(?:where am i|what page (?:is this|am i on)|which page (?:is this|am i on))$/, () => ({ type: "where" })],
  [/^(?:(?:list|read|what are)(?: me)?(?: the)?(?: available)? (?:actions|buttons|options|controls|links)|what can i (?:click|press|do here)|what'?s clickable|show (?:me )?(?:the )?(?:buttons|options|actions))$/, () => ({ type: "listActions" })],
  [/^(?:(?:read|check|play|show)(?: me)?(?: my)?(?: the)?(?: unread| new)? notifications|any (?:new )?notifications|what are my notifications|do i have (?:any )?(?:new )?notifications)$/, () => ({ type: "notifications" })],
  [/^(?:(?:read|check|show|list|review|go through|start|begin)(?: me)?(?: my| the| all| any)?(?: pending)? approvals?(?: review)?|what needs (?:my )?approval|any (?:pending )?approvals?|do i have (?:any )?(?:pending )?approvals?|what'?s waiting for (?:my )?approval)$/, () => ({ type: "approvals" })],
  [/^(?:status|what'?s (?:pending|waiting|new|happening|going on|up|my status)|(?:give me |any )?(?:an )?updates?|what needs (?:my )?attention|what'?s on my plate|do i have anything (?:pending|waiting)|am i missing anything|brief me|catch me up)$/, () => ({ type: "status" })],
  [/^(?:approve(?:d)?(?: it| that| this| the (?:action|request|email|draft))?|yes,? approve(?: it)?|i approve(?: it| that)?|approve and run|confirm(?:ed)?)$/, (m) => ({ type: "affirm", explicit: /approve|confirm/.test(m[0]) })],
  // Deliberately NOT here: ok / okay / sure / sounds good. Those are acknowledgements (below), so a casual "ok thanks"
  // after hearing an approval can never approve it.
  [/^(?:yes|yeah|yep|yup|go ahead|do it|send it|please do|go for it|affirmative|absolutely|of course|yes please)$/, () => ({ type: "affirm", explicit: false })],
  // Only these reject an approval. "never mind" / "cancel" just leave things as they are (see "dismiss").
  [/^(?:no|nope|nah|(?:reject|decline|deny)(?:ed)?(?: it| that| this)?|denied|don'?t|do not|don'?t do (?:it|that)|don'?t send(?: it)?|no thanks|no thank you|negative)$/, () => ({ type: "negate" })],
  [/^(?:cancel(?: that| it| this)?|never ?mind|forget it|leave it|leave it pending|stop asking|ok(?:ay)? never ?mind)$/, () => ({ type: "dismiss" })],
  [/^(?:skip(?: it| this| that)?|next(?: one)?|later|ask me later|not now|remind me later|pass)$/, () => ({ type: "skip" })],
  [/^(?:thanks?(?: a lot| so much)?|thank you(?: so much| very much| lexa)?|cheers|great|cool|perfect|awesome|nice|brilliant|wonderful|got it|understood|alright|all right|ok|okay|sure|fine|right|correct|sounds good|that'?s (?:fine|good|right|correct)|ok(?:ay)? thanks?|great thanks?)$/, () => ({ type: "ack" })],
  [/^(?:hello|hi|hey|hi there|hello there|good (?:morning|afternoon|evening)|are you there|can you hear me)$/, () => ({ type: "greet" })],
  [/^(?:read|speak|say|play)(?: me)?(?: out)?(?: the)?(?: last| latest| previous| newest)? (?:reply|answer|response|message)(?: aloud| out loud| to me)?$|^read (?:it|that) (?:aloud|out loud|to me)$/, () => ({ type: "readLast" })],
  [/^(?:open|show|go to|take me to|bring up)(?: me)?(?: the)?(?: full| whole)? (?:conversation|chat|answer|reply|response|result|full answer|full reply)(?: in (?:the )?chat)?$/, () => ({ type: "openConversation" })],
  [/^(?:go back|back|previous page|navigate back)$/, () => ({ type: "back" })],
  [/^(?:go forward|forward)$/, () => ({ type: "forward" })],
  [/^(?:new (?:conversation|chat)|start (?:a )?(?:new|fresh) (?:conversation|chat)|start over|let'?s start over|clear (?:the )?(?:conversation|chat))$/, () => ({ type: "newConversation" })],
  [/^(?:scroll|go|jump)(?: to)?(?: the)? (top|bottom)(?: of the page)?$/, (m) => ({ type: "scroll", dir: m[1] as "top" | "bottom" })],
  [/^(?:scroll|page) (down|up)(?: a (?:bit|little|lot))?$/, (m) => ({ type: "scroll", dir: m[1] as "up" | "down" })],
  [/^(?:speak|talk|read)\s+(?:a (?:bit|little) )?(slower|more slowly|faster|more quickly)$/, (m) => ({ type: "speed", direction: /slow/.test(m[1]) ? "slower" : "faster" })],
  [/^(?:slow down|speed up)$/, (m) => ({ type: "speed", direction: m[0] === "slow down" ? "slower" : "faster" })],
  [/^(?:submit(?: (?:the )?form)?|press enter|hit enter|send (?:the )?message|save(?: (?:it|this|changes))?)$/, () => ({ type: "submit" })],
  [/^(?:number\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2})(?:st|nd|rd|th)?(?: one)?$/, (m) => ({
    type: "choice",
    index: NUMBER_WORDS[m[1]] ?? Number(m[1]),
  })],
];

const NAV = /^(?:go to|go|open|show(?: me)?|take me to|navigate to|switch to|bring up|visit|jump to)\s+(.+)$/i;

// Intents that keep the original capitalisation of what was said (values to type, names to click).
const TOGGLES: Rule[] = [
  [/^(?:turn|switch)\s+(on|off)\s+(?:the\s+)?(.+)$/i, (m) => ({ type: "toggle", target: m[2], on: m[1].toLowerCase() === "on" })],
  [/^(enable|disable)\s+(?:the\s+)?(.+)$/i, (m) => ({ type: "toggle", target: m[2], on: m[1].toLowerCase() === "enable" })],
  [/^(check|uncheck|tick|untick)\s+(?:the\s+)?(.+)$/i, (m) => ({ type: "toggle", target: m[2], on: /^(check|tick)$/i.test(m[1]) })],
  [/^toggle\s+(?:the\s+)?(.+)$/i, (m) => ({ type: "toggle", target: m[1], on: null })],
];

const FILL_IN = /^(?:type|enter|write|put)\s+(.+?)\s+(?:in|into|in to)\s+(?:the\s+)?(.+)$/i;
const FILL_SET = /^(?:type|enter|put|write|fill(?: in)?|set|change|update|make)\s+(?:the\s+)?(.+?)\s+(?:to|as|with|equals|is)\s+(.+)$/i;
const DICTATE = /^(?:type|dictate)\s+(.+)$/i;
const FOCUS = /^(?:focus(?: on)?|go to|jump to|select)\s+(?:the\s+)?(.+?)\s+(?:field|box|input|textbox|text box|area)$/i;
const CLICK = /^(click|press|tap|push|hit|activate|choose|select|open|follow)(?:\s+on)?\s+(?:the\s+)?(.+?)(?:\s+(button|link|tab|option|checkbox|switch|menu|item|icon))?$/i;
// Only these verbs are certain to mean "operate a control". The others ("push my changes", "open the pod bay doors")
// are often requests for LEXA, so they are only treated as clicks when a control with that name exists.
const HARD_VERBS = new Set(["click", "press", "tap", "activate"]);

/** Classifies one spoken (or typed) utterance. Wake words must already be removed (see stripWake). */
export function parseCommand(text: string): Command {
  const original = text.trim();
  const t = clean(original);
  const lower = t.toLowerCase();
  if (!t) return { type: "ask", text: original };

  for (const [re, build] of PHRASES) {
    const m = lower.match(re);
    if (m) return build(m, original);
  }

  const nav = t.match(NAV);
  if (nav) {
    const page = matchPage(nav[1]);
    if (page) return { type: "navigate", path: page.path, label: page.label };
  }

  for (const [re, build] of TOGGLES) {
    const m = t.match(re);
    if (m) return build(m, original);
  }
  let m = t.match(FILL_IN);
  if (m) return { type: "fill", field: m[2].trim(), value: m[1].trim() };
  m = t.match(FILL_SET);
  if (m) return { type: "fill", field: m[1].trim(), value: m[2].trim() };
  m = t.match(DICTATE);
  if (m) return { type: "dictate", text: m[1].trim() };
  m = t.match(FOCUS);
  if (m) return { type: "focus", target: m[1].trim() };
  m = t.match(CLICK);
  if (m) {
    const target = m[2].trim();
    const soft = !HARD_VERBS.has(m[1].toLowerCase()) || target.split(/\s+/).length > 8;
    return { type: "click", target, soft, kind: m[3]?.toLowerCase() };
  }
  return { type: "ask", text: original };
}

/** Everything the user can say, for the help panel and for reading aloud. */
export const HELP_SECTIONS: { title: string; items: string[] }[] = [
  { title: "Ask LEXA anything", items: ["Just say it: “Find remote jobs for me”, “Draft a reply to Priya”, “What's on my calendar today?”"] },
  { title: "Go places", items: ["“Go to tasks”, “Open settings”, “Show approvals”, “Go back”, “New conversation”"] },
  { title: "Hear things", items: ["“What's pending?”, “Read my notifications”, “Read the page”, “What can I click?”, “Read more”, “Repeat that”"] },
  { title: "Approvals", items: ["LEXA reads each action to you first. Then say “Approve”, “Reject” or “Skip”."] },
  { title: "Use any screen", items: ["“Click create agent”, “Set name to Travel Planner”, “Turn on auto memory”, “Submit”, “Scroll down”"] },
  { title: "Control voice", items: ["“Stop” interrupts me, “Speak slower” or “Speak faster”, “Go to sleep” (then say “Hey LEXA”), “Stop listening” ends voice mode"] },
];

export const HELP_SPOKEN =
  "Here is what you can say. Ask me anything, for example, find remote jobs for me. " +
  "Say go to tasks, or open settings, to move around. Say what's pending, or read my notifications, to hear updates. " +
  "When I ask for approval I read the action first, then say approve, reject, or skip. " +
  "You can control any screen: say click, then the name of a button, or set a field to a value, or read the page. " +
  "Say stop to interrupt me, speak slower or faster to change my pace, go to sleep to pause, and stop listening to end voice mode.";
