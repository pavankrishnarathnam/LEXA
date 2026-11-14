/**
 * Voice end to end, in a real browser with a fake microphone (see playwright.config.ts).
 * Speech recognition is stubbed on the server (the harness returns the text the test queued), so these tests prove
 * the whole path *around* it: microphone → detector → upload → command grammar → UI control → spoken reply →
 * approval rules. They do not measure how well a real speech model understands a real voice.
 */
import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL!;
const password = "e2e-password-123";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening|night)/);
}

/** What the next spoken utterances will be "transcribed" as. */
async function queue(page: Page, ...texts: string[]) {
  const r = await page.request.get(`/api/test/voice-script?texts=${encodeURIComponent(texts.join("|"))}`);
  expect(r.ok()).toBeTruthy();
}

const toggle = (page: Page) => page.locator("header").getByRole("button", { name: "Voice mode", exact: true });
const bar = (page: Page) => page.getByRole("region", { name: "Voice control" });
const box = (page: Page) => page.getByLabel("Type a command for LEXA");

/** Turns voice on with the hotkey, retrying only while the page is still hydrating (a press before then is lost). */
async function voiceOn(page: Page) {
  await expect(toggle(page)).toBeVisible();
  await expect(async () => {
    if ((await toggle(page).getAttribute("aria-pressed")) !== "true") await page.keyboard.press("Alt+KeyV");
    await expect(bar(page)).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 15_000 });
}
async function typed(page: Page, command: string) {
  await box(page).fill(command);
  await box(page).press("Enter");
}

// Names are unique per run so a re-run against the same account never trips LEXA's duplicate-action guard.
const run = Date.now().toString().slice(-6);

test.describe.serial("voice", () => {
  test("Alt+V toggles voice mode and the bar reports state", async ({ page }) => {
    await login(page);
    await voiceOn(page);
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(bar(page).getByTestId("voice-phase")).toHaveText(/Listening|Hearing|Starting/);
    await page.keyboard.press("Alt+KeyV");
    await expect(bar(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("typed voice commands navigate and read without touching the page", async ({ page }) => {
    await login(page);
    await voiceOn(page);
    await typed(page, "go to tasks");
    await expect(page).toHaveURL(/\/tasks$/);
    await typed(page, "open voice settings");
    await expect(page).toHaveURL(/\/settings\?tab=voice/);
    await expect(page.getByText("Speech recognition")).toBeVisible();
    await typed(page, "where am I");
    await expect(bar(page).getByTestId("voice-said")).toContainText("You are on Settings");
    await typed(page, "what can I click");
    await expect(bar(page).getByTestId("voice-said")).toContainText(/button|tab/);
    await typed(page, "help");
    await expect(page.getByRole("dialog", { name: "Talking to LEXA" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Talking to LEXA" })).toHaveCount(0);
    await typed(page, "stop listening");
    await expect(bar(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test("a spoken sentence travels microphone → detector → upload → command", async ({ page }) => {
    await login(page);
    await queue(page, "open automations");
    await voiceOn(page);
    await expect(page).toHaveURL(/\/automations/, { timeout: 25_000 });
    await expect(bar(page).getByTestId("voice-heard")).toContainText("open automations");
    await page.keyboard.press("Alt+KeyV");
  });

  test("approval by voice: read in full, then approved by the spoken word", async ({ page }) => {
    await login(page);
    await page.goto("/assistant");
    await page.getByLabel("Message LEXA").fill(`Set up a monthly report ${run} every Friday`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve & run" })).toBeVisible({ timeout: 30_000 });
    const before = (await (await page.request.get("/api/automations")).json()).length;

    await queue(page, "review approvals", "approve");
    await voiceOn(page);
    // 1) LEXA reads the whole action first...
    await expect(bar(page).getByTestId("voice-said")).toContainText(/Say approve, reject, or skip/, { timeout: 25_000 });
    await expect(bar(page).getByTestId("voice-said")).toContainText(/operations agent/i);
    await expect(bar(page).getByTestId("voice-said")).toContainText(new RegExp(`Monthly report ${run}`, "i"));
    await expect(bar(page).getByTestId("voice-awaiting")).toBeVisible();
    expect((await (await page.request.get("/api/automations")).json()).length).toBe(before); // nothing ran yet
    // 2) ...then the spoken "approve" is accepted.
    await expect.poll(async () => (await (await page.request.get("/api/automations")).json()).length, { timeout: 30_000 }).toBe(before + 1);
    // The transcript keeps everything LEXA said, including the confirmation that came before the "Done: ..." notice.
    await bar(page).getByText("Transcript").click();
    await expect(bar(page).getByRole("log")).toContainText("Approved. Running it now.");
    await expect(bar(page).getByRole("log")).toContainText(/running every Friday at 5 PM/);
    await page.keyboard.press("Alt+KeyV");
  });

  test("typed 'never mind' leaves an approval pending and 'reject' rejects it", async ({ page }) => {
    await login(page);
    await page.goto("/assistant");
    await page.getByLabel("Message LEXA").fill(`Set up a quarterly summary ${run} every Friday`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve & run" })).toBeVisible({ timeout: 30_000 });
    const before = (await (await page.request.get("/api/automations")).json()).length;
    await voiceOn(page);
    await typed(page, "review approvals");
    await expect(bar(page).getByTestId("voice-awaiting")).toBeVisible({ timeout: 15_000 });
    await typed(page, "never mind");
    await expect(bar(page).getByTestId("voice-awaiting")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve & run" })).toBeVisible();
    await typed(page, "click reject");
    await expect(page.getByRole("button", { name: "Approve & run" })).toHaveCount(0, { timeout: 15_000 });
    expect((await (await page.request.get("/api/automations")).json()).length).toBe(before);
  });

  test("any screen by voice: fill a form and click a button", async ({ page }) => {
    await login(page);
    await page.goto("/agents/new");
    await voiceOn(page);
    await typed(page, `set name to Voice Agent ${run}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(`Voice Agent ${run}`);
    await typed(page, `set slug to voice-agent-${run}`);
    await expect(page.getByLabel("Slug", { exact: true })).toHaveValue(`voice-agent-${run}`);
    // The sentence-ending full stop that speech recognition adds is not part of what you meant to type.
    await typed(page, "set system prompt to You answer in one short sentence.");
    await expect(page.getByLabel("System prompt")).toHaveValue("You answer in one short sentence");
    await typed(page, "click create agent");
    await expect(page).toHaveURL(new RegExp(`/agents/voice-agent-${run}`), { timeout: 15_000 });
  });

  test("the app's own confirmation dialog is read aloud and answered by the spoken word", async ({ page }) => {
    await login(page);
    await page.goto(`/agents/voice-agent-${run}`);
    // A modal dialog traps keyboard focus (so the typed box is unreachable by design): the answer is spoken.
    await queue(page, "no");
    await voiceOn(page);
    await typed(page, "click delete");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(bar(page).getByTestId("voice-said")).toContainText(/Say yes or no/);
    await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: 15_000 }); // "no" closed it...
    await expect(page).toHaveURL(new RegExp(`/agents/voice-agent-${run}`)); // ...and nothing was deleted
    await page.keyboard.press("Alt+KeyV");
    await expect(bar(page)).toHaveCount(0);

    await queue(page, "yes");
    await voiceOn(page);
    await typed(page, "click delete");
    await expect(page).toHaveURL(/\/agents$/, { timeout: 20_000 }); // "yes" confirmed it
    await expect(page.getByRole("link", { name: `Voice Agent ${run}` })).toHaveCount(0);
    await page.keyboard.press("Alt+KeyV");
  });

  test("a request spoken on any page is sent to LEXA and the answer is read back", async ({ page }) => {
    await login(page);
    await page.goto("/finance");
    await queue(page, "What can you do?");
    await voiceOn(page);
    await expect(bar(page).getByTestId("voice-said")).toContainText("I'm LEXA", { timeout: 40_000 });
    await typed(page, "open the conversation");
    await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]+/);
    await expect(page.getByText("I'm LEXA").first()).toBeVisible();
  });

  test("chat requests made while voice is on appear in the open conversation", async ({ page }) => {
    await login(page);
    await page.goto("/assistant");
    await voiceOn(page);
    await typed(page, "Tell me a fun fact");
    await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]+/, { timeout: 20_000 });
    await expect(page.getByText("You said:").first()).toBeVisible({ timeout: 30_000 });
    await typed(page, "read the last reply");
    await expect(bar(page).getByTestId("voice-said")).toContainText("fun fact", { timeout: 10_000 });
  });

  test("without speech recognition configured, voice mode still works as text-only and says why", async ({ page }) => {
    await page.request.get("/api/test/voice-available?on=0");
    try {
      const caps = page.waitForResponse((r) => r.url().includes("/api/voice/capabilities"));
      await login(page);
      await caps;
      await voiceOn(page);
      await expect(bar(page).getByTestId("voice-phase")).toHaveText("Voice (text only)");
      await expect(bar(page)).toContainText("OPENAI_API_KEY");
      await typed(page, "go to tasks");
      await expect(page).toHaveURL(/\/tasks$/);
      await typed(page, "stop listening");
      await expect(bar(page)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await page.request.get("/api/test/voice-available?on=1");
    }
  });
});
