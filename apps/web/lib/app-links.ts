import { isCash, type CashKey } from "@auni/shared";

/** Add money and Settings open from anywhere by URL. */
export const FUNDING_DIALOG_PARAM = "fund";
export const SETTINGS_DIALOG_PARAM = "settings";

const DIALOG_OPEN_VALUE = "open";

/** Settings' panes, in the order its list shows them. */
export const SETTINGS_SECTIONS = ["you", "ai", "wallet", "devices", "health"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Names Settings' panes had before they were folded into five, which links already written
 * (old messages, the agent's own links) still open: each at the pane that holds it now, landing
 * on the setting it named (opening the disclosure it sits in) as a search does, where that isn't
 * simply the pane's top.
 */
const FOLDED_SECTIONS = {
  general: { section: "you", target: null },
  profile: { section: "you", target: "setting-name" },
  appearance: { section: "you", target: "setting-look" },
  personalization: { section: "you", target: "setting-known" },
  brains: { section: "ai", target: null },
  channels: { section: "devices", target: "setting-telegram" },
  remote: { section: "devices", target: "setting-phone" },
  machine: { section: "devices", target: "setting-running" },
  network: { section: "health", target: "setting-networks" },
  diagnostics: { section: "health", target: null },
  help: { section: "health", target: "setting-help" },
  about: { section: "health", target: "setting-version" },
} as const satisfies Readonly<
  Record<string, { readonly section: SettingsSection; readonly target: string | null }>
>;

/** Any name a Settings link may carry: a pane's, or one it was folded from. */
export type SettingsLink = SettingsSection | keyof typeof FOLDED_SECTIONS;

/** What `?settings=` holds with Settings open on its list of panes (on a phone, the list itself). */
const SETTINGS_INDEX = "open";

function withParam(pathname: string, search: string | undefined, param: string, value: string) {
  const params = new URLSearchParams(search);
  params.set(param, value);
  return `${pathname}?${params.toString()}`;
}

/** What a card is short of: whole dollars ("50") of USDC on one network. */
export interface FundingNeed {
  readonly usd: string;
  readonly chain: CashKey;
}

/** Add money, open for anything, or for what a card is short of, as "50-base". */
export function fundingDialogHref(pathname: string, search?: string, need?: FundingNeed): string {
  const value = need ? `${need.usd}-${need.chain}` : DIALOG_OPEN_VALUE;
  return withParam(pathname, search, FUNDING_DIALOG_PARAM, value);
}

/** What Add money's parameter says: closed (null), open, or open for what a card is short of. */
export function fundingAsked(value: string | null): { readonly need: FundingNeed | null } | null {
  if (value === DIALOG_OPEN_VALUE) return { need: null };
  const [, usd, chain] = /^([1-9]\d*)-([a-z]+)$/u.exec(value ?? "") ?? [];
  return usd && chain && isCash(chain) ? { need: { usd, chain } } : null;
}

/**
 * Settings, open on one pane, or with none named on its list. A folded name stays in the link,
 * so it lands on the setting it names.
 */
export function settingsDialogHref(
  pathname: string,
  search?: string,
  section?: SettingsLink,
): string {
  return withParam(pathname, search, SETTINGS_DIALOG_PARAM, section ?? SETTINGS_INDEX);
}

/**
 * What `?settings=` says: closed (undefined), or open on its list (`section` null) or on a pane,
 * by its own name or one it was folded from, with the id of the setting a folded name lands on.
 */
export function settingsAsked(
  value: string | null,
): { readonly section: SettingsSection | null; readonly target: string | null } | undefined {
  if (value === SETTINGS_INDEX) return { section: null, target: null };
  if (SETTINGS_SECTIONS.some((section) => section === value))
    return { section: value as SettingsSection, target: null };
  return Object.hasOwn(FOLDED_SECTIONS, value ?? "")
    ? FOLDED_SECTIONS[value as keyof typeof FOLDED_SECTIONS]
    : undefined;
}

/** Report a problem opens the same way, naming what it is about: `action:<id>` or `app:<id>`. */
export const REPORT_DIALOG_PARAM = "report";

/** What a report is about, as its link says it. */
export type ReportSubject = { readonly action: string } | { readonly app: string };

export function reportDialogHref(
  pathname: string,
  search: string | undefined,
  about: ReportSubject,
): string {
  const value = "action" in about ? `action:${about.action}` : `app:${about.app}`;
  return withParam(pathname, search, REPORT_DIALOG_PARAM, value);
}

/** What the report dialog's parameter says it is about; null when it is closed or says nothing known. */
export function reportSubject(value: string | null): ReportSubject | null {
  const [kind, ...rest] = (value ?? "").split(":");
  const id = rest.join(":");
  if (!id) return null;
  return kind === "action" ? { action: id } : kind === "app" ? { app: id } : null;
}

/** Drops one dialog's parameter without disturbing anything else in the URL. */
export function dialogClosedHref(pathname: string, search: string | undefined, param: string) {
  const params = new URLSearchParams(search);
  params.delete(param);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The Apps list, and the parameter that opens one app's sheet over it. */
export const APPS_HREF = "/app/apps";
export const APP_SHEET_PARAM = "app";

/** The Apps list with one app's sheet open. */
export function appHref(appId: string): string {
  return `${APPS_HREF}?${APP_SHEET_PARAM}=${encodeURIComponent(appId)}`;
}

export function chatHref(threadId: string): string {
  return `/app/chat/${threadId}`;
}

/** Everything waiting on the owner, in one place: a sidebar group on desktop, a tab on a phone. */
export const NEEDS_YOU_HREF = "/app/needs-you";

/** A phone's list of takes and chats; on desktop the sidebar holds it. */
export const CHATS_HREF = "/app/chats";
