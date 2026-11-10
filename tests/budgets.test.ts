// @vitest-environment node
// Required: TanStack Start's import protection mocks server modules in jsdom (client) environment.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import {
  collectSubtree,
  currentUtcMonth,
  insertBudgetWithinLimit,
  listAccountCurrencies,
  listBudgetViews,
  monthRange,
  rollUpSpend,
} from "../src/server/budgets.server.ts";
import { limitMinorSchema } from "../src/server/budgets.functions.ts";
import { env } from "../src/server/env.ts";

describe("budget month helpers", () => {
  it("formats the current UTC month", () => {
    expect(currentUtcMonth(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(currentUtcMonth(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });

  it("builds a half-open range, rolling over the year", () => {
    expect(monthRange("2026-02")).toEqual({ start: "2026-02-01", end: "2026-03-01" });
    expect(monthRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
    expect(() => monthRange("2026-13")).toThrow(/Invalid month/);
  });
});

describe("budget limit validation", () => {
  it("accepts a positive whole number of minor units", () => {
    expect(limitMinorSchema.safeParse(3000).success).toBe(true);
  });

  it.each([
    ["a negative amount", -100],
    ["zero", 0],
    ["a fraction of a minor unit", 12.5],
    ["a numeric string", "3000"],
  ])("rejects %s", (_label, value) => {
    expect(limitMinorSchema.safeParse(value).success).toBe(false);
  });
});

describe("budget category roll-up", () => {
  const tree = [
    { id: "food", parent_id: null },
    { id: "groceries", parent_id: "food" },
    { id: "organic", parent_id: "groceries" },
    { id: "transport", parent_id: null },
  ];

  it("collects descendants at any depth", () => {
    expect(collectSubtree(tree, "food")).toEqual(
      new Set(["food", "groceries", "organic"]),
    );
    expect(collectSubtree(tree, "groceries")).toEqual(
      new Set(["groceries", "organic"]),
    );
  });

  it("terminates on cyclic parent links", () => {
    const cyclic = [
      { id: "a", parent_id: "b" },
      { id: "b", parent_id: "a" },
    ];
    expect(collectSubtree(cyclic, "a")).toEqual(new Set(["a", "b"]));
  });

  it("sums only the budget currency within the subtree; overlapping budgets both count", () => {
    const spend = rollUpSpend(
      [
        { id: "b-food", category_id: "food", currency: "PLN" },
        { id: "b-groceries", category_id: "groceries", currency: "PLN" },
      ],
      tree,
      [
        { category_id: "food", currency: "PLN", spent_minor: 100 },
        { category_id: "organic", currency: "PLN", spent_minor: 50 },
        { category_id: "organic", currency: "USD", spent_minor: 999 },
        { category_id: "transport", currency: "PLN", spent_minor: 70 },
      ],
    );
    expect(spend.get("b-food")).toBe(150);
    expect(spend.get("b-groceries")).toBe(50);
  });
});

describe("budget spend and creation (database)", () => {
  const userId = "budgets-test-user";
  const month = "2026-11";

  const addTransaction = (
    id: string,
    accountId: string,
    categoryId: string | null,
    date: string,
    amountMinor: number,
  ) =>
    db.insert(schema.transactions).values({
      id,
      user_id: userId,
      account_id: accountId,
      category_id: categoryId,
      date,
      amount_minor: amountMinor,
    });

  beforeEach(async () => {
    await db.insert(schema.users).values({
      id: userId,
      username: userId,
      password_hash: "x",
    });
    await db.insert(schema.accounts).values([
      { id: "bt-pln", user_id: userId, name: "PLN account", currency: "PLN" },
      { id: "bt-usd", user_id: userId, name: "USD account", currency: "USD" },
    ]);
    await db.insert(schema.categories).values([
      { id: "bt-food", user_id: userId, name: "Food", parent_id: null },
      { id: "bt-groceries", user_id: userId, name: "Groceries", parent_id: "bt-food" },
      { id: "bt-organic", user_id: userId, name: "Organic", parent_id: "bt-groceries" },
      { id: "bt-fun", user_id: userId, name: "Fun", parent_id: null },
      { id: "bt-travel", user_id: userId, name: "Travel", parent_id: null },
      { id: "bt-home", user_id: userId, name: "Home", parent_id: null },
    ]);
  });

  afterEach(async () => {
    await db.delete(schema.budgets).where(eq(schema.budgets.user_id, userId));
    await db.delete(schema.transactions).where(eq(schema.transactions.user_id, userId));
    await db.delete(schema.categories).where(eq(schema.categories.user_id, userId));
    await db.delete(schema.accounts).where(eq(schema.accounts.user_id, userId));
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.user_id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("counts expenses of the month in the category subtree, ignoring income, other months and other currencies", async () => {
    await addTransaction("bt-t1", "bt-pln", "bt-food", "2026-11-01", -1000);
    await addTransaction("bt-t2", "bt-pln", "bt-groceries", "2026-11-15", -2000);
    await addTransaction("bt-t3", "bt-pln", "bt-organic", "2026-11-30", -500);
    // Refund in the subtree must not reduce spend.
    await addTransaction("bt-t4", "bt-pln", "bt-groceries", "2026-11-16", 1500);
    // Outside the month (both boundaries).
    await addTransaction("bt-t5", "bt-pln", "bt-food", "2026-10-31", -9000);
    await addTransaction("bt-t6", "bt-pln", "bt-food", "2026-12-01", -9000);
    // Other currency, other category, uncategorized.
    await addTransaction("bt-t7", "bt-usd", "bt-food", "2026-11-10", -9000);
    await addTransaction("bt-t8", "bt-pln", "bt-fun", "2026-11-10", -9000);
    await addTransaction("bt-t9", "bt-pln", null, "2026-11-10", -9000);

    await insertBudgetWithinLimit(userId, {
      categoryId: "bt-food",
      currency: "PLN",
      limitMinor: 3000,
    });

    const [view] = await listBudgetViews(userId, month);
    expect(view.category_name).toBe("Food");
    expect(view.spent_minor).toBe(3500);
    expect(view.remaining_minor).toBe(-500);
    expect(view.over_budget).toBe(true);
  });

  it("is not over budget when spend equals the limit", async () => {
    await addTransaction("bt-t1", "bt-pln", "bt-fun", "2026-11-05", -3000);
    await insertBudgetWithinLimit(userId, {
      categoryId: "bt-fun",
      currency: "PLN",
      limitMinor: 3000,
    });
    const [view] = await listBudgetViews(userId, month);
    expect(view.remaining_minor).toBe(0);
    expect(view.over_budget).toBe(false);
  });

  it("lists the currencies of the user's accounts", async () => {
    expect(await listAccountCurrencies(userId)).toEqual(["PLN", "USD"]);
  });

  it("rejects a second budget for the same category", async () => {
    const input = { categoryId: "bt-food", currency: "PLN", limitMinor: 100 };
    expect((await insertBudgetWithinLimit(userId, input)).ok).toBe(true);
    const duplicate = await insertBudgetWithinLimit(userId, input);
    expect(duplicate).toMatchObject({ ok: false, code: "budget_exists" });
  });

  it("rejects a budget for another category with the same name, ignoring case and spaces", async () => {
    await db.insert(schema.categories).values({
      id: "bt-home-groceries",
      user_id: userId,
      name: " groceries ",
      parent_id: "bt-home",
    });
    const base = { currency: "PLN", limitMinor: 100 };
    expect(
      (await insertBudgetWithinLimit(userId, { ...base, categoryId: "bt-groceries" })).ok,
    ).toBe(true);
    const duplicate = await insertBudgetWithinLimit(userId, {
      ...base,
      categoryId: "bt-home-groceries",
    });
    expect(duplicate).toMatchObject({ ok: false, code: "budget_exists" });
  });

  it("caps free users at the plan limit and lets pro users go beyond it", async () => {
    const categories = ["bt-food", "bt-fun", "bt-travel", "bt-home"];
    for (const categoryId of categories.slice(0, env.billing.freeMaxBudgets)) {
      const result = await insertBudgetWithinLimit(userId, {
        categoryId,
        currency: "PLN",
        limitMinor: 100,
      });
      expect(result.ok).toBe(true);
    }
    const blocked = await insertBudgetWithinLimit(userId, {
      categoryId: "bt-home",
      currency: "PLN",
      limitMinor: 100,
    });
    expect(blocked).toMatchObject({
      ok: false,
      code: "budget_limit_reached",
      limit: env.billing.freeMaxBudgets,
    });

    await db.insert(schema.subscriptions).values({
      user_id: userId,
      plan: "pro",
      status: "active",
    });
    const allowed = await insertBudgetWithinLimit(userId, {
      categoryId: "bt-home",
      currency: "PLN",
      limitMinor: 100,
    });
    expect(allowed.ok).toBe(true);
  });

  it("does not exceed the cap under concurrent creates", async () => {
    const results = await Promise.all(
      ["bt-food", "bt-fun", "bt-travel", "bt-home"].map((categoryId) =>
        insertBudgetWithinLimit(userId, {
          categoryId,
          currency: "PLN",
          limitMinor: 100,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(env.billing.freeMaxBudgets);
  });
});
