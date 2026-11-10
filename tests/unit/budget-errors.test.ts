import { describe, it, expect } from "vitest";
import { budgetErrorMessage } from "#/lib/budget-errors";
import { m } from "#/paraglide/messages";

describe("budgetErrorMessage", () => {
  it("maps known codes to localized messages", () => {
    expect(budgetErrorMessage({ code: "budget_exists" })).toBe(
      m.budgets_error_exists(),
    );
    expect(
      budgetErrorMessage({ code: "budget_limit_reached", limit: 3 }),
    ).toBe(m.budgets_error_limit_reached({ limit: 3 }));
  });

  it("never surfaces unknown codes or raw server text", () => {
    expect(budgetErrorMessage({ code: "23505" })).toBe(m.budgets_error_generic());
    expect(budgetErrorMessage(undefined)).toBe(m.budgets_error_generic());
  });
});
