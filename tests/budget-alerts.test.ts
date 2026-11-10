// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { evaluateBudgetAlerts } from "../src/server/budget-alerts.server.ts";
import { getCapturedEmails } from "../src/server/email.ts";

describe("budget alerts", () => {
  const userId = "budget-alerts-user";
  const november = new Date("2026-11-20T12:00:00Z");
  let email = "";
  let run = 0;

  const addExpense = (id: string, date: string, amountMinor: number) =>
    db.insert(schema.transactions).values({
      id,
      user_id: userId,
      account_id: "ba-pln",
      category_id: "ba-food",
      date,
      amount_minor: -amountMinor,
    });

  beforeEach(async () => {
    // Captured emails are module state, so each test uses its own address.
    email = `alerts-${++run}@example.com`;
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: "x",
      email,
      email_verified_at: new Date(),
    });
    await db.insert(schema.accounts).values({
      id: "ba-pln",
      user_id: userId,
      name: "PLN account",
      currency: "PLN",
    });
    await db.insert(schema.categories).values({
      id: "ba-food",
      user_id: userId,
      name: "Food",
      parent_id: null,
    });
    await db.insert(schema.budgets).values({
      id: "ba-budget",
      user_id: userId,
      category_id: "ba-food",
      currency: "PLN",
      limit_minor: 5000,
    });
  });

  afterEach(async () => {
    await db.delete(schema.budget_alerts).where(eq(schema.budget_alerts.user_id, userId));
    await db.delete(schema.budgets).where(eq(schema.budgets.user_id, userId));
    await db.delete(schema.transactions).where(eq(schema.transactions.user_id, userId));
    await db.delete(schema.categories).where(eq(schema.categories.user_id, userId));
    await db.delete(schema.accounts).where(eq(schema.accounts.user_id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("sends one email when a budget goes over, and no second one that month", async () => {
    await addExpense("ba-t1", "2026-11-05", 6000);
    expect(await evaluateBudgetAlerts(userId, november)).toBe(1);

    await addExpense("ba-t2", "2026-11-06", 1000);
    expect(await evaluateBudgetAlerts(userId, november)).toBe(0);

    const emails = getCapturedEmails(email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Food");
    expect(emails[0].text).toContain("60.00 PLN");
    const [alert] = await db
      .select()
      .from(schema.budget_alerts)
      .where(eq(schema.budget_alerts.user_id, userId));
    expect(alert).toMatchObject({ month: "2026-11", status: "sent" });
  });

  it("does not email while spend is at or under the limit", async () => {
    await addExpense("ba-t1", "2026-11-05", 5000);
    expect(await evaluateBudgetAlerts(userId, november)).toBe(0);
    expect(getCapturedEmails(email)).toHaveLength(0);
  });

  it("waits for a verified email without using up the month's alert", async () => {
    await db
      .update(schema.users)
      .set({ email_verified_at: null })
      .where(eq(schema.users.id, userId));
    await addExpense("ba-t1", "2026-11-05", 6000);
    expect(await evaluateBudgetAlerts(userId, november)).toBe(0);

    await db
      .update(schema.users)
      .set({ email_verified_at: new Date() })
      .where(eq(schema.users.id, userId));
    expect(await evaluateBudgetAlerts(userId, november)).toBe(1);
  });

  it("alerts again in a new month", async () => {
    await addExpense("ba-t1", "2026-11-05", 6000);
    await addExpense("ba-t2", "2026-12-03", 6000);
    expect(await evaluateBudgetAlerts(userId, november)).toBe(1);
    expect(
      await evaluateBudgetAlerts(userId, new Date("2026-12-10T12:00:00Z")),
    ).toBe(1);
    expect(getCapturedEmails(email)).toHaveLength(2);
  });
});
