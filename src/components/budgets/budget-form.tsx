import { useState, useEffect } from "react";
import { m } from "#/paraglide/messages";
import { budgetNameKey, MAX_LIMIT_MINOR } from "#/lib/budgets";
import { buildCategoryTree, type CategoryTreeNode } from "#/lib/category-tree";
import { minorToInputValue, parseAmountToMinor } from "#/lib/money";
import { Button } from "#/components/ui/button";
import { CategoryBadge } from "#/components/ui/category-badge";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";

export interface BudgetFormValues {
  categoryId: string;
  currency: string;
  limitMinor: number;
}

interface CategoryOption {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order?: number | null;
}

interface EditableBudget {
  category_id: string;
  category_name: string;
  category_color: string | null;
  currency: string;
  limit_minor: number;
}

/** Depth-first options, children indented under their parent. */
function toSelectOptions(
  nodes: CategoryTreeNode<CategoryOption>[],
  depth = 0,
): { id: string; name: string; label: string }[] {
  return nodes.flatMap((node) => [
    {
      id: node.id,
      name: node.name,
      label: `${"— ".repeat(depth)}${node.name}`,
    },
    ...toSelectOptions(node.children, depth + 1),
  ]);
}

export function BudgetForm({
  isOpen,
  editingBudget,
  categories,
  budgetedCategoryIds,
  currencies,
  submitting,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  editingBudget: EditableBudget | null;
  categories: CategoryOption[];
  budgetedCategoryIds: Set<string>;
  currencies: string[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: BudgetFormValues) => void;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [currency, setCurrency] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const defaultCurrency = currencies[0] ?? "";

  useEffect(() => {
    if (isOpen) {
      setCategoryId(editingBudget?.category_id ?? "");
      setCurrency(editingBudget?.currency ?? defaultCurrency);
      setLimit(
        editingBudget
          ? String(minorToInputValue(editingBudget.limit_minor))
          : "",
      );
      setValidationError(null);
    }
  }, [isOpen, editingBudget, defaultCurrency]);

  // Categories whose name already has a budget stay listed (disabled) so their
  // children keep context.
  const options = toSelectOptions(buildCategoryTree(categories));
  const budgetedNames = new Set(
    categories
      .filter((category) => budgetedCategoryIds.has(category.id))
      .map((category) => budgetNameKey(category.name)),
  );
  const isTaken = (option: { name: string }) =>
    budgetedNames.has(budgetNameKey(option.name));
  const noCategoryLeft = !editingBudget && options.every(isTaken);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBudget && !categoryId) {
      setValidationError(m.budgets_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0) {
      setValidationError(m.budgets_limit_invalid());
      return;
    }
    if (limitMinor > MAX_LIMIT_MINOR) {
      setValidationError(m.budgets_limit_too_large());
      return;
    }
    setValidationError(null);
    onSubmit({ categoryId, currency, limitMinor });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingBudget ? m.budgets_edit_title() : m.budgets_add()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {editingBudget ? (
            <CategoryBadge
              name={editingBudget.category_name}
              color={editingBudget.category_color}
            />
          ) : (
            <>
              <div>
                <Label htmlFor="budget-category" className="mb-1">
                  {m.budgets_category_label()}
                </Label>
                <Select
                  id="budget-category"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  disabled={noCategoryLeft}
                >
                  <SelectItem value="">—</SelectItem>
                  {options.map((option) => (
                    <SelectItem
                      key={option.id}
                      value={option.id}
                      disabled={isTaken(option)}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </Select>
                {noCategoryLeft && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {categories.length > 0
                      ? m.budgets_all_categories_budgeted()
                      : m.no_categories_yet()}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="budget-currency" className="mb-1">
                  {m.budgets_currency_label()}
                </Label>
                <Select
                  id="budget-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {currencies.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </>
          )}

          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budgets_limit_label()}
              {editingBudget && ` (${editingBudget.currency})`}
            </Label>
            <Input
              id="budget-limit"
              type="number"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={m.zero_amount()}
              autoFocus
            />
          </div>

          {validationError && (
            <div className="text-destructive text-sm" role="alert">
              {validationError}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting || noCategoryLeft}>
              {submitting
                ? m.saving()
                : editingBudget
                  ? m.budgets_save()
                  : m.budgets_add()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
