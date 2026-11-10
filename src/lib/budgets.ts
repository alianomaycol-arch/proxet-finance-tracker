//
// Client-safe budget rules shared by the server functions and the budgets
// page. Amounts are integer minor units, so comparisons stay in integers.

/** Postgres `integer` upper bound — `limit_minor` is an int4 column. */
export const MAX_LIMIT_MINOR = 2_147_483_647;

/** Spending at or above this share of the limit is "near the limit". */
export const WARNING_PERCENT = 80;

export type BudgetStatus = "ok" | "warning" | "over";

/** "over" is strictly above the limit, matching `over_budget` on the server. */
export function budgetStatus(
  spentMinor: number,
  limitMinor: number,
): BudgetStatus {
  if (spentMinor > limitMinor) return "over";
  if (spentMinor * 100 >= limitMinor * WARNING_PERCENT) return "warning";
  return "ok";
}

/** Share of the limit spent, as a whole percentage clamped to 0–100. */
export function budgetUsagePercent(
  spentMinor: number,
  limitMinor: number,
): number {
  if (limitMinor <= 0) return 0;
  return Math.min(100, Math.floor((spentMinor * 100) / limitMinor));
}
