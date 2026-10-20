// The platform runtime: whether a session is running a turn. It is the only
// witness that a lock's holder is gone, so a runtime that does not answer is
// never read as "gone" — it frees nothing.

/** What the runtime says of one session. */
export type Liveness =
  | "running" // a turn is running
  | "stopped" // not running, or unknown to the runtime: an unattended run that ended
  | "attended" // not running, and a person is present: the direct chat or a Slack session
  | "unreachable"; // the runtime did not answer

export interface SessionInfo {
  readonly id: string;
  readonly type: string;
  readonly running: boolean;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly scheduleId?: string;
}

export interface Runtime {
  liveness(sessionId: string): Promise<Liveness>;
  /** The session's type as the runtime names it, "" when it does not answer. */
  sessionType(sessionId: string): Promise<string>;
  /** Every session of this agent, or undefined when the runtime does not answer. */
  sessions(): Promise<SessionInfo[] | undefined>;
}

/** Session types a person is present in: their turns end between messages. */
export const ATTENDED = new Set(["regular", "channel_slack"]);

export function livenessOf(s: { running?: unknown; type?: unknown } | undefined): Liveness {
  if (s === undefined) return "stopped";
  if (s.running === true) return "running";
  return typeof s.type === "string" && ATTENDED.has(s.type) ? "attended" : "stopped";
}

/** The runtime over HTTP at $PLATFORM_RUNTIME_URL, five seconds a call. */
export class HttpRuntime implements Runtime {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(base: string, timeoutMs = 5000) {
    this.base = base.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async list(input: Record<string, string>): Promise<unknown[] | undefined> {
    if (!this.base) return undefined;
    try {
      const url = `${this.base}/api/trpc/sessions.list?input=${encodeURIComponent(JSON.stringify(input))}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { result?: { data?: { sessions?: unknown } } };
      const sessions = body.result?.data?.sessions;
      return Array.isArray(sessions) ? sessions : undefined;
    } catch {
      return undefined;
    }
  }

  async liveness(sessionId: string): Promise<Liveness> {
    const s = await this.list({ sessionId });
    if (s === undefined) return "unreachable";
    return livenessOf(s[0] as { running?: unknown; type?: unknown } | undefined);
  }

  async sessionType(sessionId: string): Promise<string> {
    const s = await this.list({ sessionId });
    const t = (s?.[0] as { type?: unknown } | undefined)?.type;
    return typeof t === "string" ? t : "";
  }

  async sessions(): Promise<SessionInfo[] | undefined> {
    const s = await this.list({});
    if (s === undefined) return undefined;
    return s.flatMap((raw) => {
      const o = raw as Record<string, unknown>;
      const id = o.sessionId ?? o.id;
      if (typeof id !== "string") return [];
      return [
        {
          id,
          type: typeof o.type === "string" ? o.type : "",
          running: o.running === true,
          ...(typeof o.title === "string" ? { title: o.title } : {}),
          ...(typeof o.updatedAt === "string" ? { updatedAt: o.updatedAt } : {}),
          ...(typeof o.scheduleId === "string" ? { scheduleId: o.scheduleId } : {}),
        },
      ];
    });
  }
}
