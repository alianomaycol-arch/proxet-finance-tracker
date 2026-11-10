# Finance Tracker — take-home task

A personal finance tracker built with TanStack Start, Drizzle (Postgres via
embedded PGlite), TanStack Query, Tailwind/shadcn UI and Paraglide i18n.

**Your task is in [TASK.md](TASK.md).**

## Getting started

Requirements: Node.js 22+ and pnpm 10 (`corepack enable` will pick up the
pinned version). Use `pnpm`, not `npm`.

```bash
pnpm install
pnpm exec playwright install chromium   # for E2E tests
pnpm run dev                            # http://127.0.0.1:3000
```

No `.env` is needed for local development: the database is an embedded
PGlite instance under `./data/pg`. See `.env.example` for optional settings
(set `AI_FAKE=1` if you don't want to configure an AI provider).

`pnpm run check` runs typecheck, lint, unit tests and E2E tests together.
Project conventions are documented in [CLAUDE.md](CLAUDE.md) (identical to
[AGENTS.md](AGENTS.md)).

## Monthly category budgets

Design notes, decisions and the step-by-step implementation log are in
[docs/budgets.md](docs/budgets.md).

**Try it:** `pnpm run dev`, sign in, open **Budgets** in the sidebar, add a
budget for a category, then add an expense in that category on
**Transactions** that goes over the limit. The card turns red ("Over budget")
and an alert email is sent. In development emails are printed to the server
log (`EMAIL_PROVIDER=console`); to really send one, start the server with
`EMAIL_PROVIDER=resend RESEND_API_KEY=... EMAIL_FROM="..."` (see
`.env.example`).

**What was implemented**

- `budgets` and `budget_alerts` tables (migration `drizzle/0004_*`).
- CRUD for budgets: one budget per category name, a limit in one of the
  user's account currencies; editing changes the limit only.
- Spending for the current month, rolled up from the category and all of its
  subcategories, shown as spent / limit / left with a progress bar, a
  "Near limit" (80%) badge and an "Over budget" badge.
- Plan limit: 3 budgets on Free (`BILLING_FREE_MAX_BUDGETS`), unlimited on
  Pro, enforced on the server under a row lock; the page shows usage and an
  upgrade link.
- Over-budget email: at most one per budget per month, only to verified
  emails. It is checked after creating or editing a transaction, confirming an
  import, and creating or editing a budget, plus an hourly sweep.
- Compliance: budgets and the alert log are part of the data export
  (`export.json` and `budgets.csv`), and the privacy copy mentions them.
- Tests: unit and database tests (`tests/budgets.test.ts`,
  `tests/budget-alerts.test.ts`, `tests/unit/budget-status.test.ts`, the
  export test) and Playwright E2E tests (`tests/e2e/budgets.spec.ts`). Run
  `TZ=UTC pnpm run check`: an existing transactions-list E2E test assumes the
  machine is in UTC and fails otherwise.

**Assumptions**

- A month is the UTC calendar month; spending resets on the 1st.
- Only expenses count. Income and refunds don't reduce spending, and only
  transactions on accounts in the budget's currency are counted (no FX).
- Spending is matched by `transactions.category_id`; the dashboard's split of
  uncategorized transactions by receipt items is not replicated.
- Reaching the limit exactly is not "over"; going above it is.

**With more time**

- Delete a category's budgets and alerts when the category is deleted, and
  include both tables in the account hard delete (today both fail with a
  foreign-key error when a budget exists).
- Budget history (versioned limits) and month navigation.
- Release stale `pending` alert claims, or move alerts to a job queue.
- Unique category names, which also closes the rename gap for budget names.
- FX conversion, per-user timezone and per-account budgets.

## How we'd like you to work

You're welcome — encouraged — to use AI coding agents. Treat the task as
you would a real feature in an unfamiliar codebase.

In the interview we'll ask you to:

- walk us through your workflow and your conversations with the agent(s);
- explain the design of your solution and how it fits the existing code;
- demo the feature running locally.

Please keep your agent session history and any agent configuration you
used so you can show them. Note that `.gitignore` excludes `.claude/`,
`.agents/`, `.mcp.json` etc. — remove those entries if you'd like to commit
your setup.
