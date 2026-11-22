"use client";

import type { SpecialistId, UpdateSpecialistRequest } from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { CoreApiError } from "@/lib/core";
import {
  readSpecialistUpdate,
  undoSpecialistUpdate,
  updateSpecialist,
} from "@/lib/data/specialist-manage";
import type { Specialist } from "@/lib/data/views";

/** Every screen showing this specialist reads the new copy at once; the list re-reads. */
function usePublishSpecialist() {
  const queryClient = useQueryClient();
  return (specialist: Specialist) => {
    queryClient.setQueryData(["specialist", specialist.id], specialist);
    queryClient.setQueryData<readonly Specialist[]>(["specialists"], (list) =>
      list?.map((entry) => (entry.id === specialist.id ? specialist : entry)),
    );
    void queryClient.invalidateQueries({ queryKey: ["specialists"] });
  };
}

/** Saves a change to the specialist; resolves to the specialist as core now has it. */
export function useUpdateSpecialist(specialistId: SpecialistId) {
  const publish = usePublishSpecialist();
  return useMutation({
    mutationFn: (patch: UpdateSpecialistRequest) => updateSpecialist(specialistId, patch),
    onSuccess: publish,
  });
}

/** Why core kept it at work, in the person's words. */
function retireRefusal(error: unknown): string {
  const code = error instanceof CoreApiError ? error.code : undefined;
  if (code === "holds_money") return "It still holds money. Ask Auni in its chat to sell first.";
  if (code === "in_flight")
    return "A move in it is still settling. Try again in a couple of minutes.";
  return "That specialist couldn’t be retired. Try again.";
}

/**
 * What retiring asks first. Nothing is sold, since there is nothing in it; anything still waiting
 * on the person is declined. A buy allowed in its chat later brings it back.
 */
export function retireAsk(name: string) {
  return {
    title: `Retire “${name}”?`,
    body: "There’s no money in it, so nothing is sold. It moves to History in your sidebar, with its chat and record.",
    verb: "Retire",
  };
}

/**
 * Retires a specialist that holds nothing: it moves to History in the
 * sidebar until archived, and its page and record stay.
 */
export function useRetireSpecialist(specialist: Pick<Specialist, "id" | "name">) {
  const publish = usePublishSpecialist();
  const retire = useMutation({
    mutationFn: () => updateSpecialist(specialist.id, { retired: true }),
    onSuccess: (retired) => {
      publish(retired);
      toast.success(`${specialist.name} retired`);
    },
    onError: (error) => toast.error(retireRefusal(error)),
  });
  return () => retire.mutate();
}

/**
 * A dialog's save: only what the person changed, then the dialog closes. A
 * failed save keeps it open, with the error line and the draft, for another try.
 */
export function useDialogSave(specialistId: SpecialistId, onDone: () => void) {
  const update = useUpdateSpecialist(specialistId);
  const save = async (patch: UpdateSpecialistRequest) => {
    if (Object.keys(patch).length === 0) return onDone();
    try {
      await update.mutateAsync(patch);
      onDone();
    } catch {
      // update.isError shows the error line.
    }
  };
  return { save, pending: update.isPending, failed: update.isError };
}

/** Whether a chat edit has been undone, so a reopened receipt shows it. */
export function useSpecialistUpdate(specialistId: SpecialistId, updateId: string) {
  return useQuery({
    queryKey: ["specialist-update", specialistId, updateId],
    queryFn: ({ signal }) => readSpecialistUpdate(specialistId, updateId, signal),
    staleTime: 60_000,
  });
}

export function useUndoSpecialistUpdate(specialistId: SpecialistId, updateId: string) {
  const queryClient = useQueryClient();
  const publish = usePublishSpecialist();
  return useMutation({
    mutationFn: () => undoSpecialistUpdate(specialistId, updateId),
    onSuccess: (outcome) => {
      if (outcome.status === "undone") {
        queryClient.setQueryData(["specialist-update", specialistId, updateId], outcome.update);
        publish(outcome.specialist);
      } else {
        void queryClient.invalidateQueries({ queryKey: ["specialist", specialistId] });
      }
    },
  });
}
