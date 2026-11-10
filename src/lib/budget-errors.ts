import { m } from "#/paraglide/messages";

//
// Client-safe error contract for the budgets server functions. Every failure
// they return carries a stable `code`; the UI maps codes to Paraglide
// messages here, so raw server or database text never reaches the user. The
// English `error` string stays on the result for logs and API consumers.

export type BudgetErrorCode =
  | "budget_category_not_found"
  | "budget_currency_invalid"
  | "budget_exists"
  | "budget_limit_reached"
  | "budget_not_found";

export interface BudgetErrorResult {
  error: string;
  code: BudgetErrorCode;
  /** Present for `budget_limit_reached`. */
  limit?: number;
}

/** Localized message for a budgets failure; unknown codes and thrown errors
 * (e.g. input validation) fall back to a generic message. */
export function budgetErrorMessage(result?: {
  code?: string;
  limit?: number;
}): string {
  switch (result?.code) {
    case "budget_category_not_found":
      return m.budgets_error_category_not_found();
    case "budget_currency_invalid":
      return m.budgets_error_currency_invalid();
    case "budget_exists":
      return m.budgets_error_exists();
    case "budget_limit_reached":
      return m.budgets_error_limit_reached({ limit: result.limit ?? 0 });
    case "budget_not_found":
      return m.budgets_error_not_found();
    default:
      return m.budgets_error_generic();
  }
}
