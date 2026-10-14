// SOP-197: the claim guard only demands a card for work inside a repository the
// board knows (a project's repo_url matches the repo's remote or path, or the
// repo already has .overclick/) or when a claim is active. Anywhere else it
// stays out of the way. Run: node --test scripts/test-claim-guard-binding.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findRepoRoot,
  normalizeRepoLocation,
  repoMatchesProject,
} from "../plugin/hooks/common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, "..", "plugin", "hooks", "claim-guard.mjs");

// ---- pure pieces ----------------------------------------------------------

test("normalizeRepoLocation reads https, ssh and .git spellings alike", () => {
  const same = [
    "https://github.com/Guilhermecmd/stageops",
    "https://github.com/Guilhermecmd/stageops.git",
    "git@github.com:Guilhermecmd/stageops.git",
    "ssh://git@github.com/Guilhermecmd/stageops.git",
    "https://user:tok@github.com/Guilhermecmd/stageops/",
  ].map(normalizeRepoLocation);
  assert.equal(new Set(same).size, 1);
  assert.equal(same[0], "github.com/guilhermecmd/stageops");
  assert.equal(normalizeRepoLocation(null), "");
  assert.equal(normalizeRepoLocation(""), "");
});

test("repoMatchesProject matches by remote or by local path, never by empty repo_url", () => {
  const projects = [
    { repo_url: "https://github.com/Guilhermecmd/stageops" },
    { repo_url: null },
    { repo_url: "/Users/x/Projetos/local-only" },
  ];
  assert.equal(repoMatchesProject(projects, "/r", ["git@github.com:Guilhermecmd/stageops.git"]), true);
  assert.equal(repoMatchesProject(projects, "/Users/x/Projetos/local-only", []), true);
  assert.equal(repoMatchesProject(projects, "/r", ["https://github.com/other/repo.git"]), false);
  assert.equal(repoMatchesProject([{ repo_url: null }], "/r", []), false);
  assert.equal(repoMatchesProject([], "/r", ["x"]), false);
});

// ---- scratch layout -------------------------------------------------------

let tmp;
let server;
let projects;
let claims;
const dirs = {};

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-bind-")));
  dirs.plain = path.join(tmp, "plain");
  dirs.bound = path.join(tmp, "bound");
  dirs.unbound = path.join(tmp, "unbound");
  dirs.marked = path.join(tmp, "marked", "sub");
  dirs.nogit = path.join(tmp, "nogit");
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  for (const [name, remote] of [
    ["bound", "https://github.com/acme/linked.git"],
    ["unbound", "https://github.com/acme/stranger.git"],
  ]) {
    git(dirs[name], "init", "-q");
    git(dirs[name], "remote", "add", "origin", remote);
  }
  fs.mkdirSync(path.join(tmp, "marked", ".overclick"));

  projects = [{ repo_url: "https://github.com/acme/linked" }, { repo_url: null }];
  claims = 0;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = JSON.parse(body);
      const name = call.params?.name;
      const payload = name === "project_list" ? { projects } : { tasks: Array.from({ length: claims }, () => ({})) };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { structuredContent: payload } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(
    path.join(tmp, "config"),
    `url=http://127.0.0.1:${server.address().port}/mcp\ntoken=t\nenforce_claim=1\n`,
  );
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Async on purpose: the fake board lives in this process, so a blocking spawn
// would freeze the very server the guard is calling.
async function runGuard(tool, input, cwd, { reachable = true, session = "s1" } = {}) {
  const config = reachable ? path.join(tmp, "config") : path.join(tmp, "config-down");
  if (!reachable) {
    fs.writeFileSync(config, "url=http://127.0.0.1:1/mcp\ntoken=t\nenforce_claim=1\n");
  }
  const child = spawn("node", [GUARD], {
    env: { ...process.env, OVERCLICK_CONFIG_FILE: config, HOME: tmp },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stdin.end(JSON.stringify({ tool_name: tool, tool_input: input, cwd, session_id: session }));
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 0);
  return stdout.includes('"decision":"block"') ? JSON.parse(stdout.trim()) : null;
}

test("findRepoRoot: git repo, .overclick wins, nothing -> null, home marker ignored", () => {
  assert.deepEqual(findRepoRoot(dirs.bound), { root: dirs.bound, marked: false });
  assert.deepEqual(findRepoRoot(dirs.marked), { root: path.join(tmp, "marked"), marked: true });
  assert.equal(findRepoRoot(dirs.nogit), null);
  assert.equal(findRepoRoot(""), null);
});

// ---- guard end to end (real process, fake board) --------------------------

const WRITE = { file_path: "x.txt", content: "x" };

test("no repository at all (like ~ or /tmp): write passes without a card", async () => {
  claims = 0;
  assert.equal(await runGuard("Write", WRITE, dirs.nogit), null);
  assert.equal(await runGuard("Bash", { command: "echo x > /tmp/f" }, dirs.nogit), null);
});

test("git repo no project points at: write passes without a card", async () => {
  claims = 0;
  assert.equal(await runGuard("Write", WRITE, dirs.unbound), null);
  assert.equal(await runGuard("Write", WRITE, dirs.plain), null);
});

test("git repo linked to a board project: write without a claim is blocked", async () => {
  claims = 0;
  const out = await runGuard("Write", WRITE, dirs.bound);
  assert.match(out.reason, /claima um card/);
  const shell = await runGuard("Bash", { command: "echo x > f" }, dirs.bound);
  assert.match(shell.reason, /claima um card/);
});

test("repo with .overclick/: write without a claim is blocked", async () => {
  claims = 0;
  const out = await runGuard("Write", WRITE, dirs.marked);
  assert.match(out.reason, /claima um card/);
});

test("linked repo with an active claim in the board: write passes", async () => {
  claims = 1;
  try {
    assert.equal(await runGuard("Write", WRITE, dirs.bound), null);
  } finally {
    claims = 0;
  }
});

test("board down in a git repo: stays strict (cannot prove it is unbound)", async () => {
  const out = await runGuard("Write", WRITE, dirs.unbound, { reachable: false });
  assert.ok(out && typeof out.reason === "string" && out.reason.length > 0);
});

test("board down outside any repository: passes (nothing to bind)", async () => {
  assert.equal(await runGuard("Write", WRITE, dirs.nogit, { reachable: false }), null);
});

test("reads never needed a card, bound or not", async () => {
  assert.equal(await runGuard("Bash", { command: "git status" }, dirs.bound), null);
  assert.equal(await runGuard("Read", { file_path: "x" }, dirs.bound), null);
});
