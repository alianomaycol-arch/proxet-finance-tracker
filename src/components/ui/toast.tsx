import { useEffect } from "react";
import { m } from "#/paraglide/messages";

const TOAST_DURATION_MS = 6000;

/** Error toast that dismisses itself. Render it with a new `key` to restart
 * the timer when the same message is shown again. `onDismiss` must be
 * stable (e.g. `useCallback`), or the timer restarts on every render. */
export function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-[60] flex max-w-sm items-start gap-3 rounded-md border border-destructive/30 bg-card p-3 text-sm text-destructive shadow-lg"
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={m.toast_dismiss()}
        className="text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}
