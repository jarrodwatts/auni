import postgres, { type Sql } from "postgres";

/** A query asked of a session that was lost: it is never answered by a new one. */
export class SessionLost extends Error {
  constructor() {
    super("The database connection this was holding a lock on closed, so it stopped there.");
  }
}

/**
 * A connection that is one Postgres session for as long as it is open, for a lock that lasts as
 * long as its session does (`pg_advisory_lock`). Left to itself the library breaks that twice
 * over: it closes a connection at 30 to 60 minutes old, and after any close it quietly opens
 * another for the next query, a new session that holds none of the first one's locks. So this
 * one is never retired for its age or for sitting idle, and once it is lost (Postgres restarted,
 * the network dropped) it stays lost: `onLost` hears of it at once, and every query asked of it
 * from then on throws SessionLost. Closing it (`end`) is not losing it.
 */
export function ownSession(url: string, onLost: () => void = () => {}): Sql {
  let state: "open" | "closed" | "lost" = "open";
  const own = postgres(url, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    idle_timeout: 0,
    max_lifetime: null,
    onnotice: () => {},
    onclose: () => {
      if (state !== "open") return;
      state = "lost";
      onLost();
    },
  });
  const end: Sql["end"] = (options) => {
    if (state === "open") state = "closed";
    // A lost one has nothing left to finish, and the library would wait on the query it died in.
    return own.end(state === "lost" ? { timeout: 0 } : options);
  };
  // Every way to ask it a query is a call of it or of one of its properties, so both are held.
  const held = <T>(ask: () => T): T => {
    if (state === "lost") throw new SessionLost();
    return ask();
  };
  return new Proxy(own, {
    apply: (target, self, args) => held(() => Reflect.apply(target, self, args) as unknown),
    get: (target, key) => (key === "end" ? end : held(() => Reflect.get(target, key) as unknown)),
  });
}
