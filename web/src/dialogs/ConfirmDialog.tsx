import { useEffect } from "react";

import type { ConfirmRequest } from "../types";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "../ui/Dialog";

/** A yes/no gate for destructive actions. Resolves the caller's promise. */
export function ConfirmDialog({
  request,
  onDone,
}: {
  request: ConfirmRequest | null;
  onDone: () => void;
}) {
  const answer = (value: boolean) => {
    request?.resolve(value);
    onDone();
  };

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog
      open={Boolean(request)}
      onClose={() => answer(false)}
      labelledBy="confirm-dialog-title"
      className="w-[min(30rem,calc(100vw-2rem))]"
    >
      {request ? (
        <>
          <DialogHead
            kicker="Confirm"
            title={<span id="confirm-dialog-title">{request.title}</span>}
            onClose={() => answer(false)}
          />
          <DialogBody>
            <p className="text-sm leading-relaxed text-ink-2">{request.text}</p>
          </DialogBody>
          <DialogFoot>
            <Button variant="ghost" onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => answer(true)} autoFocus>
              {request.label}
            </Button>
          </DialogFoot>
        </>
      ) : null}
    </Dialog>
  );
}
