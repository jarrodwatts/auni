import { APP_THEMES, NETWORK_KEYS, NETWORKS } from "@auni/shared";
import { z } from "zod";

import { inspectTailscale, staysOn } from "../always-on.ts";
import { appsWire } from "../app-list.ts";
import { lockOwner, theOwner } from "../auth/owner.ts";
import { briefWhen } from "../automations/brief.ts";
import { SCHEDULE_SHAPES, scheduleSchema } from "../automations/schedule.ts";
import { canBeHome, channelStates, pairedChannels } from "../channels/home.ts";
import { publishBrains, publishMe } from "../conversation/stream.ts";
import { db } from "../db/client.ts";
import { owner } from "../db/schema.ts";
import { doctor } from "../doctor.ts";
import { env } from "../env.ts";
import { enqueueSignalsRefresh, forceRefreshStartingPoints } from "../jobs/kinds.ts";
import { rpcFor } from "../money/chains.ts";
import { walletAddresses } from "../money/wallets.ts";
import { PrivateFieldRefused } from "../private-fields.ts";
import { runningVersion } from "../release/layout.ts";
import { serviceInstalled } from "../service.ts";
import { savePreferredBrain } from "../settings.ts";
import { keyWorthSaving, spareKey } from "../setup.ts";
import { appendWatchedWallet, normalizeXHandle, resolveWatchedWallet } from "../signals.ts";
import { brainRows, preferredBrainId } from "./brain.ts";
import { defineTool, failure, result, type AuniTool } from "./tool.ts";

/** Exact Settings deep links the agent can hand the owner in markdown (`[label](/app?settings=...)`). */
const SETTINGS_LINKS = {
  general: "/app?settings=general",
  appearance: "/app?settings=appearance",
  personalization: "/app?settings=personalization",
  brains: "/app?settings=brains",
  wallet: "/app?settings=wallet",
  channels: "/app?settings=channels",
  remote: "/app?settings=remote",
  network: "/app?settings=network",
  diagnostics: "/app?settings=diagnostics",
  about: "/app?settings=about",
  apps: "/app/apps",
} as const;

const VALID_LOOKS = new Set<string>(["light", "dark", ...APP_THEMES]);

/**
 * Lets the agent inspect this Auni's live, non-secret product state: active & available AI brains,
 * remote/Tailscale access, background service, wallet readiness, apps/venues, channels, RPC sources,
 * owner personalization, exact Settings deep-links, and optional `auni doctor` health checks.
 * Never returns secrets, private keys, API keys, RPC URLs, pairing links, or CLI account emails.
 */
const inspectAuniTool = defineTool({
  name: "inspect_auni",
  description:
    "Read this local Auni's live non-secret configuration, capabilities, and Settings links: " +
    "active & available AI brains, remote/Tailscale access & always-on service status, wallet " +
    "chains & backup state, enabled/unconfigured apps, paired channels, RPC source types, owner " +
    "personalization (X handle, watched wallets, learned profile), and exact in-app `/app?settings=...` " +
    "links. Pass include_health=true to also run live `auni doctor` diagnostics when troubleshooting " +
    "or asked if everything is healthy. Use this instead of guessing how Auni is configured.",
  inputSchema: {
    include_health: z
      .boolean()
      .optional()
      .describe("When true, also runs live health checks (auni doctor) and includes each finding."),
  },
  async handler({ include_health }) {
    try {
      const [me, brainsList, tailscale, stays, addresses, worthSaving, channels, appsData, health] =
        await Promise.all([
          theOwner(),
          brainRows().catch(() => []),
          inspectTailscale().catch(() => null),
          staysOn().catch(() => null),
          walletAddresses().catch(() => ({ evm: null, solana: null })),
          keyWorthSaving().catch(() => false),
          channelStates().catch(() => []),
          appsWire().catch(() => null),
          include_health ? doctor().catch(() => []) : Promise.resolve(null),
        ]);

      const payload = {
        version: `v${runningVersion()}`,
        brains: {
          preferred: preferredBrainId(),
          available: brainsList.map((row) => ({
            id: row.id,
            name: row.name,
            state: row.state,
            ...("login" in row ? { login: row.login } : {}),
            ...(row.state === "resting" ? { restingUntil: row.until.toISOString() } : {}),
          })),
        },
        remote: {
          mode: env.TAILSCALE_OWNER ? "tailscale" : "local",
          tailscaleState: tailscale?.state ?? "unknown",
          tailscaleConfigured: tailscale?.configured ?? false,
          tailscaleServed: tailscale?.served ?? false,
          tailscaleProblem: tailscale?.problem ?? null,
          serviceInstalled: serviceInstalled(),
          staysOn: stays ? { stays: stays.stays, laptop: stays.laptop, says: stays.says } : null,
        },
        wallet: {
          hasEvm: Boolean(addresses.evm),
          hasSolana: Boolean(addresses.solana),
          backupStatus: spareKey(me, worthSaving && Boolean(addresses.evm || addresses.solana)),
        },
        personalization: {
          name: me.name,
          look: me.look ?? "light",
          availableLooks: [...VALID_LOOKS],
          timeZone: me.timeZone,
          brief: me.brief ? briefWhen(me.brief) : null,
          xHandle: me.xHandle ? `@${me.xHandle}` : null,
          watchedWallets: me.watchedWallets.map((w) => ({
            chain: w.chain,
            label: w.label,
          })),
          profileSummary: me.profileSummary,
          topics: me.profileSignals?.xTopics ?? [],
        },
        channels: {
          home: me.homeChannel ?? "last_used",
          list: channels.map((c) => ({
            id: c.id,
            name: c.name,
            configured: c.configured,
            paired: c.paired,
          })),
        },
        apps: (appsData?.apps ?? [])
          .filter((a) => a.canSwitch)
          .map((a) => ({
            id: a.id,
            name: a.name,
            on: a.on,
            needs: a.needs,
            troubles: a.troubles,
          })),
        rpcs: NETWORK_KEYS.map((key) => ({
          chain: NETWORKS[key].name,
          source: rpcFor(key).source,
        })),
        settingsLinks: SETTINGS_LINKS,
        ...(health
          ? {
              health: {
                summary: {
                  ok: health.filter((f) => f.status === "ok").length,
                  note: health.filter((f) => f.status === "note").length,
                  fix: health.filter((f) => f.status === "fix").length,
                },
                // Structured check names and statuses only: never forward raw error text to the brain.
                checks: health.map((f) => ({
                  check: f.check,
                  status: f.status,
                  hasAutoRepair: Boolean(f.repair),
                })),
                detailsLink: SETTINGS_LINKS.diagnostics,
              },
            }
          : {}),
      };

      return result(
        `Live Auni configuration (use settingsLinks like [Open Remote access](/app?settings=remote) when pointing the owner to Settings):\n${JSON.stringify(payload, null, 2)}`,
        { found: include_health ? "Status & health" : "Auni status", ...payload },
      );
    } catch (error) {
      return failure(error);
    }
  },
});

/**
 * Updates safe, non-security Auni preferences directly when the owner asks in chat: theme/look,
 * display name, preferred brain, home channel, daily brief, X handle, watch-only wallets, and
 * durable notes in "What Auni knows about you" (profileSummary). Never touches keys, RPCs, or Tailscale.
 */
const updateAuniPreferencesTool = defineTool({
  name: "update_auni_preferences",
  description:
    "Update safe Auni preferences when the owner asks (or when they share a durable investing " +
    "preference worth remembering in their profile). Can set visual theme (`look`: 'light', 'dark', " +
    "or an app theme id, updating the UI live), display `name`, `preferred_brain` ('claude-code', " +
    "'codex', or null for auto), `home_channel` ('web', 'last_used', or a paired channel id), " +
    "`brief` schedule (" +
    SCHEDULE_SHAPES +
    ", or null for off), public `x_handle` (or null to clear), `add_watched_wallet` (read-only public 0x, " +
    ".eth, or Solana address to watch), `remove_watched_wallet`, or update their " +
    "inspectable profile (`profile_summary` or `append_profile_note`). Never use for secrets, " +
    "private keys, RPCs, or Tailscale; direct the owner to Settings for those.",
  inputSchema: {
    name: z.string().trim().min(1).max(200).nullable().optional(),
    look: z.string().trim().min(1).max(64).nullable().optional(),
    preferred_brain: z.string().trim().min(1).max(64).nullable().optional(),
    home_channel: z.string().trim().max(64).nullable().optional(),
    brief: z.union([scheduleSchema, z.null()]).optional(),
    x_handle: z.string().trim().max(120).nullable().optional(),
    add_watched_wallet: z
      .object({
        address: z.string().trim().min(1).max(160),
        label: z.string().trim().max(64).optional(),
      })
      .optional(),
    remove_watched_wallet: z.string().trim().min(1).max(160).optional(),
    profile_summary: z.string().trim().max(2_000).nullable().optional(),
    append_profile_note: z.string().trim().min(1).max(400).optional(),
  },
  async handler(input) {
    try {
      const changes: string[] = [];
      let signalsChanged = false;
      let pointsChanged = false;

      if (input.look !== undefined && input.look !== null && !VALID_LOOKS.has(input.look)) {
        return failure(
          new Error(
            `Unknown theme "${input.look}". Available themes: ${[...VALID_LOOKS].join(", ")}.`,
          ),
        );
      }

      if (input.preferred_brain !== undefined) {
        try {
          await savePreferredBrain(input.preferred_brain);
          publishBrains();
          changes.push(
            input.preferred_brain
              ? `preferred brain set to ${input.preferred_brain}`
              : "preferred brain set to automatic",
          );
        } catch (error) {
          if (error instanceof PrivateFieldRefused) return failure(error);
          throw error;
        }
      }

      let homeChannel: string | null | undefined;
      if (input.home_channel !== undefined) {
        const nextHome = input.home_channel === "last_used" ? null : input.home_channel;
        if (!canBeHome(nextHome, await pairedChannels())) {
          return failure(new Error(`Channel "${input.home_channel}" is not paired.`));
        }
        homeChannel = nextHome;
        changes.push(`notices channel set to ${nextHome ?? "where you last talked"}`);
      }

      let xHandle: string | null | undefined;
      if (input.x_handle !== undefined) {
        if (input.x_handle === null || input.x_handle.trim() === "") {
          xHandle = null;
          changes.push("cleared X handle");
        } else {
          const normalized = normalizeXHandle(input.x_handle);
          if (!normalized) return failure(new Error("That doesn't look like a valid X handle."));
          xHandle = normalized;
          changes.push(`connected X handle @${normalized}`);
        }
        signalsChanged = true;
      }

      const resolvedWallet = input.add_watched_wallet
        ? await resolveWatchedWallet(
            input.add_watched_wallet.address,
            input.add_watched_wallet.label,
          )
        : null;

      if (input.name !== undefined)
        changes.push(input.name ? `name set to ${input.name}` : "cleared name");
      if (input.look !== undefined) changes.push(`theme set to ${input.look ?? "light"}`);
      if (input.brief !== undefined)
        changes.push(
          input.brief ? `daily brief set to ${briefWhen(input.brief)}` : "turned off daily brief",
        );

      const hasDbWork =
        input.name !== undefined ||
        input.look !== undefined ||
        homeChannel !== undefined ||
        input.brief !== undefined ||
        xHandle !== undefined ||
        resolvedWallet !== null ||
        Boolean(input.remove_watched_wallet) ||
        input.profile_summary !== undefined ||
        Boolean(input.append_profile_note);

      if (hasDbWork) {
        await db.transaction(async (tx) => {
          const locked = await lockOwner(tx);
          let watchedWallets = locked.watchedWallets;
          let watchedUpdated = false;
          if (resolvedWallet) {
            watchedWallets = appendWatchedWallet(watchedWallets, resolvedWallet);
            watchedUpdated = true;
            signalsChanged = true;
            changes.push(
              `watching ${resolvedWallet.label ?? resolvedWallet.address} (${resolvedWallet.chain})`,
            );
          }
          if (input.remove_watched_wallet) {
            const target = input.remove_watched_wallet.toLowerCase();
            const next = watchedWallets.filter(
              (w) => w.address.toLowerCase() !== target && w.label?.toLowerCase() !== target,
            );
            if (next.length !== watchedWallets.length) {
              watchedWallets = next;
              watchedUpdated = true;
              signalsChanged = true;
              changes.push(`stopped watching ${input.remove_watched_wallet}`);
            }
          }

          let profileSummary: string | null | undefined;
          if (input.profile_summary !== undefined) {
            profileSummary = input.profile_summary || null;
            pointsChanged = true;
            changes.push(
              profileSummary ? "updated your profile summary" : "cleared your profile summary",
            );
          } else if (input.append_profile_note) {
            const existing = locked.profileSummary?.trim() ?? "";
            const note = input.append_profile_note.trim();
            profileSummary = existing ? `${existing} ${note}`.slice(0, 2_000) : note;
            pointsChanged = true;
            changes.push("remembered your preference");
          }

          const patch: Partial<typeof owner.$inferInsert> = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.look !== undefined
              ? { look: input.look === "light" ? null : input.look }
              : {}),
            ...(homeChannel !== undefined ? { homeChannel } : {}),
            ...(input.brief !== undefined ? { brief: input.brief } : {}),
            ...(xHandle !== undefined ? { xHandle } : {}),
            ...(watchedUpdated ? { watchedWallets } : {}),
            ...(profileSummary !== undefined ? { profileSummary } : {}),
          };

          if (Object.keys(patch).length > 0) {
            await tx.update(owner).set(patch);
          }
          if (signalsChanged) {
            await enqueueSignalsRefresh(tx, { replaceSummary: xHandle !== undefined });
          } else if (pointsChanged) {
            await forceRefreshStartingPoints(tx);
          }
        });
      }
      publishMe();

      return result(
        changes.length > 0
          ? `Updated Auni: ${changes.join("; ")}. Changes are live now.`
          : "Nothing changed.",
        {
          found: changes.length > 0 ? "Updated" : "No change",
          updated: changes,
          settingsLinks: SETTINGS_LINKS,
        },
      );
    } catch (error) {
      return failure(error);
    }
  },
});

export function auniCapabilityTools(): AuniTool[] {
  return [inspectAuniTool, updateAuniPreferencesTool];
}
