import { z } from "zod";

export const timestampSchema = z.iso.datetime({ offset: true });

export const threadIdSchema = z.uuid().brand<"ThreadId">();
export type ThreadId = z.infer<typeof threadIdSchema>;

export const messageIdSchema = z.uuid().brand<"MessageId">();
export type MessageId = z.infer<typeof messageIdSchema>;

export const proposalIdSchema = z.uuid().brand<"ProposalId">();

export const actionRecordIdSchema = z.uuid().brand<"ActionRecordId">();
export type ActionRecordId = z.infer<typeof actionRecordIdSchema>;

export const automationRuleIdSchema = z.uuid().brand<"AutomationRuleId">();
export type AutomationRuleId = z.infer<typeof automationRuleIdSchema>;

export const automationFireIdSchema = z.uuid().brand<"AutomationFireId">();

export const cardIdSchema = z.uuid().brand<"CardId">();
