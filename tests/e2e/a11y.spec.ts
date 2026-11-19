/**
 * Accessibility audit (WCAG 2.1 A/AA via axe-core) of every screen, in both themes, with and without the voice bar,
 * plus the dialogs. Voice control and screen readers both rely on accessible names, so this also guards voice.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL!;
const password = "e2e-password-123";

const PAGES = [
  "/", "/assistant", "/tasks", "/tasks?tab=approvals", "/agents", "/agents/new", "/agents/career", "/career",
  "/communication", "/research", "/developer", "/finance", "/trading", "/automations", "/memory", "/integrations",
  "/settings", "/settings?tab=usage", "/settings?tab=security", "/settings?tab=voice", "/settings?tab=preferences",
];

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening|night)/);
}

async function audit(page: Page, label: string): Promise<string[]> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700); // let entrance animations settle so colours are final
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((v) => {
    const first = v.nodes[0];
    return `${label}  ${v.id} (${v.impact}) ×${v.nodes.length}: ${first.target.join(" ")} — ${first.failureSummary?.split("\n")[1]?.trim() ?? v.help}`;
  });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`axe: ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    });

    test("every screen has no WCAG A/AA violations", async ({ page }) => {
      test.setTimeout(240_000);
      await login(page);
      const found: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        found.push(...(await audit(page, path)));
      }
      expect(found, found.join("\n")).toEqual([]);
    });

    test("with the voice bar open, a conversation, and the dialogs", async ({ page }) => {
      test.setTimeout(120_000);
      await login(page);
      const found: string[] = [];

      await page.goto("/assistant");
      await page.getByLabel("Message LEXA").fill("What can you do?");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("I'm LEXA")).toBeVisible({ timeout: 20_000 });
      found.push(...(await audit(page, "conversation")));

      await page.keyboard.press("Alt+KeyV");
      await expect(page.getByRole("region", { name: "Voice control" })).toBeVisible();
      found.push(...(await audit(page, "voice bar open")));

      await page.getByLabel("Type a command for LEXA").fill("help");
      await page.getByLabel("Type a command for LEXA").press("Enter");
      await expect(page.getByRole("dialog", { name: "Talking to LEXA" })).toBeVisible();
      found.push(...(await audit(page, "voice help dialog")));
      await page.keyboard.press("Escape");

      await page.keyboard.press("Control+KeyK");
      await expect(page.getByPlaceholder("Ask LEXA or jump to…")).toBeVisible();
      found.push(...(await audit(page, "command palette")));
      await page.keyboard.press("Escape");

      await page.keyboard.press("Alt+KeyV");
      await page.goto("/memory");
      await page.getByRole("button", { name: "Add memory" }).click();
      await expect(page.getByRole("dialog", { name: "Teach LEXA something" })).toBeVisible();
      found.push(...(await audit(page, "add memory dialog")));
      await page.keyboard.press("Escape");

      await page.goto("/memory");
      await page.getByRole("button", { name: "Retention…" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      found.push(...(await audit(page, "confirm/prompt alertdialog")));

      expect(found, found.join("\n")).toEqual([]);
    });
  });
}

test("login and register pages", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const found: string[] = [];
  for (const path of ["/login", "/register"]) {
    await page.goto(path);
    found.push(...(await audit(page, path)));
  }
  await ctx.close();
  expect(found, found.join("\n")).toEqual([]);
});
