"use client";

import { ChevronRight } from "lucide-react";

import { Mascot } from "@/components/brand/mascot";
import { Row, Rows } from "@/components/ui/row";
import { chatHref } from "@/lib/app-links";

import { PlaceLink } from "./open-place";
import { askOf } from "./place-list";
import { PlaceHeader } from "./place-header";
import { usePlaces } from "./use-places";

/**
 * Everything waiting on the owner, in one list: each chat with a card or a question for them,
 * saying what it asks. A tap opens the chat, where the card is. A phone's Needs you tab; on a wide
 * screen the sidebar's group says the same, and leads here.
 */
export function NeedsYouPlace() {
  const { needsYou } = usePlaces();
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <PlaceHeader root icon={null} title="Needs you" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-4 pt-6 pb-16 sm:px-8">
          <h2 className="text-title text-ink max-lg:sr-only">Needs you</h2>
          {needsYou.length === 0 ? (
            <div className="flex flex-col items-center px-6 pt-16 text-center">
              <Mascot alt="" size={56} state="listening" />
              <p className="mt-4 text-body font-semibold text-ink">Nothing needs you</p>
              <p className="mt-1 max-w-[320px] text-ui text-muted-foreground">
                Cards and questions waiting on you will appear here.
              </p>
            </div>
          ) : (
            <Rows className="lg:mt-4">
              {needsYou.map((place) => (
                <li key={place.thread.id}>
                  <Row
                    asChild
                    title={place.thread.title}
                    meta={<span className="text-waiting">{askOf(place)}</span>}
                    wrapMeta
                    end={<ChevronRight aria-hidden className="size-4 text-faint" />}
                  >
                    <PlaceLink href={chatHref(place.thread.id)} thread={place.thread.id} />
                  </Row>
                </li>
              ))}
            </Rows>
          )}
        </div>
      </div>
    </section>
  );
}
