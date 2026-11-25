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
 * (old messages, the agent's own links) still open: each to the pane that holds it now.
 */
const FOLDED_SECTIONS = {
  general: "you",
  profile: "you",
  appearance: "you",
  personalization: "you",
  brains: "ai",
  channels: "devices",
  remote: "devices",
  machine: "devices",
  network: "health",
  diagnostics: "health",
  help: "health",
  about: "health",
} as const satisfies Readonly<Record<string, SettingsSection>>;

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

/** Settings, open on one pane, or with none named on its list. */
export function settingsDialogHref(
  pathname: string,
  search?: string,
  section?: SettingsLink,
): string {
  return withParam(
    pathname,
    search,
    SETTINGS_DIALOG_PARAM,
    section ? paneOf(section) : SETTINGS_INDEX,
  );
}

/** The pane a Settings link opens. */
function paneOf(link: SettingsLink): SettingsSection {
  return link in FOLDED_SECTIONS
    ? FOLDED_SECTIONS[link as keyof typeof FOLDED_SECTIONS]
    : (link as SettingsSection);
}

/**
 * What `?settings=` says: closed (undefined), open on its list (null), or open on a pane, by its
 * own name or one it was folded from.
 */
export function settingsSection(value: string | null): SettingsSection | null | undefined {
  if (value === SETTINGS_INDEX) return null;
  const link = [...SETTINGS_SECTIONS, ...Object.keys(FOLDED_SECTIONS)].find(
    (name) => name === value,
  );
  return link ? paneOf(link as SettingsLink) : undefined;
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
