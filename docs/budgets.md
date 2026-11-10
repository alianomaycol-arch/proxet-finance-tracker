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
| Card colour: green below 80% of the limit, orange from 80% up to the limit, red when over | Gives a warning before the limit; rules live in `src/lib/budgets.ts`, integer math only, shared by the UI and tests | Two states only (on/over) |
| "Add budget" stays enabled at the plan cap; the page shows "N of 3 used" and an upgrade link, and a server rejection shows a toast | The server stays the single source of truth for the cap (another tab or a downgrade can change it) | Hiding or disabling the button as the only guard |
| Minimal page-local toast instead of a toast library | The repo has no toast system; one consumer does not justify a new dependency | Adding `sonner` |
| A server rejection closes the dialog before the toast shows | The modal marks the rest of the page `aria-hidden`; closing it keeps the toast visible to screen readers and refetches fresh data | Keeping the dialog open under the toast |
| Already-budgeted categories stay in the select, disabled | Their children keep their context in the indented list | Removing them from the list |
| Alert = claim a `budget_alerts` row (`ON CONFLICT DO NOTHING RETURNING`), then send; on send failure the claim is deleted | The claim makes concurrent triggers send at most once; deleting it on failure lets a later trigger retry instead of losing the month's email | Send first, then record (a crash or race can send twice) |
| Alerts are triggered fire-and-forget after creating/editing a transaction, confirming an import and creating/editing a budget; an hourly sweep (`maintenance.server.ts`) covers the other write paths | The write never waits for or fails because of email; same pattern as the password reset email. The sweep catches receipts, categorization rules, category moves and account currency changes without hooking every path | Hooking every write path (more code, easy to miss one); sweep only (up to 1 h delay) |
| Only verified email addresses get alerts, and an unverified user does not use up the month's alert | Avoids mailing addresses the user has not confirmed; the alert still goes out once they verify | Mailing any stored address |
| Budget names are unique per user: two categories with the same name (trimmed, case-insensitive) cannot both have a budget | A budget is shown by its category name, and category names are not unique (e.g. "Groceries" under two parents), so two identical cards would be ambiguous. Checked inside the same locked transaction as the plan cap; the form disables matching categories | A DB constraint (the name lives on `categories`); showing the full category path instead |

## Assumptions

- Only `transactions.category_id` counts toward a budget. The dashboard's split
  of uncategorized transactions by receipt items is not replicated.

## Possible improvements (with more time)

- **Known gap — deletion order**: delete a category's `budget_alerts` and
  `budgets` before the category in `deleteCategory`, and add both tables to
  `hardDeleteUser`. Today both fail with a foreign-key error when a budget
  exists, which also blocks the deletion sweep for that user.
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
  fire-and-forget. A process crash between the claim and the send leaves a
  `pending` row that blocks that month's email; the sweep could release
  stale `pending` claims.
- Apply the error-code catalog repo-wide: other modules still show the
  server's English `error` text when there is no `code`.
- **Unique category names**: the categories module accepts two categories
  with the same name (also at the same level), and a rename can still produce
  two budgets with the same name. Validate `lower(trim(name))` per user and
  parent in `createCategory`/`updateCategory` (or a unique index on that
  expression), which would also close the rename gap for budgets.

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
  test that unknown codes fall back to a generic message. Added limit
  validation tests: positive accepted; negative, zero, a fraction of a minor
  unit and a numeric string rejected.
- **Step 4 — UI.** `src/routes/_authed/budgets.tsx`: one card per budget with
  spent / limit / left, a progress bar coloured by status (`src/lib/budgets.ts`,
  unit-tested at 79.9%, 80%, 100% and 100% + 1), "Near limit" / "Over budget"
  badges, add/edit dialog (indented category list, currency of the user's
  accounts, edit = limit only), remove confirmation, plan usage with an upgrade
  link at the cap, a toast for server rejections, empty states; "Budgets" added
  to the sidebar after Categories. `MAX_LIMIT_MINOR` moved to `src/lib` so the
  form can validate it. Verified manually in the browser (create, validation,
  green/orange/red, edit, remove, 4th budget on free shows the toast);
  typecheck, lint and unit tests green.
- **Step 4b — Reuse and split.** Moved `buildCategoryTree` out of the
  categories page into `src/lib/category-tree.ts` and reused it for the budget
  form (no third copy of the tree code). The hand-made bar became the
  shadcn/Radix `Progress` (`src/components/ui/progress.tsx`). The page was split
  into `components/budgets/budget-card.tsx` (presentational: title, colour,
  currency, spent, limit, optional actions), `components/budgets/budget-form.tsx`
  and a generic `components/ui/toast.tsx`. The server now derives `over_budget`
  from the same `budgetStatus` rule. Vitest got its own Vite `cacheDir`: its
  config differs from dev, and a shared cache broke a running dev server with
  `getRequest is not a function`. 223 unit tests, typecheck and lint green.
- **Step 4c — Unique budget names.** `insertBudgetWithinLimit` now rejects a
  budget when any budgeted category has the same name
  (`lower(trim(name))`), which also covers the same category; the error code
  stays `budget_exists`. The form disables categories whose name is taken
  (`budgetNameKey` in `src/lib/budgets.ts`). Verified with a database test
  (" groceries " under another parent is rejected), a unit test for the
  helper, and in the browser ("food" disabled once "Food" has a budget).
  Known gap: renaming a category can still produce two budgets with the same
  name.
- **Step 5 — Over-budget email.** `src/server/budget-alerts.server.ts`:
  `evaluateBudgetAlerts` (verified email only, claim then send, release on
  failure, `spent_minor` clamped to int4), `triggerBudgetAlerts`
  (fire-and-forget) wired into `createTransaction`, `updateTransaction`,
  import confirm, `createBudget` and `updateBudget`, and
  `runBudgetAlertSweep` in the hourly maintenance loop and `/test-run-sweep`.
  The email copy is in `messages/en.json`; `formatBudgetMonth` moved to
  `src/lib/budgets.ts` so the page and the email share it. Verified with
  `tests/budget-alerts.test.ts` (one email when going over, none on a second
  expense the same month, none at the limit, waits for verification, alerts
  again next month); typecheck and lint green.
- **Step 6 — Data export.** `collectUserExport` now includes `budgets` and
  `budgetAlerts`, and the zip has a `budgets.csv` (category name, currency,
  limit). The export and privacy copy mention budgets. Verified by extending
  the export test in `tests/compliance.test.ts`. Not done: `deleteCategory`
  and `hardDeleteUser` don't remove `budgets` / `budget_alerts` yet, so both
  fail with a foreign-key error when a budget exists (the account-deleted
  email copy was left unchanged for that reason).
- **Step 7 — E2E and README.** `tests/e2e/budgets.spec.ts`: sidebar link and
  empty state; create, edit and remove; over-budget card plus exactly one
  alert email (`/test-emails`, still one after a second expense and
  `/test-run-sweep`); free cap of 3 with the toast and upgrade link; Pro
  creates a fourth. README section for the feature; `.env.example` documents
  `BILLING_FREE_MAX_BUDGETS` and the email variables. On a UTC-3 machine one
  existing test (`transactions-list.spec.ts`, "Jan 15, 2025") fails because
  the transaction list shows dates in local time; it passes with `TZ=UTC` and
  is unrelated to budgets.
