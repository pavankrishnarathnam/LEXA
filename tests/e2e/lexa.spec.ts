/**
 * End-to-end: real Next.js frontend + real FastAPI backend + real worker, Postgres and Redis.
 * The backend runs via backend/tests/e2e_server.py which swaps the LLM for a deterministic scripted provider.
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

test.describe.serial("LEXA", () => {
  test("register and land on the command center", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Ada Lovelace");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Ada");
    await expect(page.getByRole("heading", { name: "Active tasks" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Career/ }).first()).toBeVisible();
  });

  test("unauthenticated users are redirected to login", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/login\?next=%2Ftasks/);
    await ctx.close();
  });

  test("assistant answers a direct question", async ({ page }) => {
    await login(page);
    await page.goto("/assistant");
    await page.getByLabel("Message LEXA").fill("What can you do?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]+/);
    await expect(page.getByText("I'm LEXA")).toBeVisible({ timeout: 20_000 });
  });

  test("parallel multi-agent task reports honestly without connected integrations", async ({ page }) => {
    await login(page);
    await page.goto("/assistant");
    await page.getByLabel("Message LEXA").fill("Research the launch and email Alex an update");
    await page.getByRole("button", { name: "Send" }).click();
    // Gmail isn't connected in e2e, so the agent can't use gmail tools: verify the plan + final honest reply.
    await expect(page.getByText(/waiting for your approval|Research summary|not been sent/i).first()).toBeVisible({ timeout: 30_000 });
    await page.goto("/tasks");
    await expect(page.getByText("Email and research").first()).toBeVisible();
    await page.getByText("Email and research").first().click();
    await expect(page.getByText("Execution plan & agent steps")).toBeVisible();
    await expect(page.getByText("communication").first()).toBeVisible();
  });

  test("external action waits for approval and runs only after approval", async ({ page }) => {
    await login(page);
    await page.goto("/assistant");
    await page.getByLabel("Message LEXA").fill("Set up a weekly review every Friday");
    await page.getByRole("button", { name: "Send" }).click();
    const approve = page.getByRole("button", { name: "Approve & run" });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/automation_create/).first()).toBeVisible();
    // Not executed yet
    await page.request.get("/api/automations").then(async (r) => expect(await r.json()).toHaveLength(0));
    await approve.click();
    await expect.poll(async () => (await (await page.request.get("/api/automations")).json()).length, { timeout: 20_000 }).toBe(1);
    await page.goto("/automations");
    await expect(page.getByText("Weekly review", { exact: true })).toBeVisible();
    await page.goto("/tasks?tab=approvals");
    await expect(page.getByText("executed").first()).toBeVisible();
  });

  test("create a custom agent from the dashboard", async ({ page }) => {
    await login(page);
    await page.goto("/agents/new");
    await page.getByLabel("Name", { exact: true }).fill("Travel Planner");
    await page.getByLabel("Slug", { exact: true }).fill("travel");
    await page.getByLabel("System prompt").fill("You plan trips within the user's budget and preferences.");
    await page.getByRole("checkbox", { name: /^web_fetch/ }).check();
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/agents\/travel/);
    await page.goto("/agents");
    await expect(page.getByRole("link", { name: "Travel Planner" })).toBeVisible();
  });

  test("memory: add, reject secrets, search, delete", async ({ page }) => {
    await login(page);
    await page.goto("/memory");
    await page.getByRole("button", { name: "Add memory" }).click();
    await page.getByLabel("Fact").fill("I prefer meetings after 11am");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("I prefer meetings after 11am")).toBeVisible();
    await page.getByRole("button", { name: "Add memory" }).click();
    await page.getByLabel("Fact").fill("my password is hunter22");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Refusing to store credentials/).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("my password is hunter22")).toHaveCount(0);
    // Target the card by its text: background memory extraction may add other memories to the list at any moment.
    await page.getByRole("listitem").filter({ hasText: "I prefer meetings after 11am" }).getByRole("button", { name: /^Delete memory/ }).click();
    await expect(page.getByText("I prefer meetings after 11am")).toHaveCount(0);
  });

  test("permission mode and integrations pages", async ({ page }) => {
    await login(page);
    await page.goto("/settings");
    await page.getByRole("radio", { name: /Read & analyze/ }).click();
    await expect(page.getByRole("radio", { name: /Read & analyze/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: /Prepare & approve/ }).click();
    await page.goto("/integrations");
    await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
    await expect(page.getByText("WhatsApp Business", { exact: true })).toBeVisible();
  });

  test("trading desk works with no AI model: reached from the sidebar, rules, then a real run", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Trading" }).first().click();
    await expect(page).toHaveURL(/\/trading/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Trading desk");
    await expect(page.getByText("No AI key needed.")).toBeVisible();
    await expect(page.getByText(/^Market (open|closed)$/)).toBeVisible(); // from the built-in NYSE calendar: no network, no model

    // Sizing refuses until the user has set their own numbers.
    await page.getByRole("tab", { name: "Plan a trade" }).click();
    await expect(page.getByRole("button", { name: "Size it" })).toBeDisabled();

    await page.getByRole("tab", { name: "My rules" }).click();
    await page.getByLabel("Budget ($)").fill("5000");
    await page.getByLabel("Most you accept to lose on one trade ($)").fill("50");
    await page.getByRole("button", { name: "Save my rules" }).click();
    await expect(page.getByText("Ready to size trades and check risk.")).toBeVisible();

    // A real run through Next.js, the API, Redis and the sandboxed script. Without a saved plan it says what to do first.
    await page.getByRole("tab", { name: "Plan a trade" }).click();
    await page.getByRole("button", { name: "Size it" }).click();
    await expect(page.getByRole("region", { name: "4. How many shares: output" })).toContainText("no plan", { timeout: 30_000 });
    await expect(page.getByRole("region", { name: "4. How many shares: output" })).toContainText("trader_exit_plan");

    // The result is still there after a reload.
    await page.reload();
    await page.getByRole("tab", { name: "Plan a trade" }).click();
    await expect(page.getByRole("region", { name: "4. How many shares: output" })).toContainText("no plan");
  });

  test("command palette navigates @mobile", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: /Ask LEXA or search/ }).click();
    await page.getByPlaceholder("Ask LEXA or jump to…").fill("Automations");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/automations/);
  });
});
