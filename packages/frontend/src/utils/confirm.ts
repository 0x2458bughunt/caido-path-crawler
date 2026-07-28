import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { FrontendSDK } from "@/types";

/**
 * Modal confirmation via Caido dialog API.
 * Resolves true if confirmed, false if cancelled/closed.
 */
export function confirmDialog(
  sdk: FrontendSDK,
  options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      dialog.close();
      resolve(value);
    };

    const dialog = sdk.window.showDialog(
      {
        component: ConfirmDialog,
        props: {
          message: options.message,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          danger: options.danger !== false,
        },
        events: {
          confirm: () => finish(true),
          cancel: () => finish(false),
        },
      },
      {
        title: options.title,
        modal: true,
        closable: true,
        closeOnEscape: true,
      },
    );
  });
}
