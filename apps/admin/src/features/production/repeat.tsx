import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { cloneBatchRequest, draftSignature, type ClonedBatch } from "./batch-logic";
import type { Batch } from "./contracts";
import { plural } from "./results-logic";
import { flushProductionState, useProduction, writeActiveRun } from "./store";

// "Repeat this batch": a new draft from a finished batch's frozen settings,
// distinct from resuming whatever draft the browser currently holds.

let runRequested = false;

/** Asks the Sheets step to run nesting as soon as it can (used by "Increase limit and retry"). */
function requestRun() {
  runRequested = true;
}

/** True once after requestRun(); the Sheets step reads it when it mounts. */
export function consumeRunRequest() {
  const value = runRequested;
  runRequested = false;
  return value;
}

type Pending = { clone: ClonedBatch; label: string; run: boolean };

/**
 * Loads a batch's frozen request into the draft and opens Sheets. When the
 * current draft holds other rows, the operator confirms replacing them first.
 */
export function useRepeatBatch() {
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const apply = ({ clone, run }: Pending) => {
    useProduction.getState().replaceDraft(clone.lines, clone.sheet);
    flushProductionState();
    writeActiveRun(null);
    if (run) requestRun();
    setPending(null);
    void navigate({ to: "/studio", search: { workspace: "production", stage: "sheets" } });
  };

  const repeat = (batch: Batch, options: { maxSheets?: number; run?: boolean } = {}) => {
    const { products, sheet, lines } = useProduction.getState();
    const clone = cloneBatchRequest(batch.request, products, sheet);
    if (!clone) {
      setProblem("This batch has no rows that can be repeated.");
      return;
    }
    setProblem(null);
    if (options.maxSheets != null) clone.sheet = { ...clone.sheet, maxSheets: options.maxSheets };
    const next: Pending = { clone, label: batch.name ?? "this batch", run: !!options.run };
    if (lines.length && draftSignature(lines) !== draftSignature(clone.lines)) setPending(next);
    else apply(next);
  };

  const draftRows = useProduction((state) => state.lines.length);
  const dialog = (
    <Dialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
      <DialogContent className="workshop sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Replace the current draft?</DialogTitle>
          <DialogDescription>
            The current draft has {plural(draftRows, "row")}. Repeating {pending?.label} replaces those rows and the
            sheet settings with the ones this batch was nested with. Earlier batches are not changed.
          </DialogDescription>
        </DialogHeader>
        {pending && pending.clone.skipped > 0 && (
          <p className="text-sm text-muted-foreground">
            {plural(pending.clone.skipped, "row")} of the original could not be read and will be left out.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setPending(null)}>
            Keep current draft
          </Button>
          <Button onClick={() => pending && apply(pending)}>Replace draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { repeat, dialog, problem };
}
