import { createFileRoute } from "@tanstack/react-router";
import { runBudgetAlertSweep } from "#/server/budget-alerts.server";
import { runComplianceSweep } from "#/server/compliance.server";

// Test-only endpoint: runs one compliance sweep pass (expired account
// deletions + ai_raw_response retention) and one budget alert sweep
// synchronously so E2E tests can observe their effects deterministically —
// the real hourly loop is disarmed in TEST_MODE. Only enabled when TEST_MODE=1.
export const Route = createFileRoute("/test-run-sweep")({
  server: {
    handlers: {
      POST: async () => {
        if (process.env.TEST_MODE !== "1") {
          return new Response("Not available", { status: 404 });
        }
        const result = await runComplianceSweep();
        const budgetAlertsSent = await runBudgetAlertSweep();
        return Response.json({ ...result, budgetAlertsSent });
      },
    },
  },
});
