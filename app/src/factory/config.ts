// work/CONFIG.md: every instance value, written at onboarding and read before
// anything else. A missing key never crashes a command: each getter names the
// default the kit documents for it, and degrades to that.
import { join } from "node:path";
import { bulletKeys, parseKv, readText } from "./kv.ts";

export type Mode = "autonomous" | "interactive";

export class Config {
  readonly path: string;
  readonly text: string;
  private readonly values: Map<string, string>;

  constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
    this.values = parseKv(text);
  }

  static load(work: string): Config {
    const path = join(work, "CONFIG.md");
    return new Config(path, readText(path));
  }

  get exists(): boolean {
    return this.text !== "";
  }

  /** A key's value, "" when it is missing. */
  get(key: string): string {
    return this.values.get(key.toLowerCase()) ?? "";
  }

  /** A key's value, or the default when it is missing or empty. */
  or(key: string, fallback: string): string {
    return this.get(key) || fallback;
  }

  /**
   * A whole number: the default when the value is missing or not digits, and
   * when it is below `min` — `slots: 0` reads as the default, `stuck_after_min:
   * 0` as zero, as the kit has always read them.
   */
  int(key: string, fallback: number, min = 0): number {
    const v = this.get(key);
    if (!/^[0-9]+$/.test(v)) return fallback;
    const n = Number(v);
    return n < min ? fallback : n;
  }

  /** `autonomous` only when CONFIG.md says so: an instance nobody set loose watches nothing. */
  mode(): Mode {
    return this.get("mode").toLowerCase() === "autonomous" ? "autonomous" : "interactive";
  }

  /** A list key, split on spaces and commas. */
  list(key: string): string[] {
    return this.get(key)
      .split(/[\s,]+/)
      .filter((s) => s !== "");
  }

  /** Every bullet key, lowercased and in order, repeats kept. */
  keys(): string[] {
    return bulletKeys(this.text);
  }
}

/** `[host/]owner/name`, split: github.com when no host is given. */
export function splitRepo(repo: string): { host: string; slug: string } {
  const parts = repo.split("/");
  if (parts.length >= 3) return { host: parts[0] ?? "github.com", slug: parts.slice(1).join("/") };
  return { host: "github.com", slug: repo };
}
