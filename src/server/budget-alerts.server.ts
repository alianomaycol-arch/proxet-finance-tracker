import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "#/db";
import { formatBudgetMonth, MAX_LIMIT_MINOR } from "#/lib/budgets";
import { formatMoney } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { currentUtcMonth, listBudgetViews } from "#/server/budgets.server";
import { sendEmail } from "#/server/email";
import { env } from "#/server/env";
import { getLogger } from "#/server/logger";

//
// Over-budget email, at most one per budget (category) per month. A
// budget_alerts row is claimed with ON CONFLICT DO NOTHING before sending, so
// concurrent triggers cannot both send; the claim is released when the send
// fails so a later trigger retries. Triggered after the main write paths and
// by the hourly maintenance sweep, which covers the rest.

type Db = typeof defaultDb;

/** Emails every budget of the user that is over its limit this month and has
 * not been alerted yet. Returns the number of emails sent. */
export async function evaluateBudgetAlerts(
  userId: string,
  now: Date = new Date(),
  db: Db = defaultDb,
): Promise<number> {
  const [user] = await db
    .select({
      email: schema.users.email,
      verifiedAt: schema.users.email_verified_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  // No claim is spent for unverified addresses, so the alert still goes out
  // on a later trigger once the email is verified.
  if (!user?.email || !user.verifiedAt) return 0;

  const month = currentUtcMonth(now);
  const overBudgets = (await listBudgetViews(userId, month, db)).filter(
    (budget) => budget.over_budget,
  );

  let sent = 0;
  for (const budget of overBudgets) {
    const [claim] = await db
      .insert(schema.budget_alerts)
      .values({
        id: crypto.randomUUID(),
        user_id: userId,
        category_id: budget.category_id,
        month,
        limit_minor: budget.limit_minor,
        // spent_minor is an int4 column; a month's sum can exceed it.
        spent_minor: Math.min(budget.spent_minor, MAX_LIMIT_MINOR),
      })
      .onConflictDoNothing()
      .returning({ id: schema.budget_alerts.id });
    if (!claim) continue;

    try {
      await sendEmail({
        to: user.email,
        subject: m.email_budget_exceeded_subject({
          category: budget.category_name,
        }),
        text: m.email_budget_exceeded_body({
          category: budget.category_name,
          month: formatBudgetMonth(month),
          spent: formatMoney(budget.spent_minor, budget.currency),
          limit: formatMoney(budget.limit_minor, budget.currency),
          over: formatMoney(-budget.remaining_minor, budget.currency),
          link: `${env.email.baseUrl}/budgets`,
        }),
      });
      await db
        .update(schema.budget_alerts)
        .set({ status: "sent", sent_at: new Date() })
        .where(eq(schema.budget_alerts.id, claim.id));
      sent++;
    } catch (error) {
      await db
        .delete(schema.budget_alerts)
        .where(eq(schema.budget_alerts.id, claim.id));
      getLogger().error(
        { err: error, userId, budgetId: budget.id },
        "failed to send budget alert",
      );
    }
  }
  return sent;
}

/** Fire-and-forget: an alert must never fail or slow down the write that
 * triggered it. */
export function triggerBudgetAlerts(userId: string): void {
  void evaluateBudgetAlerts(userId).catch((error) =>
    getLogger().error({ err: error, userId }, "budget alert evaluation failed"),
  );
}

/** Safety net for write paths without a trigger (receipts, rules, category
 * moves, account currency changes). One user's failure does not stop the rest. */
export async function runBudgetAlertSweep(db: Db = defaultDb): Promise<number> {
  const users = await db
    .selectDistinct({ userId: schema.budgets.user_id })
    .from(schema.budgets);
  let sent = 0;
  for (const { userId } of users) {
    try {
      sent += await evaluateBudgetAlerts(userId, new Date(), db);
    } catch (error) {
      getLogger().error({ err: error, userId }, "budget alert sweep failed");
    }
  }
  return sent;
}
