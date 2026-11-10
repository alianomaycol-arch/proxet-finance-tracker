import { describe, it, expect } from "vitest";
import { budgetStatus, budgetUsagePercent } from "#/lib/budgets";

describe("budgetStatus", () => {
  it.each([
    [0, "ok"],
    [799, "ok"],
    [800, "warning"],
    [1000, "warning"],
    [1001, "over"],
  ] as const)("spent %i of 1000 is %s", (spent, status) => {
    expect(budgetStatus(spent, 1000)).toBe(status);
  });
});

describe("budgetUsagePercent", () => {
  it("rounds down and clamps to 0–100", () => {
    expect(budgetUsagePercent(0, 1000)).toBe(0);
    expect(budgetUsagePercent(799, 1000)).toBe(79);
    expect(budgetUsagePercent(1500, 1000)).toBe(100);
  });
});
