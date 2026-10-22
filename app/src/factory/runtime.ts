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
  /** Sends a session of this agent a message, a new turn when it is idle: true once the platform queued it. */
  message(sessionId: string, text: string): Promise<boolean>;
}

/** Session types a person is present in: their turns end between messages. */
export const ATTENDED = new Set(["regular", "channel_slack"]);

export function livenessOf(s: { running?: unknown; type?: unknown } | undefined): Liveness {
  if (s === undefined) return "stopped";
  if (s.running === true) return "running";
  return typeof s.type === "string" && ATTENDED.has(s.type) ? "attended" : "stopped";
}

/**
 * The runtime over HTTP at $PLATFORM_RUNTIME_URL, five seconds a call; a
 * message goes through the platform's MCP server at $PLATFORM_MCP_URL, as the
 * `send_session_message` tool a session calls.
 */
export class HttpRuntime implements Runtime {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly mcp: string;

  constructor(base: string, timeoutMs = 5000, mcp = "") {
    this.base = base.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.mcp = mcp;
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

  async message(sessionId: string, text: string): Promise<boolean> {
    if (!this.mcp) return false;
    try {
      const res = await fetch(this.mcp, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_session_message", arguments: { sessionId, text } },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return false;
      return queued(await res.text());
    } catch {
      return false;
    }
  }
}

/** Whether a tools/call answer, plain JSON or one server-sent event, says the message was queued. */
export function queued(body: string): boolean {
  const json = body.includes("data:")
    ? body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .join("")
    : body;
  try {
    const r = (JSON.parse(json) as { result?: { isError?: unknown; content?: { text?: unknown }[] } }).result;
    if (!r || r.isError === true) return false;
    const text = r.content?.[0]?.text;
    return typeof text === "string" && (JSON.parse(text) as { queued?: unknown }).queued === true;
  } catch {
    return false;
  }
}
