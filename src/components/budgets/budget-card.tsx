import { m } from "#/paraglide/messages";
import { formatMoney } from "#/lib/money";
import {
  budgetStatus,
  budgetUsagePercent,
  type BudgetStatus,
} from "#/lib/budgets";
import { cn } from "#/lib/utils";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Badge } from "#/components/ui/badge";
import { CategoryBadge } from "#/components/ui/category-badge";
import { Progress } from "#/components/ui/progress";

const BAR_COLORS: Record<BudgetStatus, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  over: "bg-destructive",
};

interface BudgetCardProps {
  title: string;
  color?: string | null;
  currency: string;
  spentMinor: number;
  limitMinor: number;
  onEdit?: () => void;
  onDelete?: () => void;
}

export function BudgetCard({
  title,
  color = null,
  currency,
  spentMinor,
  limitMinor,
  onEdit,
  onDelete,
}: BudgetCardProps) {
  const status = budgetStatus(spentMinor, limitMinor);
  const remainingMinor = limitMinor - spentMinor;

  return (
    <div
      className="island-shell rounded-xl p-4"
      data-testid="budget-card"
      data-status={status}
    >
      <div className="flex items-center justify-between gap-2">
        <CategoryBadge name={title} color={color} />
        {status === "over" && (
          <Badge variant="destructive">{m.budgets_over_badge()}</Badge>
        )}
        {status === "warning" && (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-700 dark:text-amber-400"
          >
            {m.budgets_near_badge()}
          </Badge>
        )}
      </div>

      <Progress
        value={budgetUsagePercent(spentMinor, limitMinor)}
        aria-label={m.budgets_progress_label({ category: title })}
        indicatorClassName={BAR_COLORS[status]}
        className="mt-4"
      />

      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{m.budgets_spent()}</dt>
          <dd className="font-medium tabular-nums">
            {formatMoney(spentMinor, currency)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{m.budgets_limit()}</dt>
          <dd className="font-medium tabular-nums">
            {formatMoney(limitMinor, currency)}
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-xs text-muted-foreground">{m.budgets_left()}</dt>
          <dd
            className={cn(
              "font-medium tabular-nums",
              status === "over" && "text-destructive",
            )}
          >
            {status === "over"
              ? m.budgets_over_by({
                  amount: formatMoney(-remainingMinor, currency),
                })
              : formatMoney(remainingMinor, currency)}
          </dd>
        </div>
      </dl>

      {(onEdit || onDelete) && (
        <div className="mt-3 flex justify-end gap-1">
          {onEdit && <EditButton onClick={onEdit} data-testid="edit-budget" />}
          {onDelete && (
            <DeleteButton onClick={onDelete} data-testid="delete-budget" />
          )}
        </div>
      )}
    </div>
  );
}
