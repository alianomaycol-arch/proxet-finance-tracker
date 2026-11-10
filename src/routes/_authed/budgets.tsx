import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { budgetErrorMessage } from "#/lib/budget-errors";
import { BudgetCard } from "#/components/budgets/budget-card";
import {
  BudgetForm,
  type BudgetFormValues,
} from "#/components/budgets/budget-form";
import { Button } from "#/components/ui/button";
import { Toast } from "#/components/ui/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

type BudgetRow = Awaited<ReturnType<typeof getBudgets>>["budgets"][number];

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;

function formatMonth(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(getLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
    refetchOnMount: true,
    staleTime: 0,
  });

  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  const invalidateBudgets = () =>
    queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: (values: BudgetFormValues) => createBudgetFn({ data: values }),
    onSettled: invalidateBudgets,
  });

  const updateMutation = useMutation({
    mutationFn: (values: { id: string; limitMinor: number }) =>
      updateBudgetFn({ data: values }),
    onSettled: invalidateBudgets,
  });

  const deleteMutation = useMutation({
    mutationFn: (values: { id: string }) => deleteBudgetFn({ data: values }),
    onSettled: invalidateBudgets,
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | null>(null);
  const [deletingBudget, setDeletingBudget] = useState<BudgetRow | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(
    null,
  );

  const dismissToast = useCallback(() => setToast(null), []);
  const showError = (result?: { code?: string; limit?: number }) =>
    setToast((prev) => ({
      id: (prev?.id ?? 0) + 1,
      message: budgetErrorMessage(result),
    }));

  const budgets = data?.budgets ?? [];
  const currencies = data?.currencies ?? [];
  const planLimit = data?.limit ?? null;
  const atPlanLimit = planLimit !== null && budgets.length >= planLimit;

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingBudget(null);
  };

  const handleAdd = () => {
    setEditingBudget(null);
    setIsFormOpen(true);
  };

  const handleEdit = (budget: BudgetRow) => {
    setEditingBudget(budget);
    setIsFormOpen(true);
  };

  // Server rejections close the dialog before the toast shows, so the toast
  // is not hidden behind the modal and the list refetches fresh data.
  const handleFormSubmit = async (values: BudgetFormValues) => {
    try {
      const result = editingBudget
        ? await updateMutation.mutateAsync({
            id: editingBudget.id,
            limitMinor: values.limitMinor,
          })
        : await createMutation.mutateAsync(values);
      closeForm();
      if (result && "error" in result) showError(result);
    } catch {
      closeForm();
      showError();
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingBudget) return;
    const { id } = deletingBudget;
    setDeletingBudget(null);
    try {
      const result = await deleteMutation.mutateAsync({ id });
      if (result && "error" in result) showError(result);
    } catch {
      showError();
    }
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">
              {m.budgets_title()}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_description()}
            </p>
          </div>
          <Button onClick={handleAdd} disabled={currencies.length === 0}>
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            {m.budgets_add()}
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="page-wrap py-8">
        {isLoading || !data ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">
                {m.loading()}
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Month and plan usage */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                {m.budgets_month({ month: formatMonth(data.month) })}
              </span>
              <span
                className="flex items-center gap-3 text-muted-foreground"
                data-testid="budget-usage"
              >
                {planLimit === null
                  ? m.budgets_usage_unlimited({ used: budgets.length })
                  : m.budgets_usage({ used: budgets.length, limit: planLimit })}
                {atPlanLimit && (
                  <Link
                    to="/billing"
                    className="font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-400"
                  >
                    {m.budgets_upgrade_cta()}
                  </Link>
                )}
              </span>
            </div>

            {budgets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <h3 className="text-base font-medium mb-1">
                  {currencies.length === 0
                    ? m.budgets_no_accounts_title()
                    : m.budgets_empty_title()}
                </h3>
                <p className="text-sm text-muted-foreground mb-4 max-w-sm">
                  {currencies.length === 0
                    ? m.budgets_no_accounts_description()
                    : m.budgets_empty_description()}
                </p>
                {currencies.length === 0 && (
                  <Link
                    to="/accounts"
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {m.budgets_no_accounts_link()}
                  </Link>
                )}
              </div>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {budgets.map((budget) => (
                  <li key={budget.id}>
                    <BudgetCard
                      title={budget.category_name}
                      color={budget.category_color}
                      currency={budget.currency}
                      spentMinor={budget.spent_minor}
                      limitMinor={budget.limit_minor}
                      onEdit={() => handleEdit(budget)}
                      onDelete={() => setDeletingBudget(budget)}
                    />
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-6 text-xs text-muted-foreground">
              {m.budgets_currency_note()}
            </p>
          </>
        )}
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editingBudget={editingBudget}
        categories={categories}
        budgetedCategoryIds={new Set(budgets.map((b) => b.category_id))}
        currencies={currencies}
        submitting={createMutation.isPending || updateMutation.isPending}
        onClose={closeForm}
        onSubmit={handleFormSubmit}
      />

      <AlertDialog
        open={!!deletingBudget}
        onOpenChange={(open) => !open && setDeletingBudget(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.budgets_remove_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.budgets_remove_description({
                category: deletingBudget?.category_name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteConfirm}
            >
              {m.budgets_remove_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <Toast key={toast.id} message={toast.message} onDismiss={dismissToast} />
      )}
    </div>
  );
}
