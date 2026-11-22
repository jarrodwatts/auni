import type { AppCardWire } from "@auni/shared";

import { APP_VIEWS } from "@/lib/app-views.generated";

/** A card an app draws itself, by the view its card names; nothing for one this build lacks. */
export function AppCard({ card }: { readonly card: AppCardWire }) {
  const views = Object.hasOwn(APP_VIEWS, card.app) ? APP_VIEWS[card.app] : undefined;
  const draw = views && Object.hasOwn(views, card.view) ? views[card.view] : undefined;
  return draw ? draw(card.data) : null;
}
