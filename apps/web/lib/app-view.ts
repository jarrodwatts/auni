import { createElement, type ComponentType, type ReactNode } from "react";
import type { ZodType } from "zod";

/**
 * A card an app draws itself (`<view>.card.tsx` in its folder), with the schema of the data
 * it is handed (`<view>.schema.ts` beside it). It draws only data its schema parses, so a card
 * from another build, or one core got wrong, draws nothing rather than breaking the page.
 */
export type AppView = (data: unknown) => ReactNode;

/** One app's view, as `pnpm gen` lists it in app-views.generated.ts. */
export function appView<T>(schema: ZodType<T>, View: ComponentType<{ readonly data: T }>): AppView {
  return function drawView(data) {
    const parsed = schema.safeParse(data);
    return parsed.success ? createElement(View, { data: parsed.data }) : null;
  };
}
