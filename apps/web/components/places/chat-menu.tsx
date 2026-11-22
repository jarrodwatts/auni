"use client";

import { Archive, ArchiveRestore, Ellipsis, PenLine, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { useChangeThread, useDeleteThread } from "@/components/app/use-threads";
import {
  ManageDialogContent,
  ManageFooter,
  manageFieldClass,
} from "@/components/specialist/manage/dialog-parts";
import { auniDialogTitleClass, ConfirmDialog, NoticeDialog } from "@/components/ui/auni-dialog";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CoreApiError } from "@/lib/core";
import type { Thread } from "@/lib/data/views";
import { cn } from "@/lib/utils";

import { moneyProgress } from "./attention";
import { usePlaceRoute } from "./use-places";

/** Core keeps a title to this many characters. */
export const MAX_TITLE_CHARS = 160;

const ITEM =
  "min-h-9 gap-2.5 rounded-[9px] px-2.5 py-1.5 text-[14px] text-ink focus:bg-foreground/[0.045] focus:text-ink [&_svg]:text-faint";

/**
 * What stops a chat being archived or deleted that this tab already knows: which of the two it
 * stops, and why, in a sentence. Core holds the same rules (conversation/tidy.ts), and says the
 * rest, such as a watch, when asked.
 */
function heldBy(thread: Thread): { archive: boolean; delete: boolean; why: string } | null {
  if (thread.state === "needs_user")
    return {
      archive: true,
      delete: true,
      why: "A card here waits for your answer. Once you answer it, even with Not now, this chat can go.",
    };
  if (thread.state === "running")
    return { archive: false, delete: true, why: "Auni is answering here. Delete it once it has." };
  if (moneyProgress(thread.moving)?.status === "now")
    return {
      archive: false,
      delete: true,
      why: "A move made here is still landing. Delete it once it has.",
    };
  return null;
}

type Asking = "rename" | "delete" | { readonly refused: string; readonly why: string } | null;

/**
 * A chat's "…": rename it, archive it out of History (or bring it back), or delete it for good.
 * Nothing about money is lost by any of them: a move made in a chat keeps its record in Activity
 * and the portfolio whatever happens to the chat. What would hide a card or leave a watch with
 * nowhere to wake is greyed with its reason, or refused by core in a sentence. On a chat's own
 * header it is a button; on a History row it shows as the pointer rests there, and a long press
 * or a right click opens it too (`open`, `onOpenChange`).
 */
export function ChatMenu({
  thread,
  place,
  open,
  onOpenChange,
  onRename,
}: {
  readonly thread: Thread;
  /** Where it sits: the chat's header, or its row in History. */
  readonly place: "header" | "row";
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Renames it where it sits; without it, a small dialog asks for the new name. */
  readonly onRename?: () => void;
}) {
  const tidy = useTidyChat(thread);
  const [asking, setAsking] = useState<Asking>(null);
  const held = heldBy(thread);
  const close = () => setAsking(null);
  const refuse = (refused: string) => (why: string) => setAsking({ refused, why });

  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${thread.title} options`}
            className={
              place === "header"
                ? "flex size-8 flex-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-ink data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-ink"
                : "auni-touch-target flex size-6 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-ink"
            }
          >
            <Ellipsis aria-hidden className={place === "header" ? "size-[18px]" : "size-4"} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-[232px] rounded-[14px] border-foreground/[0.08] p-1.5 shadow-menu"
        >
          <DropdownMenuItem className={ITEM} onSelect={onRename ?? (() => setAsking("rename"))}>
            <PenLine aria-hidden className="size-4" />
            Rename
          </DropdownMenuItem>
          {thread.archived ? (
            <DropdownMenuItem className={ITEM} onSelect={() => tidy.restore()}>
              <ArchiveRestore aria-hidden className="size-4" />
              Bring back to History
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className={ITEM}
              disabled={held?.archive}
              onSelect={() => tidy.archive(refuse("Not archived yet"))}
            >
              <Archive aria-hidden className="size-4" />
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="mx-1 my-1.5 bg-foreground/[0.06]" />
          <DropdownMenuItem
            className={cn(ITEM, "text-destructive focus:text-destructive [&_svg]:text-destructive")}
            disabled={held?.delete}
            onSelect={() => setAsking("delete")}
          >
            <Trash2 aria-hidden className="size-4" />
            Delete
          </DropdownMenuItem>
          {held ? (
            <p className="px-2.5 pt-1.5 pb-1 text-[12.5px] leading-[1.45] text-muted-foreground">
              {held.why}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameChatDialog
        thread={thread}
        open={asking === "rename"}
        onOpenChange={(next) => (next ? setAsking("rename") : close())}
      />
      <ConfirmDialog
        title="Delete this chat for good?"
        body={`“${thread.title}” and everything said in it go for good. Money moved here stays in Activity and your portfolio, as it is.`}
        verb="Delete"
        open={asking === "delete"}
        onOpenChange={(next) => (next ? setAsking("delete") : close())}
        onConfirm={() => tidy.remove(refuse("Not deleted yet"))}
      />
      <NoticeDialog
        title={typeof asking === "object" && asking ? asking.refused : ""}
        body={typeof asking === "object" && asking ? asking.why : ""}
        open={typeof asking === "object" && asking !== null}
        onOpenChange={(next) => (next ? undefined : close())}
      />
    </>
  );
}

/**
 * Renaming, archiving, bringing back and deleting one chat, each said in a toast when done. A
 * refusal from core comes back in its own sentence (`refused`), and anything else in a short
 * one. Archiving leaves the chat open where it is, so the person sees it go and can undo it.
 */
export function useTidyChat(thread: Thread) {
  const changeThread = useChangeThread();
  const deleteThread = useDeleteThread();
  const route = usePlaceRoute();
  const router = useRouter();
  const said = (refused: (why: string) => void, otherwise: string) => (error: unknown) =>
    error instanceof CoreApiError && error.detail ? refused(error.detail) : toast.error(otherwise);

  const restore = () =>
    void changeThread(thread.id, { archived: false }).then(
      () => toast.success("Back in History"),
      () => toast.error("That chat couldn’t be brought back. Try again."),
    );

  return {
    rename: (title: string, refused: (why: string) => void = (why) => toast.error(why)) =>
      changeThread(thread.id, { title }).catch(
        said(refused, "That name couldn’t be saved. Try again."),
      ),
    restore,
    archive: (refused: (why: string) => void) =>
      void changeThread(thread.id, { archived: true }).then(
        () =>
          toast.success("Chat archived", {
            description: "Search still finds it.",
            action: { label: "Undo", onClick: restore },
          }),
        said(refused, "That chat couldn’t be archived. Try again."),
      ),
    remove: (refused: (why: string) => void) =>
      void deleteThread(thread.id).then(
        () => {
          if (route.kind === "chat" && route.id === thread.id) router.replace("/app/new");
          toast.success("Chat deleted");
        },
        said(refused, "That chat couldn’t be deleted. Try again."),
      ),
  };
}

function RenameChatDialog({
  thread,
  open,
  onOpenChange,
}: {
  readonly thread: Thread;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ManageDialogContent className="sm:max-w-[420px]">
        <RenameForm thread={thread} onDone={() => onOpenChange(false)} />
      </ManageDialogContent>
    </Dialog>
  );
}

function RenameForm({ thread, onDone }: { readonly thread: Thread; readonly onDone: () => void }) {
  const [title, setTitle] = useState(thread.title);
  const { rename } = useTidyChat(thread);
  const name = title.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // The new name shows at once; if core refuses it, the old one comes back and a toast says so.
    if (name !== thread.title) void rename(name);
    onDone();
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="px-6 pt-6 pb-5">
        <DialogTitle className={auniDialogTitleClass}>Rename chat</DialogTitle>
        <DialogDescription className="mt-1.5 text-[14px] text-muted-foreground">
          The name it goes by in History and search.
        </DialogDescription>
      </div>
      <div className="px-6 pb-1">
        <input
          aria-label="Chat name"
          value={title}
          maxLength={MAX_TITLE_CHARS}
          spellCheck={false}
          // The dialog opens to change this one thing, so it starts there.
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setTitle(event.target.value)}
          className={manageFieldClass}
        />
      </div>
      <ManageFooter
        failed={false}
        pending={false}
        canSave={name.length > 0}
        onCancel={onDone}
        className="pt-6"
      />
    </form>
  );
}
