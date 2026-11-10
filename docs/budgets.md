# Monthly category budgets — design notes

Feature spec: [TASK.md](../TASK.md). Branch: `feat/monthly-budgets`.

## Architecture

Follows the repo's existing shape instead of introducing a new pattern for one
feature:

- `src/server/budgets.functions.ts` (controller-like): `createServerFn` with zod
  `inputValidator`, `requireUserId()`, `{ error }` results.
- `src/server/budgets.server.ts` (service-like): pure functions (month range,
  category subtree, spend roll-up) kept separate from the Drizzle queries, so
  the domain rules are unit-testable without a database.
- Drizzle is called directly, as in the rest of the codebase (no repository
  layer).
- `src/routes/_authed/budgets.tsx`: TanStack Query page; routes only import
  `*.functions.ts`.

A budget belongs to the user and covers all of their accounts (it is per
category, not per account).

## Decisions

| Decision | Why | Rejected |
|---|---|---|
| Spend is computed on read, not stored | Single source of truth. Spend changes through many write paths (create/edit/delete, CSV import, receipts, categorization rules, category moves, account currency changes); `transactions_user_date_idx (user_id, date)` makes it one cheap range scan | Stored counter: drift when a write path is missed, needs a monthly reset job, lost updates under concurrency |
| Month = UTC calendar month, half-open range `[YYYY-MM-01, first day of next month)` | Same convention as the AI quota (`ai-usage.server.ts`); no month-length or leap-year edge cases | `BETWEEN` up to the last day; per-user timezone |
| Only expenses count: `SUM(ABS(amount_minor)) WHERE amount_minor < 0` | Income and refunds are positive and must not reduce spend; same rule as the dashboard | Net sum |
| A parent budget includes all descendants, at any depth, cycle-safe | Acceptance criterion; `parent_id` has no FK, so the walk uses a visited set like `updateCategory` | Direct children only; recursive CTE |
| Budgets on a parent and a child can coexist; an expense counts toward both | Each budget answers "how much did I spend under this category" | Forbidding overlap |
| A budget has a currency; only transactions from accounts in that currency count | Accounts can have different currencies and summing them is meaningless | FX conversion (out of scope) |
| Over budget = spent > limit (strictly) | Spending exactly the limit is on budget | `>=` |
| One email per budget per month is enforced by a unique DB constraint `(user_id, category_id, month)` + `ON CONFLICT DO NOTHING` | Safe under concurrent requests; same idempotency pattern as `stripe_events`. Keyed by category so deleting and recreating a budget does not re-send | In-memory flag; keying by budget id |
| Plan cap enforced on the server; downgrades keep existing budgets | Mirrors `checkAccountLimit`; UI gating alone can be bypassed | UI-only gate; deleting extra budgets on downgrade |
| Count + insert in one transaction holding a `FOR UPDATE` lock on the user row | Concurrent creates cannot exceed the cap (covered by a test) | Check-then-insert without a lock |
| Only the limit is editable; `updateBudget` uses `z.strictObject` | Changing the category or currency is a different budget; sending them is a validation error, not silently ignored | Editable category/currency |
| Limit: integer minor units, `1..2147483647` | Must be > 0; upper bound is the Postgres `integer` column | Floats; unbounded |
| Remove is a hard delete; alert rows are kept | Consistent with every other entity in the repo; kept alerts preserve "one email per month" if the budget is recreated | Soft delete (every query must filter it, breaks the unique constraint, compliance overhead) |
| Budget currency must be one of the user's account currencies | Otherwise the budget could never count anything | Free-text currency |
| Every budgets failure returns a stable `code` (`src/lib/budget-errors.ts`); the UI maps codes to Paraglide messages with a generic fallback | Raw server/DB text never reaches the user; user-facing copy lives in `messages/en.json`. The catalog is in `src/lib` because routes cannot import `*.server.ts` | Rendering `result.error` as-is (what `accounts`/`categories` do without a code) |

## Assumptions

- Only `transactions.category_id` counts toward a budget. The dashboard's split
  of uncategorized transactions by receipt items is not replicated.

## Possible improvements (with more time)

- **Budget history**: versioned limits
  (`budget_limits(budget_id, effective_month, limit_minor)`) plus month
  navigation, so past months keep the limit they had.
- **Repository layer** (a repo-wide decision, not for one feature): share
  queries such as "expenses by category and month" between analytics and
  budgets. Lower value today because Drizzle is already thin and typed, and
  tests run on in-memory PGlite.
- Receipt-item split parity with the dashboard; FX conversion; per-user
  timezone; optional per-account budgets.
- Alert evaluation through a job queue or outbox instead of inline
  fire-and-forget.
- Apply the error-code catalog repo-wide: other modules still show the
  server's English `error` text when there is no `code`.

## Implementation log

- **Step 0 — Analysis and design.** Read TASK.md, the repo conventions
  (AGENTS.md) and the modules a budget touches (billing, categories,
  transactions, imports, categorization rules, compliance, email). Agreed on
  the decisions above with the agent before writing code. Baseline: typecheck,
  lint and 199 unit tests green.
- **Step 1 — Schema.** Added `budgets` (unique per user + category, integer
  `limit_minor`, `currency`) and `budget_alerts` (unique per user + category +
  month, with a limit/spent snapshot) to `schema.ts`; migration
  `drizzle/0004_*` generated with `pnpm run db:generate`. Verified with the
  startup-migration test and typecheck.
- **Step 2 — Spend calculation and CRUD.** `budgets.server.ts`: pure helpers
  (`monthRange`, `collectSubtree`, `rollUpSpend`) plus one aggregate query, and
  `insertBudgetWithinLimit` (plan cap under a row lock). `budgets.functions.ts`:
  `getBudgets`, `createBudget`, `updateBudget` (limit only, strict schema),
  `deleteBudget`, all scoped by `user_id` in the same query. Entitlements gain
  `maxBudgets` (`BILLING_FREE_MAX_BUDGETS`, default 3); `budget` added to
  `OWNED_TABLES`, which the cross-tenant test now covers. Verified with
  `tests/budgets.test.ts` (roll-up, refunds, month bounds, currency, cycles,
  duplicate, plan cap, concurrency): 210 unit tests green, typecheck and lint
  clean.
- **Step 3 — Error contract.** Added `src/lib/budget-errors.ts` (error codes +
  `budgetErrorMessage`) and all budgets copy to `messages/en.json`; every
  failure from `budgets.functions.ts` now carries a code. Verified with a unit
  test that unknown codes fall back to a generic message.
