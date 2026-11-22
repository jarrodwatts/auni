/** Add money, Settings, and re-opening the setup wizard open from anywhere by URL. */
export const FUNDING_DIALOG_PARAM = "fund";
export const SETTINGS_DIALOG_PARAM = "settings";
export const WIZARD_PARAM = "wizard";

const DIALOG_OPEN_VALUE = "open";

export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "personalization",
  "brains",
  "wallet",
  "channels",
  "remote",
  "network",
  "diagnostics",
  "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Legacy Settings query aliases kept working for old bookmarks and messages. */
const LEGACY_SECTIONS: Readonly<Record<string, SettingsSection>> = {
  profile: "general",
  machine: "remote",
  help: "diagnostics",
};

function withParam(pathname: string, search: string | undefined, param: string, value: string) {
  const params = new URLSearchParams(search);
  params.set(param, value);
  return `${pathname}?${params.toString()}`;
}

/** Add money, open for anything, or for the whole dollars a card needs (`need`, as "50"). */
export function fundingDialogHref(pathname: string, search?: string, need?: number): string {
  return withParam(pathname, search, FUNDING_DIALOG_PARAM, need ? String(need) : DIALOG_OPEN_VALUE);
}

/** What Add money's parameter says: closed (null), open, or open for the dollars a card needs. */
export function fundingAsked(value: string | null): { readonly need: string | null } | null {
  if (value === DIALOG_OPEN_VALUE) return { need: null };
  return value && /^[1-9]\d*$/u.test(value) ? { need: value } : null;
}

export function settingsDialogHref(
  pathname: string,
  search?: string,
  section: SettingsSection = "general",
): string {
  return withParam(pathname, search, SETTINGS_DIALOG_PARAM, section);
}

export function settingsSection(value: string | null): SettingsSection | null {
  if (!value) return null;
  if (value in LEGACY_SECTIONS) return LEGACY_SECTIONS[value]!;
  return SETTINGS_SECTIONS.find((section) => section === value) ?? null;
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
