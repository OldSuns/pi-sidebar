import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { classify, type GitExec, GitMonitor, type GitRun, readGit } from "../src/git/monitor.ts";
import { buildGitInfo, mergeCounts, parseNumstat, parseStatus } from "../src/git/parse.ts";
import type { GitState } from "../src/state/snapshot.ts";

const STATUS = [
  "# branch.oid 0123456789abcdef0123456789abcdef01234567",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
  "1 .M N... 100644 100644 100644 aaaa bbbb src/a file.ts",
  "1 A. N... 000000 100644 100644 0000 bbbb src/new.ts",
  "1 .D N... 100644 100644 000000 aaaa aaaa gone.ts",
  "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/renamed.ts",
  "src/original.ts",
  "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts",
  "? notes/todo.md",
  "! ignored.log",
  "",
].join("\0");

test("status: branch headers and every entry type, paths with spaces", () => {
  const status = parseStatus(STATUS);
  assert.equal(status.initial, false);
  assert.equal(status.commit, "0123456");
  assert.equal(status.branch, "main");
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.files, [
    { status: "M", path: "src/a file.ts" },
    { status: "A", path: "src/new.ts" },
    { status: "D", path: "gone.ts" },
    { status: "R", path: "src/renamed.ts" },
    { status: "U", path: "conflict.ts" },
    { status: "?", path: "notes/todo.md" },
  ]);
});

test("status: detached HEAD and a branch without commits", () => {
  const detached = parseStatus("# branch.oid 89abcdef0123\0# branch.head (detached)\0");
  assert.equal(detached.branch, undefined);
  assert.equal(detached.commit, "89abcde");
  const initial = parseStatus("# branch.oid (initial)\0# branch.head main\0");
  assert.equal(initial.initial, true);
  assert.equal(initial.commit, undefined);
  assert.equal(initial.branch, "main");
});

test("numstat: binary files and renames keyed by the new path", () => {
  const counts = parseNumstat(["3\t1\tsrc/a file.ts", "-\t-\timage.png", "5\t0\t", "old/name.ts", "new/name.ts", ""].join("\0"));
  assert.deepEqual([...counts], [
    ["src/a file.ts", { added: 3, removed: 1, binary: false }],
    ["image.png", { added: 0, removed: 0, binary: true }],
    ["new/name.ts", { added: 5, removed: 0, binary: false }],
  ]);
  const merged = mergeCounts(new Map([["a", { added: 1, removed: 0, binary: false }]]), new Map([["a", { added: 2, removed: 3, binary: false }]]));
  assert.deepEqual(merged.get("a"), { added: 3, removed: 3, binary: false });
});

test("info: conflicts first, untracked last, the rest by changed lines; totals from the counts", () => {
  const counts = parseNumstat(["3\t1\tsrc/a file.ts", "12\t0\tsrc/new.ts", "0\t7\tgone.ts", "5\t0\tsrc/renamed.ts", "1\t1\tconflict.ts", ""].join("\0"));
  const info = buildGitInfo(parseStatus(STATUS), counts);
  assert.deepEqual(
    info.files.map((file) => `${file.status} ${file.path}`),
    ["U conflict.ts", "A src/new.ts", "D gone.ts", "R src/renamed.ts", "M src/a file.ts", "? notes/todo.md"],
  );
  assert.equal(info.added, 21);
  assert.equal(info.removed, 9);
  assert.equal(info.files.at(-1)?.added, undefined);
});

const run = (overrides: Partial<GitRun>): GitRun => ({ stdout: "", stderr: "", code: 0, killed: false, ...overrides });

test("failures map to what the panel shows", () => {
  assert.equal(classify(run({})), undefined);
  assert.deepEqual(classify(run({ code: 128, stderr: "fatal: not a git repository (or any parent)" }))?.state, { kind: "none" });
  assert.deepEqual(classify(run({ code: 128, stderr: "fatal: detected dubious ownership in repository" }))?.state, {
    kind: "error",
    message: "unsafe repository",
  });
  assert.deepEqual(classify(run({ code: 1 }))?.state, { kind: "error", message: "git not found" });
  assert.equal(classify(run({ killed: true, code: 1 }))?.slow, true);
  assert.deepEqual(classify(run({ code: 2, stderr: "\nerror: \u001b[31mboom\u001b[0m\n" }))?.state, { kind: "error", message: "error: boom" });
});

/** An exec that answers status and diff from canned output and records the calls. */
function cannedExec(status: string, diff: string) {
  const calls: string[][] = [];
  let release: () => void = () => {};
  let gate: Promise<void> | undefined;
  const exec: GitExec = async (args) => {
    calls.push(args);
    if (gate) await gate;
    return run({ stdout: args.includes("status") ? status : diff });
  };
  return {
    exec,
    calls,
    hold() {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    release() {
      gate = undefined;
      release();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("every git call is read-only and hardened", async () => {
  const fake = cannedExec(STATUS, "");
  await readGit(fake.exec, 1000, new AbortController().signal, Date.now);
  assert.equal(fake.calls.length, 2);
  for (const args of fake.calls) {
    assert.deepEqual(args.slice(0, 6), ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]);
    assert.ok(["status", "diff"].includes(args[6] ?? ""));
  }
  assert.deepEqual(fake.calls[1]?.slice(6), ["diff", "HEAD", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-color"]);
});

test("monitor: no git process while inactive, one refresh once active", async () => {
  const fake = cannedExec(STATUS, "");
  const states: GitState[] = [];
  const monitor = new GitMonitor({ exec: fake.exec, onState: (state) => states.push(state), pollSeconds: 0 });
  monitor.request(0);
  await settle();
  assert.equal(fake.calls.length, 0);
  monitor.setActive(true);
  await settle();
  assert.equal(fake.calls.length, 2);
  assert.equal(states.at(-1)?.kind, "ok");
  monitor.dispose();
});

test("monitor: requests during a refresh lead to exactly one more refresh", async () => {
  const fake = cannedExec(STATUS, "");
  const monitor = new GitMonitor({ exec: fake.exec, onState: () => {}, pollSeconds: 0 });
  fake.hold();
  monitor.setActive(true);
  await settle();
  monitor.request(0);
  monitor.request(0);
  monitor.request(0);
  fake.release();
  await settle();
  await settle();
  // Two refreshes of two commands each: one process at a time, no pile-up.
  assert.equal(fake.calls.length, 4);
  monitor.dispose();
});

const hasGit = spawnSync("git", ["--version"]).status === 0;
const repo = mkdtempSync(join(tmpdir(), "pi-sidebar-git-"));
after(() => rmSync(repo, { recursive: true, force: true }));

function gitIn(cwd: string, ...args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

/** Git in `cwd` that must succeed. */
const gitAt =
  (cwd: string) =>
  (...args: string[]): void => {
    const result = gitIn(cwd, ...args);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };

const git = gitAt(repo);

/** What `pi.exec` does for the monitor: run git in a directory, never throw. */
const execIn =
  (cwd: string): GitExec =>
  (args, timeoutMs, signal) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, timeout: timeoutMs, signal, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
        resolve({ stdout, stderr, code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0, killed: Boolean(failure?.killed) });
      });
    });

const realExec = execIn(repo);

test("a real repository: before and after the first commit", { skip: !hasGit && "git is not installed" }, async () => {
  git("-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "untracked\n");
  git("add", "a.txt");
  const before = await readGit(realExec, 10_000, new AbortController().signal, Date.now);
  assert.equal(before.state.kind, "ok");
  if (before.state.kind !== "ok") return;
  assert.equal(before.state.info.branch, "main");
  assert.equal(before.state.info.commit, undefined);
  assert.deepEqual(before.state.info.files, [
    { status: "A", path: "a.txt", added: 2, removed: 0 },
    { status: "?", path: "b.txt" },
  ]);

  git("commit", "-q", "-m", "first");
  writeFileSync(join(repo, "a.txt"), "one\nthree\nfour\n");
  const after = await readGit(realExec, 10_000, new AbortController().signal, Date.now);
  assert.equal(after.state.kind, "ok");
  if (after.state.kind !== "ok") return;
  assert.match(after.state.info.commit ?? "", /^[0-9a-f]{7}$/);
  assert.deepEqual(after.state.info.files[0], { status: "M", path: "a.txt", added: 2, removed: 1 });
  assert.equal(after.state.info.added, 2);
  assert.equal(after.state.info.removed, 1);
});

test("a directory outside any repository", { skip: !hasGit && "git is not installed" }, async () => {
  const outside = mkdtempSync(join(tmpdir(), "pi-sidebar-plain-"));
  try {
    const exec: GitExec = (args, timeoutMs, signal) =>
      new Promise((resolve) => {
        execFile("git", ["--git-dir", join(outside, "missing"), ...args], { cwd: outside, timeout: timeoutMs, signal, encoding: "utf8" }, (error, stdout, stderr) => {
          resolve({ stdout, stderr, code: error ? 128 : 0, killed: false });
        });
      });
    const outcome = await readGit(exec, 10_000, new AbortController().signal, Date.now);
    assert.equal(outcome.state.kind, "none");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

/** A fresh repository with one commit of `files`. */
function freshRepo(files: Record<string, string | Buffer>): { dir: string; git: (...args: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-git-"));
  const run = gitAt(dir);
  run("-c", "init.defaultBranch=main", "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  run("add", ".");
  run("commit", "-q", "-m", "base");
  return { dir, git: run };
}

const readIn = async (cwd: string) => {
  const outcome = await readGit(execIn(cwd), 10_000, new AbortController().signal, Date.now);
  assert.equal(outcome.state.kind, "ok", JSON.stringify(outcome.state));
  return outcome.state.kind === "ok" ? outcome.state.info : assert.fail("no git info");
};

test("a real repository: a rename and a binary file, read from a subdirectory", { skip: !hasGit && "git is not installed" }, async () => {
  const { dir, git: run } = freshRepo({ "src/old.ts": "export const a = 1;\n", "logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]) });
  try {
    run("mv", "src/old.ts", "src/new.ts");
    writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 9, 9, 9, 0, 255, 7]));
    // Paths stay relative to the top of the repository, wherever Pi runs.
    const info = await readIn(join(dir, "src"));
    const renamed = info.files.find((file) => file.status === "R");
    assert.deepEqual([renamed?.path, renamed?.added ?? 0, renamed?.removed ?? 0], ["src/new.ts", 0, 0]);
    const binary = info.files.find((file) => file.path === "logo.bin");
    assert.deepEqual([binary?.status, binary?.binary, binary?.added], ["M", true, undefined]);
    assert.equal(info.files.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real repository: a merge conflict comes first; a detached HEAD has a commit but no branch", { skip: !hasGit && "git is not installed" }, async () => {
  const { dir, git: run } = freshRepo({ "a.txt": "base\n", "z.txt": "z\n" });
  try {
    run("checkout", "-q", "-b", "other");
    writeFileSync(join(dir, "a.txt"), "other\n");
    run("commit", "-q", "-am", "other");
    run("checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "main\n");
    run("commit", "-q", "-am", "main");
    assert.notEqual(gitIn(dir, "merge", "-q", "other").status, 0, "the merge conflicts");
    writeFileSync(join(dir, "z.txt"), "z\nmore\nlines\nthan\nthe\nconflict\n");
    const conflicted = await readIn(dir);
    assert.deepEqual(
      conflicted.files.map((file) => [file.status, file.path]),
      [
        ["U", "a.txt"],
        ["M", "z.txt"],
      ],
    );
    assert.equal(conflicted.branch, "main");

    run("merge", "--abort");
    run("checkout", "-q", "--detach");
    const detached = await readIn(dir);
    assert.equal(detached.branch, undefined);
    assert.match(detached.commit ?? "", /^[0-9a-f]{7,}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
