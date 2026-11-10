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
