// The `- key: value` files under work/: CONFIG.md, which onboarding writes,
// and the state files the app keeps (items/*.md, GATE.md, the locks' owner
// files). There is one parser, so a value reads the same everywhere.
//
// A key is read from its first `- <key>: <value>` line; a `*` bullet or none,
// spaces around the key and the key's case are tolerated. Everything after
// the key's colon is the value, so a URL survives. Backticks and trailing
// whitespace are stripped. A line in any other shape is invisible, not wrong.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LINE = /^[-*]?[ \t]*([^:\n]+?)[ \t]*:[ \t]*(.*)$/;

/** Every key of a text, lowercased, mapped to its first value. */
export function parseKv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.replace(/\r$/, ""));
    if (!m?.[1]) continue;
    const key = m[1].toLowerCase();
    if (!out.has(key)) out.set(key, (m[2] ?? "").replaceAll("`", "").replace(/\s+$/, ""));
  }
  return out;
}

/** The text of a file, or "" when it cannot be read: a missing file has no keys. */
export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** A key of a `- key: value` file: "" when the file or the key is missing. */
export function kv(path: string, key: string): string {
  return parseKv(readText(path)).get(key.toLowerCase()) ?? "";
}

/** The bullets' keys of a text, lowercased, in order, repeats kept: what verify reads. */
export function bulletKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split("\n")) {
    const m = /^[-*][ \t]*([A-Za-z0-9_]+)[ \t]*:/.exec(raw);
    if (m?.[1]) keys.push(m[1].toLowerCase());
  }
  return keys;
}

/**
 * Rewrites a state file whole, through a temporary file and a rename, so a
 * reader never sees half of it. Each key in `keys` takes its value from `set`
 * when given there, else from the file at `from` (none: starts clean). A value
 * of "" or "-" drops the key; a newline in a value becomes a space.
 */
export function writeKv(
  file: string,
  keys: readonly string[],
  set: Readonly<Record<string, string>>,
  from: string | null = file,
  writer = "scripts/run-state.sh",
): void {
  const old = from === null ? new Map<string, string>() : parseKv(readText(from));
  let body = `# ${basename(file).replace(/\.md$/, "")}\n\nWritten by ${writer}, never by hand.\n\n`;
  for (const k of keys) {
    const v = (k in set ? (set[k] ?? "") : (old.get(k) ?? "")).replaceAll("\n", " ");
    if (v !== "" && v !== "-") body += `- ${k}: ${v}\n`;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}
