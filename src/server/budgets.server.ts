import { and, asc, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { budgetStatus } from "#/lib/budgets";
import { getEntitlements } from "#/server/billing.server";

//
// Monthly category budgets: spend roll-up and plan-gated creation.
// Server-only — imported by budgets.functions.ts handlers. Spend is never
// stored; it is computed from transactions for the requested month, so every
// write path that changes a transaction is reflected without bookkeeping.

type Db = typeof defaultDb;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// --- Pure helpers (no database) -------------------------------------------

/** UTC calendar month containing `now`, as 'YYYY-MM'. */
export function currentUtcMonth(now: Date = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

/** Half-open date range [start, end) covering `month` ('YYYY-MM'). */
export function monthRange(month: string): { start: string; end: string } {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`Invalid month: ${month}`);
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const next =
    monthNumber === 12
      ? `${year + 1}-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
  return { start: `${month}-01`, end: `${next}-01` };
}

export interface CategoryNode {
  id: string;
  parent_id: string | null;
}

/** `rootId` plus all of its descendants at any depth. `parent_id` has no FK,
 * so the walk keeps a visited set to stay safe on cyclic data. */
export function collectSubtree(
  categories: CategoryNode[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parent_id) continue;
    const siblings = children.get(category.parent_id) ?? [];
    siblings.push(category.id);
    children.set(category.parent_id, siblings);
  }
  const visited = new Set<string>();
  const stack = [rootId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return visited;
}

export interface SpendRow {
  category_id: string;
  currency: string;
  spent_minor: number;
}

export interface BudgetScope {
  id: string;
  category_id: string;
  currency: string;
}

/** Spend per budget id: the sum of the budget currency's expense rows whose
 * category lies in the budget category's subtree. */
export function rollUpSpend(
  budgets: BudgetScope[],
  categories: CategoryNode[],
  spendRows: SpendRow[],
): Map<string, number> {
  const spend = new Map<string, number>();
  for (const budget of budgets) {
    const subtree = collectSubtree(categories, budget.category_id);
    let total = 0;
    for (const row of spendRows) {
      if (row.currency === budget.currency && subtree.has(row.category_id)) {
        total += row.spent_minor;
      }
    }
    spend.set(budget.id, total);
  }
  return spend;
}

// --- Queries ----------------------------------------------------------------

const accountCurrency = sql<string>`COALESCE(${schema.accounts.currency}, 'PLN')`;

/** Expenses (negative amounts only) of `month`, grouped by category and
 * account currency. Income and refunds never reduce spend. */
async function loadSpendRows(
  userId: string,
  month: string,
  db: Db,
): Promise<SpendRow[]> {
  const { start, end } = monthRange(month);
  const rows = await db
    .select({
      category_id: schema.transactions.category_id,
      currency: accountCurrency,
      spent_minor:
        sql<number>`SUM(ABS(${schema.transactions.amount_minor}))`.mapWith(Number),
    })
    .from(schema.transactions)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.account_id),
    )
    .where(
      and(
        eq(schema.transactions.user_id, userId),
        gte(schema.transactions.date, start),
        lt(schema.transactions.date, end),
        lt(schema.transactions.amount_minor, 0),
        isNotNull(schema.transactions.category_id),
      ),
    )
    .groupBy(schema.transactions.category_id, accountCurrency);
  return rows.flatMap((row) =>
    row.category_id ? [{ ...row, category_id: row.category_id }] : [],
  );
}

/** Spend per budget id for `month`: one category load, one aggregate query. */
export async function computeBudgetSpend(
  userId: string,
  month: string,
  budgets: BudgetScope[],
  db: Db = defaultDb,
): Promise<Map<string, number>> {
  if (budgets.length === 0) return new Map();
  const categories = await db
    .select({
      id: schema.categories.id,
      parent_id: schema.categories.parent_id,
    })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  const spendRows = await loadSpendRows(userId, month, db);
  return rollUpSpend(budgets, categories, spendRows);
}

export interface BudgetView {
  id: string;
  category_id: string;
  category_name: string;
  category_color: string | null;
  currency: string;
  limit_minor: number;
  spent_minor: number;
  /** limit - spent; negative when over budget. */
  remaining_minor: number;
  over_budget: boolean;
}

/** The user's budgets with their spend for `month`. */
export async function listBudgetViews(
  userId: string,
  month: string,
  db: Db = defaultDb,
): Promise<BudgetView[]> {
  const budgets = await db
    .select({
      id: schema.budgets.id,
      category_id: schema.budgets.category_id,
      category_name: schema.categories.name,
      category_color: schema.categories.color,
      currency: schema.budgets.currency,
      limit_minor: schema.budgets.limit_minor,
    })
    .from(schema.budgets)
    .innerJoin(
      schema.categories,
      eq(schema.categories.id, schema.budgets.category_id),
    )
    .where(eq(schema.budgets.user_id, userId))
    .orderBy(asc(schema.categories.name));
  const spend = await computeBudgetSpend(userId, month, budgets, db);
  return budgets.map((budget) => {
    const spent = spend.get(budget.id) ?? 0;
    return {
      ...budget,
      spent_minor: spent,
      remaining_minor: budget.limit_minor - spent,
      over_budget: budgetStatus(spent, budget.limit_minor) === "over",
    };
  });
}

/** Currencies the user can budget in: those of their accounts. */
export async function listAccountCurrencies(
  userId: string,
  db: Db = defaultDb,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ currency: accountCurrency })
    .from(schema.accounts)
    .where(eq(schema.accounts.user_id, userId));
  return rows.map((row) => row.currency).sort();
}

export type CreateBudgetResult =
  | {
      ok: true;
      budget: {
        id: string;
        category_id: string;
        currency: string;
        limit_minor: number;
      };
    }
  | { ok: false; code: "budget_exists"; error: string }
  | {
      ok: false;
      code: "budget_limit_reached";
      /** Echoed to the client so the UI can localize the message. */
      limit: number;
      error: string;
    };

/**
 * Insert a budget unless a category with the same name (trimmed,
 * case-insensitive) already has one, or the plan cap is reached. Budgets are
 * shown by category name, and category names are not unique (e.g. "Groceries"
 * under two parents). The checks and the insert run in one transaction holding
 * a lock on the user's row, so concurrent creates cannot bypass them. Existing
 * budgets above the cap (after a downgrade) are kept — only creating new ones
 * is blocked, as for accounts.
 */
export async function insertBudgetWithinLimit(
  userId: string,
  input: { categoryId: string; currency: string; limitMinor: number },
  db: Db = defaultDb,
): Promise<CreateBudgetResult> {
  const { maxBudgets } = await getEntitlements(userId, db);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for("update");

    const existing = await tx
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .innerJoin(
        schema.categories,
        eq(schema.categories.id, schema.budgets.category_id),
      )
      .where(
        and(
          eq(schema.budgets.user_id, userId),
          sql`lower(trim(${schema.categories.name})) = (
            SELECT lower(trim(c.name)) FROM categories c
            WHERE c.id = ${input.categoryId} AND c.user_id = ${userId}
          )`,
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return {
        ok: false,
        code: "budget_exists",
        error: "A budget with this name already exists.",
      };
    }

    if (maxBudgets !== null) {
      const [row] = await tx
        .select({ count: count() })
        .from(schema.budgets)
        .where(eq(schema.budgets.user_id, userId));
      if ((row?.count ?? 0) >= maxBudgets) {
        return {
          ok: false,
          code: "budget_limit_reached",
          limit: maxBudgets,
          error: `Free plan is limited to ${maxBudgets} budgets. Upgrade to Pro for unlimited budgets.`,
        };
      }
    }

    const budget = {
      id: crypto.randomUUID(),
      category_id: input.categoryId,
      currency: input.currency,
      limit_minor: input.limitMinor,
    };
    await tx.insert(schema.budgets).values({ ...budget, user_id: userId });
    return { ok: true, budget };
  });
}
