// The contract between core and web. Core builds every response, card and
// stream event against these shapes (typed, not re-parsed), and web parses
// what it receives with the same schemas. How a screen shows it lives in web.
export {
  type ActionLine,
  type ActionQuoteWire,
  actionQuoteWireSchema,
  type ActionStatus,
  CARD_WAITS_MS,
  CLOSED,
  HELD,
  HELD_SAFE,
  RETRACTED,
  type HeldWhy,
  type MovePhase,
  type MoveRun,
  type ActionWire,
  actionWireSchema,
  type FailureKind,
  failureKindSchema,
  filledUsd,
  LETS_LINE,
  permissionsSaid,
  type ProposalWire,
  proposalWireSchema,
} from "./action.ts";
export {
  type ActionCardWire,
  actionCardSchema,
  cardLogoUrlSchema,
  type MoneyFlow,
} from "./action-card.ts";
export {
  APP_JOBS,
  type AppJob,
  type AppSettingWire,
  type AppWire,
  type AppsWire,
  appsWireSchema,
  switchAppRequestSchema,
} from "./apps.ts";
export {
  type ActivityItemWire,
  type ActivityStoryWire,
  activityItemWireSchema,
  type ActivityWire,
  activityWireSchema,
} from "./activity.ts";
export {
  type ActionPlanCardWire,
  type ActionPlanLeg,
  actionPlanCardSchema,
  type PlanMove,
} from "./action-plan-card.ts";
export { type ArrivalCardWire, arrivalCardSchema } from "./arrival-card.ts";
export { ASK_DONE, ASK_LINE, type AskCardWire, askCardSchema } from "./ask-card.ts";
export { type DepositCardWire, DEPOSIT_WAIT_MS, depositCardSchema } from "./deposit-card.ts";
export {
  type Feedback,
  type FeedbackPart,
  type FeedbackPost,
  FEEDBACK_KINDS,
  FEEDBACK_URL_LIMIT,
  feedbackBlankUrl,
  feedbackCardSchema,
  feedbackPost,
  feedbackSchema,
  feedbackSearchUrl,
  feedbackWireSchema,
} from "./feedback.ts";
export { automationCardSchema } from "./automation/card-shape.ts";
export {
  type AutomationFireWire,
  automationFireWireSchema,
  type AutomationStatus,
  type AutomationWire,
  automationWireSchema,
  type FireVerdict,
  fireVerdictSchema,
} from "./automation/rule.ts";
export { type CardWire, cardWireSchema } from "./card.ts";
export {
  AMOUNT,
  type CardFace,
  cardFaceSchema,
  fillFace,
  type FilledFace,
  SUMMARY_VERBS,
} from "./card-face.ts";
export { type AppCardWire, appCardSchema } from "./app-card.ts";
export { type PickDetailWire, pickDetailWireSchema } from "./pick-detail.ts";
export { ETHEREUM, type KnownAsset, knownAsset, MONAD, POLYGON, SOLANA } from "./known-assets.ts";
export {
  CASH_KEYS,
  type CashKey,
  coinToken,
  EVM_CASH_KEYS,
  EVM_CHAIN_KEYS,
  type EvmCashKey,
  type EvmChainKey,
  isCash,
  isEvmChain,
  NETWORK_KEYS,
  type NetworkKey,
  NETWORKS,
  SOLANA_CAIP2,
} from "./networks.ts";
export {
  type AddWatchedWalletRequest,
  addWatchedWalletRequestSchema,
  type BriefSchedule,
  briefScheduleSchema,
  currentZoneName,
  type Me,
  meSchema,
  type OwnerSignals,
  ownerSignalsSchema,
  starredSchema,
  type UpdateMeRequest,
  updateMeRequestSchema,
  walletKeysResponseSchema,
  type WatchedWallet,
  watchedWalletSchema,
} from "./me.ts";
export {
  type AboutWire,
  aboutWireSchema,
  type DiagnosticsWire,
  diagnosticsWireSchema,
  type DoctorFindingWire,
  doctorFindingWireSchema,
  type LogsWire,
  logsWireSchema,
  type OwnerSessionWire,
  ownerSessionWireSchema,
  type PairingMintWire,
  pairingMintWireSchema,
  type RemoteAccessWire,
  remoteAccessWireSchema,
  repairRequestSchema,
  type RepairResult,
  repairResultSchema,
  type RpcChainWire,
  rpcChainWireSchema,
  type RpcsWire,
  rpcsWireSchema,
  tailscaleEnableRequestSchema,
  type TailscaleEnableResult,
  tailscaleEnableResultSchema,
  type TailscaleStateWire,
  tailscaleStateWireSchema,
} from "./system.ts";
export { AUNI_REPO, AUNI_REPO_URL } from "./repo.ts";
export {
  type HandoverMachine,
  type HandedOverWire,
  handedOverSchema,
  type HandoverOffer,
  handoverOfferSchema,
  type HandoverStatus,
  handoverStatusSchema,
} from "./handover.ts";
export {
  type BrainModelWire,
  brainModelSchema,
  type BrainRowWire,
  type BrainsWire,
  brainsWireSchema,
  type BrainTaskWire,
  type ModelSelectionWire,
  modelSelectionSchema,
  type SignInView,
  type PrivateCheckWire,
  privateCheckWireSchema,
  privateAcceptedWireSchema,
  type PrivateFieldWire,
  privateFieldWireSchema,
  SOLANA_BRING_FIELD,
  type SetupWire,
  setupWireSchema,
  type SpareKeyWire,
} from "./setup.ts";
export {
  ACTION_MAX,
  type FactSource,
  firstThatFits,
  LINE_WIDTH_PX,
  lineFits,
  lineWidth,
  PHONE_TEXT_PX,
  STARTING_POINTS,
  type StartingLine,
  type StartingPoint,
  type StartingPointsWire,
  startingPointsWireSchema,
} from "./starting-points.ts";
export {
  MAXIMUM_MESSAGE_CHARACTERS,
  type SendMessageRequest,
  sendMessageRequestSchema,
} from "./message.ts";
export { type MessageDataParts } from "./message-parts.ts";
export {
  APP_LISTINGS,
  appListing,
  type AppListing,
  type AppAbout,
  type AppSetting,
  type ToolMeta,
} from "./app-about.ts";
export {
  APP_MARKS,
  APP_THEMES,
  APP_ABOUTS,
  APP_MONEY_TOOLS,
  APP_READ_TOOLS,
  APP_RECORDED_TOOLS,
} from "./apps.generated.ts";
export { formatExactUsd, type UsdcMoneyWire, usdcMoneyWireSchema } from "./money.ts";
export { textAsMeant } from "./tool-input.ts";
export { clip, listed, withArticle } from "./words.ts";
export { splitKeys } from "./wallet-keys.ts";
export { type StartChatRequest, startChatRequestSchema, startedChatWireSchema } from "./places.ts";
export {
  type DepositWire,
  type HoldingWire,
  holdingWireSchema,
  type OtherTokensWire,
  otherTokensWireSchema,
  portfolioWireSchema,
} from "./portfolio.ts";
export {
  type ReplyOption,
  storedSuggestRepliesSchema,
  suggestRepliesInputSchema,
} from "./replies.ts";
export {
  type ActionRecordId,
  type AutomationRuleId,
  type MessageId,
  type ThreadId,
  threadIdSchema,
  timestampSchema,
} from "./shared.ts";
export {
  type LiveMessage,
  messageMetadataWireSchema,
  messageWireSchema,
  type ThreadActMode,
  threadActModeSchema,
  threadNotesSchema,
  threadSearchResultWireSchema,
  type ThreadStateWire,
  threadStateWireSchema,
  type ThreadStreamEvent,
  type ThreadWire,
  type TurnProgressStage,
  threadWireSchema,
  type UpdateThreadRequest,
  updateThreadRequestSchema,
} from "./thread.ts";
export {
  ACTION_TOOL_NAMES,
  type ActionToolName,
  ASK_TOOL_NAMES,
  type AskToolName,
  AUNI_TOOL_NAMES,
  type AuniToolName,
  type ConversationToolName,
  MONEY_TOOL_NAMES,
  type AppToolName,
  type MoneyToolName,
  isAsk,
  isVenueTool,
  RAW_TRANSACTION_TOOLS,
  type SdkToolName,
  VENUE_TOOL_NAMES,
  type VenueToolName,
} from "./tools.ts";
export {
  type ValueHistoryWire,
  type ValueRange,
  valueHistoryWireSchema,
  valueRangeSchema,
} from "./value-history.ts";
export { type VenueEventCardWire, venueEventCardSchema } from "./venue-event-card.ts";
export {
  WITHDRAW_NETWORKS,
  type WithdrawalWire,
  withdrawalWireSchema,
  type WithdrawCashWire,
  withdrawCashWireSchema,
  type WithdrawNetwork,
} from "./withdrawals.ts";
export { REMOTE_IMAGES, servableImage } from "./images.ts";
