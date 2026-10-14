// Shared, side-effect-free helpers for every OverClick hook.
//
// The hooks used to be POSIX shell. Claude Code on Windows without Git Bash
// runs hook commands through PowerShell, which neither parses the POSIX form
// ("${CLAUDE_PLUGIN_ROOT}"/hooks/x.sh — the bare slash after the string reads
// as a division operator) nor has a shell able to execute .sh at all, so every
// hook died silently there (issue #63). Node is the one runtime a Claude Code
// client is guaranteed to have, and `node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"`
// keeps the whole path inside the quotes. Nothing here may shell out: no jq,
// no python, no curl, no bash. Only node built-ins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// `execFileSync` with an argv array is not "shelling out" in the sense the
// header comment above warns about (no bash/sh interpreter, no shell string
// parsing, no injection surface) — it is the one external dependency this
// hook already assumes and inspects: a repository with no git binary has no
// commands for this guard to gate in the first place (S2 door 4 / AC 18a).
import { execFileSync } from "node:child_process";

export function configFile() {
  if (process.env.OVERCLICK_CONFIG_FILE) return process.env.OVERCLICK_CONFIG_FILE;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "overclick", "config");
}

// Last `key=value` line wins, exactly like `grep -E "^key=" | tail -n 1`.
export function setting(key) {
  let raw;
  try {
    raw = fs.readFileSync(configFile(), "utf8");
  } catch {
    return "";
  }
  const prefix = `${key}=`;
  let value = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(prefix)) value = line.slice(prefix.length);
  }
  return value;
}

export function enabled(key) {
  return setting(key) === "1";
}

export function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The board answers a JSON-RPC tools/call. `reachable` is false only when the
// board itself could not be reached (no url/token, connection refused, closed
// port, timeout, non-2xx) — never when it answered with zero matching rows.
// Callers that need to tell "board said no" from "board is down" (S2 door 4)
// use the probe; every other caller keeps the plain string via mcpCall.
async function mcpCallProbe(tool, argumentsJson) {
  const url = setting("url");
  const token = setting("token");
  if (!url || !token) return { reachable: false, raw: "" };

  const body = `{"jsonrpc":"2.0","id":"overclick-hook","method":"tools/call","params":{"name":${JSON.stringify(
    tool,
  )},"arguments":${argumentsJson}}}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { reachable: false, raw: "" };
    return { reachable: true, raw: await response.text() };
  } catch {
    return { reachable: false, raw: "" };
  }
}

// The board answers a JSON-RPC tools/call. Returns the raw body, or "" for any
// failure — every caller treats an empty answer as "the board said nothing".
export async function mcpCall(tool, argumentsJson) {
  return (await mcpCallProbe(tool, argumentsJson)).raw;
}

// `.result.structuredContent // (.result.content[0].text | fromjson)`
export function payloadOf(document) {
  const structured = document?.result?.structuredContent;
  if (structured) return structured;
  return JSON.parse(document?.result?.content?.[0]?.text ?? "{}");
}

function harnessSignature(harness) {
  return ["cli", "model", "effort"].map((key) => harness?.[key] ?? "").join("|");
}

// Returns the rendered lines, or null when the answer is not the expected JSON.
export function renderBoard(rawResponse, heading) {
  const document = parseJson(rawResponse);
  if (!document) return null;
  let payload;
  try {
    payload = payloadOf(document);
  } catch {
    return null;
  }
  const tasks = payload?.tasks ?? [];
  const lines = [heading];
  if (!tasks.length) lines.push("- none");
  for (const task of tasks) {
    lines.push(`- ${task.short_id ?? "?"}: ${task.title ?? "Untitled"} [${task.status ?? "?"}]`);
  }
  if (payload?.truncated) lines.push("- more cards omitted");
  return lines;
}

// Returns 0 when the answer cannot be read, matching the shell `|| printf '0'`.
export function countTasks(rawResponse) {
  const document = parseJson(rawResponse);
  if (!document) return 0;
  try {
    return (payloadOf(document).tasks ?? []).length;
  } catch {
    return 0;
  }
}

export function hookHarness(hookInput) {
  return harnessSignature(hookInput?.tool_input?.harness);
}

export function recommendationHarness(rawResponse) {
  const document = parseJson(rawResponse);
  if (!document) return "";
  try {
    return harnessSignature(payloadOf(document).harness);
  } catch {
    return "";
  }
}

export function hookTool(hookInput) {
  return hookInput?.tool_name ?? hookInput?.toolName ?? "";
}

export function hookCwd(hookInput) {
  return hookInput?.cwd ?? hookInput?.working_directory ?? hookInput?.workingDirectory ?? "";
}

export function hookSession(hookInput) {
  return hookInput?.session_id ?? hookInput?.sessionId ?? "";
}

/** Never infer session ownership from a token shared by several panes. */
export async function sessionClaims(hookInput, limit) {
  const sessionId = hookSession(hookInput);
  if (!sessionId) return "";
  return mcpCall("task_list", JSON.stringify({
    status: "em_execucao", claimed_by: "me", session_id: sessionId, limit,
  }));
}

// Same call as sessionClaims, but reports whether the board answered at all
// (S2 door 4 / AC 20-21): a hook that cannot tell "board is down" from
// "board said no claims" cannot narrate the difference to the operator, and
// cannot single out the narrow board-down recovery surface from an ordinary
// missing claim.
export async function sessionClaimsProbe(hookInput, limit) {
  const sessionId = hookSession(hookInput);
  if (!sessionId) return { reachable: false, raw: "" };
  return mcpCallProbe("task_list", JSON.stringify({
    status: "em_execucao", claimed_by: "me", session_id: sessionId, limit,
  }));
}

// The directory `install.sh` clones/updates ustoppble/overclick into — the
// board's own source checkout, never the plugin copy a CLI executes hooks
// from. AC 21's `docker compose ps|up|restart` recovery is scoped to this
// directory specifically so the guard cannot be widened into "any compose
// project" by a command that merely happens to run from somewhere else.
export function installDir() {
  if (process.env.OVERCLICK_INSTALL_DIR) return process.env.OVERCLICK_INSTALL_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "overclick", "plugin-src");
}

export function isOverclickInstallDir(cwd) {
  if (!cwd) return false;
  const root = path.resolve(installDir());
  const here = path.resolve(cwd);
  return here === root || here.startsWith(root + path.sep);
}

// Every key a harness has been seen carrying a shell command under. A shell
// tool whose command hides under some other key reads as empty here, and an
// empty command is not proven read-only — so it blocks (OCL-134).
// C36 / SNP-279: Codex's exec tool sends a shell command as an argv array
// shaped exactly like [interpreter, flags, script] — e.g.
// ["/bin/zsh", "-lc", "sed -n '1,5p' SKILL.md"]. The generic `join(" ")`
// below turns that into one opaque segment headed by the interpreter path,
// so even a bare `sed -n` reading a skill file was classified as an unproven
// mutation and blocked (live repro: a Codex smoke session with no card
// claimed got "claima um card no board antes" on `sed -n ... && sed -n ...`,
// C36's second failure mode). Recognizing this one well-known shape and
// classifying the SCRIPT instead — recursively, through the same
// segment-by-segment checks — fixes the false block without loosening
// anything: a real write hidden in `bash -lc "rm -rf x"` is still classified
// as a write, just now correctly (previously it was already blocked too,
// only for the wrong, opaque reason).
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);

function shellCScript(parts) {
  if (parts.length !== 3) return null;
  const interpreter = (parts[0].split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!SHELL_INTERPRETERS.has(interpreter)) return null;
  if (!/^-[a-z]*c[a-z]*$/i.test(parts[1])) return null;
  return parts[2];
}

export function hookCommand(hookInput) {
  const input = hookInput?.tool_input ?? {};
  for (const key of ["command", "cmd", "commandLine", "command_line", "script", "shell_command", "powershell"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      const script = shellCScript(value);
      return script !== null ? script : value.join(" ");
    }
  }
  return "";
}

// A tool nobody knows, carrying a file body: a write however it is named.
export function writeShapedInput(hookInput) {
  const input = hookInput?.tool_input ?? {};
  if (!input || typeof input !== "object") return false;
  const keys = Object.keys(input);
  if (keys.some((key) => /^(patch|diff|edits|new_string|new_str|new_source|replacement)$/i.test(key))) return true;
  const hasBody = keys.some((key) => /^(content|contents|text|data|body|value)$/i.test(key));
  const hasTarget = keys.some((key) => /^(path|file_path|filePath|file|filename|target|destination)$/i.test(key));
  return hasBody && hasTarget;
}

// The marker the claim guard trusts later. Null whenever the claim did not
// actually take the card: an errored response, a missing id, a status other
// than em_execucao.
export function claimMarker(hookInput, fallbackClaimedAt) {
  const response =
    hookInput?.tool_response ??
    hookInput?.toolResponse ??
    hookInput?.tool_result ??
    hookInput?.toolResult ??
    {};
  const result = response.result ?? {};
  let payload = response.structuredContent ?? result.structuredContent;
  if (!payload) {
    try {
      payload = JSON.parse((response.content ?? result.content ?? [])[0]?.text ?? "{}");
    } catch {
      payload = {};
    }
  }
  const task = payload.task ?? {};
  const attempt = payload.attempt ?? {};
  const input = hookInput?.tool_input ?? {};
  const taskId = task.short_id ?? task.id ?? input.task_id ?? input.id ?? "";
  const claimedAt = attempt.started_at ?? attempt.startedAt ?? fallbackClaimedAt ?? "";
  const isError = Boolean(response.isError ?? result.isError ?? false);
  if (!taskId || !claimedAt || isError) return null;
  if ((task.status ?? "em_execucao") !== "em_execucao") return null;
  return {
    task_id: taskId,
    claimed_at: claimedAt,
    session_id: hookSession(hookInput),
  };
}

export function markerValid(marker, expectedSession) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (typeof marker.task_id !== "string" || !marker.task_id.length) return false;
  if (typeof marker.claimed_at !== "string" || !marker.claimed_at.length) return false;
  const markerSession = marker.session_id ?? "";
  if (markerSession && expectedSession && markerSession !== expectedSession) return false;
  return true;
}

export function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

// SNP-84: the marker used to be one file per cwd (`.overclick/claim.json`),
// with no notion of which pane wrote it. Several panes share the same
// primary cwd (squad convention: visit worktrees via `git -C`/subshell,
// never a persistent `cd`), so every task_claim/task_deliver/task_release
// from ANY of them overwrote the one shared file — last write wins, no
// lock, no merge (see common.mjs history / SNP-84 for the measured
// collision). That pushed most traffic onto the recovery path
// (`sessionClaims`) instead of the fast local check it exists to skip.
// Scoping the filename by session id gives each pane its own marker at the
// same cwd, so siblings stop colliding. A session id is present on every
// caller this file has (Claude Code's real hookInput.session_id, and
// Antigravity's conversationId — see antigravity.sh's `oc_agy_normalize`);
// the "shared" fallback below only covers a hookInput with no session id at
// all, which is the same blind spot the old single-file scheme always had,
// never a regression from it.
function claimFileSlug(sessionId) {
  if (!sessionId || !sessionId.length) return "shared";
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function claimFile(root, sessionId) {
  const base = root && root.length ? root : process.cwd();
  return path.join(base, ".overclick", `claim-${claimFileSlug(sessionId)}.json`);
}

export function writeClaimMarker(root, marker) {
  const file = claimFile(root, marker?.session_id);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.claim.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function clearClaimMarker(root, sessionId) {
  fs.rmSync(claimFile(root, sessionId), { force: true });
}

export function claimMarkerValid(root, expectedSession) {
  let raw;
  try {
    raw = fs.readFileSync(claimFile(root, expectedSession), "utf8");
  } catch {
    return false;
  }
  return markerValid(parseJson(raw), expectedSession);
}

// ---------------------------------------------------------------------------
// Shell command classification (OCL-134).
//
// The old rule asked "does this command LOOK like a write?" and let everything
// else run. That fails OPEN for every dialect the regex does not speak: on
// Windows the shell tool is called `PowerShell`, and
// `[System.IO.File]::WriteAllText(...)` does not look like a write to a POSIX
// regex — the reporter of issue #72 rewrote their own config that way with the
// guard turned on. A guard that silently stops blocking is worse than no guard,
// so the question is inverted: a command runs unclaimed only when it is
// PROVABLY read-only. Unknown verb, unknown dialect, unreadable input — all
// mutations as far as the guard is concerned.

// SOP-177: stands in for a `$(...)` inside a segment's text. The substitution
// body is extracted and judged on its own (recursively); the marker keeps the
// surrounding word shape (quoted or not, leading dash or not) visible.
const SUBST_MARK = "\u0001";

// Index of the `)` that closes a `$(` whose body starts at `from`, or -1.
// Quote-aware (a `)` inside quotes does not count) and recursive for nested
// `$(`, which restarts quoting.
function matchParen(source, from) {
  let depth = 1;
  let quote = "";
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = "";
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "(") {
      const end = matchParen(source, index + 2);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Splits a command into segments at ; | & and newlines, honouring (outside
// single quotes) backslash escapes, (outside quotes) comments, and replacing
// every `$(...)` by SUBST_MARK while remembering its body. Separators inside
// quotes or inside `$(...)` do not split, so `grep 'a|b' file` stays one
// segment. Returns null for anything it cannot parse with certainty
// (unbalanced quote or `$(`, trailing backslash, backtick) — the caller treats
// that as a mutation.
function scanShell(command) {
  const segments = [];
  let text = "";
  let substitutions = [];
  let quote = "";
  const flush = () => {
    const trimmed = text.trim();
    if (trimmed) segments.push({ text: trimmed, substitutions });
    text = "";
    substitutions = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      text += character;
      if (character === "'") quote = "";
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= command.length) return null;
      text += character + command[index + 1];
      index += 1;
      continue;
    }
    if (character === "`") return null;
    if (character === "$" && command[index + 1] === "(") {
      const end = matchParen(command, index + 2);
      if (end < 0) return null;
      substitutions.push({ inner: command.slice(index + 2, end), quoted: quote === '"' });
      text += SUBST_MARK;
      index = end;
      continue;
    }
    if (quote === '"') {
      text += character;
      if (character === '"') quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      text += character;
      continue;
    }
    if (character === "#" && (text === "" || /\s$/.test(text))) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (character === ";" || character === "|" || character === "&" || character === "\n" || character === "\r") {
      flush();
      continue;
    }
    text += character;
  }
  if (quote) return null;
  flush();
  return segments;
}

// Anything that can smuggle a second command past the verb allowlist. Checked
// against the raw command, quotes included: a read-only `grep '>'` blocked by
// this is a false alarm the operator can fix with a claim, while the reverse
// mistake is the bug this card exists to close. `$(...)` is NOT here any more
// (SOP-177): scanShell extracts it and commandReadOnly judges its body.
const EVALUATION_TRAPS = [
  /[\u0001]/, // SUBST_MARK is reserved for scanShell
  /\$'/, // ANSI-C quoting: its quote rules differ from the scanner's
  /`/, // POSIX backtick substitution
  /<\(/, // process substitution
  /\$\{[^}]*[;|&]/, // parameter expansion hiding a command
  /\[\s*(System|IO|Microsoft)\./i, // .NET type literal: [System.IO.File]::...
  /::\s*[A-Za-z_]\w*\s*\(/, // any .NET static call
  /(^|[\s;|&(])(eval|exec|source|iex|Invoke-Expression|Invoke-Command|Start-Process|Start-Job|xargs|env|sudo|doas|nohup|setsid|Set-Alias|New-Alias)([\s;|&)]|$)/i,
];

// Verbs that cannot mutate anything on their own. A head not listed here is not
// "probably fine" — it is unproven, which now means blocked.
const READ_ONLY_HEADS = new Set([
  // POSIX / GNU
  "ls", "ll", "cat", "bat", "head", "tail", "less", "more", "echo", "printf",
  "pwd", "cd", "wc", "grep", "egrep", "fgrep", "rg", "ack", "file", "stat",
  "du", "df", "tree", "which", "whereis", "whoami", "id", "hostname", "uname",
  "date", "printenv", "basename", "dirname", "realpath", "readlink", "sort",
  "uniq", "cut", "tr", "diff", "comm", "cmp", "column", "fold", "nl", "od",
  "xxd", "strings", "md5sum", "sha1sum", "sha256sum", "shasum", "jq", "yq",
  "true", "false", "test", "sleep", "man", "help", "history", "ps", "top",
  // `find` and `sed` mutate only through the flags HEAD_ARGUMENT_TRAPS
  // catches above (-exec/-delete/... and -i/w respectively), so the head
  // itself is read-only (S2 / AC 15).
  "find", "sed",
  // Windows cmd
  "dir", "type", "where", "findstr", "ver", "systeminfo", "tasklist",
]);

// PowerShell verbs are open-ended, so the allowlist is the cmdlet name itself.
// Get-* is safe as a family; ForEach-Object and Where-Object are NOT, because a
// script block carries arbitrary code the allowlist never sees.
const READ_ONLY_CMDLETS =
  /^(Get-[A-Za-z]+|Test-Path|Test-Connection|Resolve-Path|Split-Path|Join-Path|Select-String|Select-Object|Sort-Object|Group-Object|Measure-Object|Compare-Object|Format-(List|Table|Wide|Custom)|Out-(String|Host|GridView)|Write-(Host|Output)|ConvertTo-(Json|Csv|Xml)|ConvertFrom-(Json|Csv|Xml|StringData)|Show-Command)$/i;

// Subcommand-shaped tools: the head alone proves nothing.
const READ_ONLY_SUBCOMMANDS = {
  // `git` decides through gitReadOnly() instead (its subcommand can hide
  // behind `-C <dir>` and some, like `branch`, are read-only only with
  // certain arguments) — this map stays for the other subcommand-shaped tools.
  gh: new Set(["pr", "issue", "repo", "run", "api"]),
  // `docker logs` is here rather than in HEAD_ARGUMENT_TRAPS because it is
  // read-only by default and only its `-f`/`--follow` form is trapped above.
  docker: new Set(["ps", "inspect", "logs"]),
};

// Read-only heads that stop being read-only with the wrong flag.
const HEAD_ARGUMENT_TRAPS = {
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)\b/,
  // A sed `w` command is usually glued to its address with no space
  // (`1w file`, `$w file`, `s/a/b/w file`) — the address itself is often a
  // digit, so the trap excludes only a preceding letter/underscore (which
  // would make it part of a word like "new" or "raw"), not a digit.
  sed: /(^|\s)-\S*i|(^|[^A-Za-z_])[wWe]\s+\S|\/[0-9gIpmM]*[we][0-9gIpmM]*['"]?(\s|$)/,
  sort: /(^|\s)-\S*o|--output/,
  // SOP-177: the heads below mutate or execute through one flag each.
  yq: /(^|\s)-\S*i|--inplace/,
  date: /(^|\s)(-s|--set)\b/,
  tree: /(^|\s)-o\b/,
  grep: /(^|\s)-\S*[of]\s|--output/,
  rg: /(^|\s)--files-with-matches\s*>|(^|\s)-r\b|--replace|--pre\b/,
  gh: /(^|\s)(create|edit|delete|close|merge|comment|clone|sync|rerun|cancel)\b|-X\s*(POST|PUT|PATCH|DELETE)/i,
  // `docker logs -f`/`--follow` never returns, so it is treated the same as a
  // mutation: a command this hook cannot observe finishing is not proven safe.
  docker: /(^|\s)logs\b[^;&|]*\s(-f\b|--follow\b)/,
};

// Heads that are read-only only with a specific flag present (S2 / AC 15):
// `unzip -l`/`-p` list or print; any other invocation can extract to disk.
const READ_ONLY_FLAG_HEADS = {
  unzip: /(^|\s)-l(\s|$)|(^|\s)-p(\s|$)/,
};

// `git` read subcommands whose safety never depends on their arguments.
const GIT_SIMPLE_READ_SUBCOMMANDS = new Set([
  "log", "status", "show", "blame", "describe", "shortlog",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "cat-file",
  "name-rev", "whatchanged", "grep", "count-objects",
]);

// `git branch` with no argument, or only a listing flag, reads; `-d/-D` (delete),
// `-m/-M` (rename) and `-c/-C` (copy) mutate (AC 19) and are deliberately absent.
const GIT_BRANCH_READ_ARGS = new Set(["--list", "-l", "-a", "-r", "-v", "-vv", "--show-current"]);

// S2 door 4 / AC 18a: the same two prefixes Write/Edit already publish
// without a claim (PLANNING_WRITE_PATH in claim-guard.mjs) — duplicated here
// rather than imported both ways, since this module has no dependency on
// that one and the two lists must read identically to stay in sync.
const SPEC_PUBLISH_PATH = /(^|[\\/])\.specs[\\/]|(^|[\\/])docs[\\/]plano[\\/]aprovacoes[\\/]/;

function runGit(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// Paths in the index right now — what a `git commit` with no pathspec is
// about to commit.
function gitStagedPaths(cwd) {
  const out = runGit(cwd, ["diff", "--cached", "--name-only"]);
  if (out === null || out === "") return [];
  return out.split(/\r?\n/).filter(Boolean);
}

// Paths touched by every commit this branch has that its upstream does not —
// what a `git push` or `gh pr create` is about to publish. No upstream (a
// branch that has never been pushed) is not proven spec-only, so it returns
// empty rather than guessing a base.
function gitUnpushedPaths(cwd) {
  const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream === null || upstream === "") return [];
  const out = runGit(cwd, ["diff", "--name-only", `${upstream}..HEAD`]);
  if (out === null || out === "") return [];
  return out.split(/\r?\n/).filter(Boolean);
}

// AC 18a: the exact publish sequence a spec-lane session runs without a
// claim — stage, commit, push, open the PR — passes only when every path it
// touches is spec-only; a single product file anywhere in that set makes the
// whole command an ordinary mutation like any other (claim required). Fails
// closed: an empty change set, a `git`/network error, or a command this
// function does not recognize as part of the sequence is never exempted.
export function specOnlyPublish(command, cwd) {
  if (!cwd) return false;
  const trimmed = command.trim();

  const addMatch = /^git\s+add\s+(.+)$/.exec(trimmed);
  if (addMatch) {
    const paths = tokenize(addMatch[1]).filter((token) => token && !token.startsWith("-"));
    return paths.length > 0 && paths.every((p) => SPEC_PUBLISH_PATH.test(p));
  }
  if (/^git\s+commit\b/.test(trimmed)) {
    const paths = gitStagedPaths(cwd);
    return paths.length > 0 && paths.every((p) => SPEC_PUBLISH_PATH.test(p));
  }
  if (/^git\s+push\b/.test(trimmed) || /^gh\s+pr\s+create\b/.test(trimmed)) {
    const paths = gitUnpushedPaths(cwd);
    return paths.length > 0 && paths.every((p) => SPEC_PUBLISH_PATH.test(p));
  }
  return false;
}

// A quoted argument (`git -C "dir with spaces" log`) must stay one token, so
// both `git -C <dir>` and the tlc validator path are read through a small
// quote-aware tokenizer rather than a `.split(/\s+/)`.
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = "";
  let inToken = false;
  for (const character of segment) {
    if (quote) {
      if (character === quote) {
        quote = "";
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += character;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// `git -C <dir> <verb>` hides the subcommand behind a flag whose argument can
// itself contain spaces, so this reads the tokens instead of a fixed index.
function gitReadOnly(segment) {
  const tokens = tokenize(segment);
  let index = 1;
  // Global options that change where git looks or how it pages, never what it
  // writes (SOP-177).
  while (index < tokens.length) {
    if (tokens[index] === "-C") index += 2;
    else if (tokens[index] === "--no-pager" || tokens[index] === "-P" || tokens[index] === "--no-optional-locks") index += 1;
    else break;
  }
  const subcommand = tokens[index] ?? "";
  const rest = tokens.slice(index + 1);

  // Flags that make an otherwise read-only subcommand write a file or run a
  // program: `git log --output=f`, `git grep -O<cmd>`, external diff/textconv.
  if (rest.some((token) => /^(--output(=|$)|--ext-diff$|--textconv$|-O|--open-files-in-pager)/.test(token))) {
    return false;
  }
  if (subcommand === "diff") return true;
  if (subcommand === "branch") {
    // `--list` turns positional arguments into patterns; without it
    // `git branch name` creates a branch.
    const listing = rest.some((token) => token === "--list" || token === "-l");
    return (
      rest.length === 0 ||
      rest.every((token) => GIT_BRANCH_READ_ARGS.has(token) || (listing && token !== "" && !token.startsWith("-")))
    );
  }
  if (subcommand === "remote") {
    return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
  }
  if (subcommand === "worktree") {
    return rest.length === 1 && rest[0] === "list";
  }
  return GIT_SIMPLE_READ_SUBCOMMANDS.has(subcommand);
}

// The four tlc-spec-lean validators (S2 / AC 17) — the only python invocation
// this hook ever allows without a claim, and only by exact script name so a
// path that merely contains the word "scripts" does not slip through.
const TLC_VALIDATOR_SCRIPT =
  /[\\/]scripts[\\/](validate_plan|validate_checks|validate_verification|selftest)\.py$/;

function pythonReadOnly(segment) {
  const tokens = tokenize(segment);
  const scriptPath = tokens[1] ?? "";
  return TLC_VALIDATOR_SCRIPT.test(scriptPath);
}

function segmentHead(segment) {
  const head = segment.split(/\s+/)[0] ?? "";
  // `FOO=bar cmd`, `(cmd`, `$cmd`, `./script` — none of them prove anything.
  if (!head || /[=$(){}\u0001]/.test(head)) return "";
  return head.replace(/^\.\//, "");
}

function segmentReadOnly(segment) {
  const head = segmentHead(segment);
  if (!head) return false;

  // `git` and the tlc validators decide on their full shape, not the head
  // alone, so they branch before the generic trap/subcommand/head checks.
  if (head === "git") return gitReadOnly(segment);
  if (head === "python3" || head === "python") return pythonReadOnly(segment);

  const trap = HEAD_ARGUMENT_TRAPS[head];
  if (trap && trap.test(segment)) return false;

  const flagGate = READ_ONLY_FLAG_HEADS[head];
  if (flagGate) return flagGate.test(segment);

  const subcommands = READ_ONLY_SUBCOMMANDS[head];
  if (subcommands) {
    const argument = segment.split(/\s+/)[1] ?? "";
    // `git -C other-repo commit` hides the subcommand behind a flag.
    return subcommands.has(argument);
  }

  if (READ_ONLY_HEADS.has(head)) return true;
  if (READ_ONLY_HEADS.has(head.toLowerCase())) return true;
  return READ_ONLY_CMDLETS.test(head);
}

// Output-only discards are not writes: `2>/dev/null`, `>/dev/null`, `2>&1`.
function withoutDiscards(command) {
  return command
    .replace(/[0-9]*>>?\s*(\/dev\/null|\$null|NUL)\b/gi, "")
    .replace(/[0-9]*>&[0-9]+/g, "");
}

const REDIRECTION = /(^|[^<>0-9])>{1,2}\s*[^&\s]/;

// The whole point of the card: proof, not vibes. Everything that is not proven
// read-only is treated as a mutation by the callers of this function.
export function commandReadOnly(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  return scriptReadOnly(command, 0);
}

// SOP-177. Heads whose behaviour no argument can turn into a write or an
// execution: only for these may an UNQUOTED `$(...)` (or an unquoted tainted
// loop variable) supply arguments, because it can expand into several words
// and smuggle a flag. Everywhere else a substitution must be one double-quoted
// word that does not start with a dash.
const NO_FLAG_RISK_HEADS = new Set([
  "echo", "printf", "ls", "ll", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep",
  "stat", "file", "basename", "dirname", "realpath", "readlink", "du", "cut", "tr",
  "uniq", "nl", "column", "fold", "test", "true", "false", "pwd", "which", "type",
]);
const MAX_SCRIPT_DEPTH = 4;
const FOR_HEADER = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in(\s+[\s\S]*)?$/;

// A script is read-only when every segment is, every `$(...)` body is, and
// every `for` loop is balanced, iterates a literal/glob list (or a read-only
// substitution) and has only read-only commands in its body.
function scriptReadOnly(command, depth) {
  if (depth > MAX_SCRIPT_DEPTH) return false;
  if (EVALUATION_TRAPS.some((trap) => trap.test(command))) return false;
  const stripped = withoutDiscards(command);
  if (REDIRECTION.test(stripped)) return false;
  const segments = scanShell(stripped);
  if (!segments) return false;
  if (!segments.length) return depth > 0;

  const loops = []; // one { variable, tainted } per open `for`
  let expectDo = false;
  for (const segment of segments) {
    let text = segment.text;

    if (expectDo) {
      if (text !== "do" && !text.startsWith("do ")) return false;
      expectDo = false;
      text = text.slice(2).trim();
      if (!text) continue;
    }
    if (text === "done") {
      if (!loops.length) return false;
      loops.pop();
      continue;
    }

    // Every substitution body must itself be read-only.
    if (!segment.substitutions.every((substitution) => scriptReadOnly(substitution.inner, depth + 1))) return false;
    const unquotedSubstitution = segment.substitutions.some((substitution) => !substitution.quoted);

    const header = FOR_HEADER.exec(text);
    if (header) {
      const words = tokenize(header[2] ?? "");
      if (!words.length) return false;
      // A list word is a literal or glob. A leading dash could inject a flag
      // into a body command; any other `$`, parenthesis or brace group is
      // dynamic and unproven.
      for (const word of words) {
        if (word.startsWith("-") || /[()]/.test(word.replaceAll(SUBST_MARK, ""))) return false;
        if (/\$/.test(word)) return false;
      }
      loops.push({ variable: header[1], tainted: unquotedSubstitution || words.some((word) => word.includes(SUBST_MARK)) });
      expectDo = true;
      continue;
    }

    const head = segmentHead(text);
    if (!head) return false;
    const taintedVariable = loops.some(
      (loop) => loop.tainted && new RegExp(`\\$(\\{${loop.variable}\\}|${loop.variable}\\b)`).test(text),
    );
    if ((unquotedSubstitution || taintedVariable) && !NO_FLAG_RISK_HEADS.has(head)) return false;
    if (tokenize(text).some((token) => token.includes(SUBST_MARK) && token.startsWith("-"))) return false;

    if (!segmentReadOnly(text)) return false;
  }
  return loops.length === 0 && !expectDo;
}

// The same command with the contents of quoted strings blanked out, except for
// `$(...)` bodies, which still run: WRITE_COMMANDS asks whether a write VERB
// is being executed, not whether the word appears in a grep pattern.
function withoutQuotedText(command) {
  let result = "";
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = "";
      continue;
    }
    if (character === "\\") {
      result += quote ? "" : character + (command[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      const end = matchParen(command, index + 2);
      if (end < 0) return command;
      result += ` ${command.slice(index + 2, end)} `;
      index = end;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += " ";
      continue;
    }
    if (character === "#" && (result === "" || /\s$/.test(result))) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    result += character;
  }
  return quote ? command : result;
}

// Kept as a second, independent opinion. commandReadOnly already blocks
// everything below, but an accidental widening of the read allowlist would
// still have to get past this list to relax POSIX enforcement, which OCL-134
// explicitly forbids. It also speaks the PowerShell dialect now.
const WRITE_COMMANDS = new RegExp(
  "(^|[;&|()\\s])(apply_patch|touch|mkdir|rmdir|rm|mv|cp|install|ln|chmod|chown|truncate|dd|tee)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(sed\\s+(-[^\\s]*)?i|perl\\s+-[^\\s]*i)" +
    // `branch` and `worktree` are judged by gitReadOnly() instead (S2 / AC 16,
    // AC 19): both have a read-only shape (`branch` with no argument or a
    // listing flag, `worktree list`) alongside a mutating one, so neither can
    // be an unconditional write verb here without also blocking the read shape.
    "|(^|[;&|()\\s])git\\s+(add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch|tag)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(npm|pnpm|yarn|bun)\\s+(add|install|remove|uninstall|update|upgrade|link|unlink|publish)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(bash|sh|zsh|python3?|node)\\s+[^;&|]*([.]sh|-[cm])[;&|\\s]*" +
    // PowerShell cmdlets, cmd.exe verbs, and .NET file APIs (issue #72).
    "|(^|[;&|()\\s])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl|Export-Csv|Export-Clixml|Tee-Object|Start-Process|Invoke-Expression|New-Object|del|erase|ren|rename|move|copy|xcopy|robocopy|attrib|icacls|fsutil)([;&|()\\s]|$)" +
    "|\\[\\s*(System\\.)?(IO\\.)?(File|Directory|FileInfo|DirectoryInfo|StreamWriter)\\s*\\]\\s*::" +
    "|::\\s*(Write|Create|Delete|Move|Copy|Append|Replace|SetAttributes)[A-Za-z]*\\s*\\(",
  "i",
);

// A feature slug can legally contain "-c" or "-m" (`some-cool-feature`), which
// the generic `python3 ... -c|-m` write heuristic below would otherwise trip
// on for a validator call such as `python3 .../validate_checks.py some-cool-
// feature` — the exact shape AC 17 requires passing regardless of its argument.
function tlcValidatorInvocation(command) {
  const tokens = tokenize(command.trim());
  const head = tokens[0] ?? "";
  if (head !== "python3" && head !== "python") return false;
  return TLC_VALIDATOR_SCRIPT.test(tokens[1] ?? "");
}

export function commandWrites(command) {
  if (!command) return false;
  if (tlcValidatorInvocation(command)) return false;
  const stripped = withoutDiscards(command);
  if (REDIRECTION.test(stripped)) return true;
  return WRITE_COMMANDS.test(withoutQuotedText(command));
}

// A hook that throws is a hook that fails closed on the wrong side: Claude Code
// prints the stack trace and the guard decision is lost. Every entrypoint wraps
// its body with this.
export function failOpen(main) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
