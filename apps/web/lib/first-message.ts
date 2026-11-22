/**
 * The owner's first take, carried from the landing into the app's first chat. The landing keeps
 * diving while the chat starts underneath it: the chat's first frame (ConversationLaunchStage)
 * is shown to the dive to fly into, and the chat waits for the dive to land before it moves on
 * to its own page.
 */
export interface CarriedTake {
  /** The chat's first frame is on screen. */
  readonly arrive: (frame: HTMLElement) => void;
  /** Settles once the dive has landed, or was abandoned. */
  readonly landed: Promise<void>;
}

export interface Carry {
  /** What the chat that starts from the take is handed. */
  readonly take: CarriedTake;
  /** The first frame the chat drew, for the dive to fly into. */
  readonly arrived: Promise<HTMLElement>;
  /** The dive is over, landed or abandoned: the chat may move on. */
  readonly land: () => void;
}

export function carryTake(): Carry {
  let arrive!: (frame: HTMLElement) => void;
  let land!: () => void;
  const arrived = new Promise<HTMLElement>((resolve) => (arrive = resolve));
  const landed = new Promise<void>((resolve) => (land = resolve));
  return { take: { arrive, landed }, arrived, land };
}
