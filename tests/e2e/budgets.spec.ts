import { test, expect, type Page } from "./fixtures";

//
// Budgets use the fixture user's default categories and seeded "Main" (PLN)
// account. Spending is added through the transactions UI so the over-budget
// email goes through the same trigger a real expense hits. Fixture users are
// created verified, so they are eligible for alerts.

async function addBudget(page: Page, category: string, limit: string) {
  await page.getByRole("button", { name: "Add budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add budget" });
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Add budget" }).click();
  await expect(dialog).toBeHidden();
}

function budgetCard(page: Page, category: string) {
  return page.getByTestId("budget-card").filter({ hasText: category });
}

async function addGroceriesExpense(
  page: Page,
  description: string,
  amount: string,
) {
  await page.goto("/transactions");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add Transaction" })
    .click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  // Budgets count the current UTC month; midday avoids timezone edge shifts.
  const today = new Date().toISOString().slice(0, 10);
  await modal.getByLabel("Date").fill(`${today}T12:00`);
  await modal.getByLabel("Description").fill(description);
  await modal
    .getByRole("spinbutton", { name: "Amount", exact: true })
    .fill(amount);
  await modal.getByLabel("Account").selectOption("Main (PLN)");
  await modal.getByLabel("Category").selectOption("Groceries");
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function budgetEmails(page: Page, to: string) {
  const res = await page.request.get(
    `/test-emails?to=${encodeURIComponent(to)}`,
  );
  const { emails } = (await res.json()) as {
    emails: { subject: string; text: string }[];
  };
  return emails.filter((e) => e.subject.includes("budget"));
}

test.describe("budgets page", () => {
  test("is reachable from the sidebar and starts empty", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("No budgets yet")).toBeVisible();
    await expect(page.getByTestId("budget-usage")).toHaveText(
      "0 of 3 budgets used",
    );
  });

  test("creates, edits and removes a budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");

    await addBudget(page, "Groceries", "300");
    const card = budgetCard(page, "Groceries");
    await expect(card).toContainText(/300\.00/);
    await expect(card).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("budget-usage")).toHaveText(
      "1 of 3 budgets used",
    );

    await card.getByTestId("edit-budget").click();
    const dialog = page.getByRole("dialog", { name: "Edit budget" });
    await dialog.getByLabel("Monthly limit").fill("450");
    await dialog.getByRole("button", { name: "Save budget" }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText(/450\.00/);

    await card.getByTestId("delete-budget").click();
    await page
      .getByRole("alertdialog", { name: "Remove budget?" })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(card).toBeHidden();
    await expect(page.getByText("No budgets yet")).toBeVisible();
  });

  test("marks a budget over its limit and emails the owner once", async ({
    page,
    signedInUser,
  }) => {
    const email = `${signedInUser.username}@example.com`;
    await page.goto("/budgets");
    await addBudget(page, "Groceries", "50");

    await addGroceriesExpense(page, "Weekly shop", "60");
    await page.goto("/budgets");
    const card = budgetCard(page, "Groceries");
    await expect(card).toHaveAttribute("data-status", "over");
    await expect(card).toContainText("Over budget");
    await expect(card).toContainText(/Over by 10\.00/);

    await expect.poll(async () => (await budgetEmails(page, email)).length).toBe(1);
    const [alert] = await budgetEmails(page, email);
    expect(alert.subject).toBe("You went over your Groceries budget");
    expect(alert.text).toContain("/budgets");

    // A second expense and a full sweep must not send the alert again.
    await addGroceriesExpense(page, "Snack", "5");
    const sweep = await page.request.post("/test-run-sweep");
    expect(sweep.ok()).toBe(true);
    expect(await budgetEmails(page, email)).toHaveLength(1);
  });
});

test.describe("budget limit gating", () => {
  test("free users get 3 budgets and are blocked with an upgrade hint on the fourth", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    for (const category of ["Groceries", "Housing", "Transport"]) {
      await addBudget(page, category, "100");
      await expect(budgetCard(page, category)).toBeVisible();
    }
    await expect(page.getByTestId("budget-usage")).toContainText(
      "3 of 3 budgets used",
    );
    await expect(
      page.getByRole("link", { name: "Upgrade to Pro for unlimited budgets" }),
    ).toBeVisible();

    await addBudget(page, "Entertainment", "100");
    await expect(
      page.getByRole("alert").filter({ hasText: /limited to 3 budgets/ }),
    ).toBeVisible();
    await expect(budgetCard(page, "Entertainment")).toBeHidden();
  });

  test("pro users can create budgets beyond the free limit", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    const res = await page.request.post("/test-set-plan?plan=pro");
    expect(res.ok()).toBe(true);
    await page.goto("/budgets");

    for (const category of ["Groceries", "Housing", "Transport", "Entertainment"]) {
      await addBudget(page, category, "100");
      await expect(budgetCard(page, category)).toBeVisible();
    }
    await expect(page.getByTestId("budget-usage")).toHaveText(
      "4 budgets · unlimited on Pro",
    );
  });
});
