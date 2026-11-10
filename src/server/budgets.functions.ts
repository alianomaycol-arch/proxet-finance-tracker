import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "#/db";
import type { BudgetErrorCode, BudgetErrorResult } from "#/lib/budget-errors";
import { getEntitlements } from "#/server/billing.server";
import {
  MAX_LIMIT_MINOR,
  currentUtcMonth,
  insertBudgetWithinLimit,
  listAccountCurrencies,
  listBudgetViews,
} from "#/server/budgets.server";
import { ownedEntityExists } from "#/server/ownership.server";
import { requireUserId } from "#/server/session";

export const limitMinorSchema = z
  .number()
  .int("Limit must be a whole number of minor units")
  .positive("Limit must be greater than zero")
  .max(MAX_LIMIT_MINOR, "Limit is too large");

const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO code (e.g. PLN, USD)"),
  limitMinor: limitMinorSchema,
});

// Strict: only the limit is editable. Sending a category or currency is a
// validation error rather than being silently ignored.
const updateBudgetSchema = z.strictObject({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

function failure(code: BudgetErrorCode, error: string): BudgetErrorResult {
  return { error, code };
}

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async () => {
    const userId = await requireUserId();
    const month = currentUtcMonth();
    const [budgets, entitlements, currencies] = await Promise.all([
      listBudgetViews(userId, month),
      getEntitlements(userId),
      listAccountCurrencies(userId),
    ]);
    return {
      month,
      plan: entitlements.plan,
      /** null = unlimited. */
      limit: entitlements.maxBudgets,
      currencies,
      budgets,
    };
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();

    if (!(await ownedEntityExists("category", userId, data.categoryId))) {
      return failure("budget_category_not_found", "Category does not exist");
    }
    const currencies = await listAccountCurrencies(userId);
    if (!currencies.includes(data.currency)) {
      return failure(
        "budget_currency_invalid",
        "Currency must match one of your accounts",
      );
    }

    const result = await insertBudgetWithinLimit(userId, data);
    if (!result.ok) {
      const { ok: _ok, ...error } = result;
      return error;
    }
    return result.budget;
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    const updated = await db
      .update(schema.budgets)
      .set({ limit_minor: data.limitMinor, updated_at: new Date() })
      .where(
        and(
          eq(schema.budgets.id, data.id),
          eq(schema.budgets.user_id, userId),
        ),
      )
      .returning({ id: schema.budgets.id });
    if (updated.length === 0) {
      return failure("budget_not_found", "Budget not found");
    }
    return { success: true };
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }) => {
    const userId = await requireUserId();
    // Alert rows are kept on purpose: they are keyed by category and month,
    // so deleting and recreating a budget cannot send a second email.
    const deleted = await db
      .delete(schema.budgets)
      .where(
        and(
          eq(schema.budgets.id, data.id),
          eq(schema.budgets.user_id, userId),
        ),
      )
      .returning({ id: schema.budgets.id });
    if (deleted.length === 0) {
      return failure("budget_not_found", "Budget not found");
    }
    return { success: true };
  });
