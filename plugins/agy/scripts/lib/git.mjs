import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const UNTRACKED_SNAPSHOT_BYTES = 24 * 1024;
const MAX_INLINE_DIFF_FILES = 2;
const MAX_INLINE_DIFF_BYTES = 256 * 1024;
const PROMPT_SCOPES = new Set(["prompt", "decision", "plan", "topic", "brief"]);

export function runGit(cwd, args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  if (result.error) {
    if (allowFailure) {
      return { status: 1, stdout: "", stderr: result.error.message };
    }
    throw result.error;
  }

  if (result.status !== 0 && !allowFailure) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `git ${args.join(" ")} failed with status ${result.status}`);
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function resolveGitRoot(cwd) {
  const res = runGit(cwd, ["rev-parse", "--show-toplevel"], true);
  return res.status === 0 ? res.stdout.trim() : null;
}

function getCurrentBranch(cwd) {
  const res = runGit(cwd, ["branch", "--show-current"], true);
  return res.stdout.trim() || "HEAD";
}

function splitNonEmptyLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasWorkingTreeChanges(cwd) {
  return Boolean(runGit(cwd, ["status", "--porcelain", "--untracked-files=normal"], true).stdout.trim());
}

export function detectDefaultBranch(cwd) {
  const symbolic = runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], true);
  if (symbolic.status === 0) {
    const ref = symbolic.stdout.trim();
    if (ref) {
      return ref.replace(/^refs\/remotes\//, "");
    }
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master", "trunk"]) {
    if (runGit(cwd, ["rev-parse", "--verify", "--quiet", candidate], true).status === 0) {
      return candidate;
    }
  }

  return null;
}

function buildPromptReviewContext(workingDir, focusText) {
  if (!focusText) {
    throw new Error(
      "Nothing to review: provide a decision/topic brief (or --prompt-file <path>), modify the working tree, or pass --base <ref>."
    );
  }
  return {
    repoRoot: resolveGitRoot(workingDir) || workingDir,
    mode: "prompt",
    baseRef: null,
    label: "architecture / policy / design decision review",
    summary: `Working directory: ${workingDir}`,
    collectionMode: "prompt-brief",
    sections: [`## Proposal / Decision Under Review\n${focusText}`],
  };
}

function readUntrackedPreview(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    return null;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (buffer.subarray(0, 1024).includes(0)) {
    return `Untracked binary file: ${relativePath} (${stat.size} bytes)`;
  }

  const clipped = buffer.subarray(0, UNTRACKED_SNAPSHOT_BYTES).toString("utf8");
  const truncated = buffer.length > UNTRACKED_SNAPSHOT_BYTES ? "\n... [truncated]" : "";
  return `Untracked file: ${relativePath}\n\`\`\`\n${clipped}${truncated}\n\`\`\``;
}

function fenced(title, body, lang = "") {
  return body ? `## ${title}\n\`\`\`${lang}\n${body}\n\`\`\`` : null;
}

const SELF_COLLECT_NOTE =
  "## Diff collection mode\nFull patches were intentionally omitted to keep the review prompt compact. Inspect the changed files and git diffs directly from the repository.";

function collectWorkingTreeContext(repoRoot) {
  const statusShort = runGit(repoRoot, ["status", "--short", "--branch"]).stdout.trim();
  const stagedDiff = runGit(repoRoot, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout.trim();
  const unstagedDiff = runGit(repoRoot, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout.trim();
  const stagedStat = runGit(repoRoot, ["diff", "--cached", "--stat"]).stdout.trim();
  const unstagedStat = runGit(repoRoot, ["diff", "--stat"]).stdout.trim();
  const stagedFiles = splitNonEmptyLines(runGit(repoRoot, ["diff", "--cached", "--name-status"]).stdout);
  const unstagedFiles = splitNonEmptyLines(runGit(repoRoot, ["diff", "--name-status"]).stdout);
  const untrackedFiles = splitNonEmptyLines(runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]).stdout);

  const untrackedPreviews = untrackedFiles
    .slice(0, 15)
    .map((file) => readUntrackedPreview(repoRoot, file))
    .filter(Boolean);

  if (!stagedDiff && !unstagedDiff && untrackedPreviews.length === 0) {
    throw new Error("Nothing to review in the working tree. Make changes, pass --base <ref>, or pass a decision brief with --scope decision.");
  }

  const changedFileSet = new Set([
    ...stagedFiles.map((line) => line.split(/\s+/).slice(1).join(" ").trim()).filter(Boolean),
    ...unstagedFiles.map((line) => line.split(/\s+/).slice(1).join(" ").trim()).filter(Boolean),
    ...untrackedFiles,
  ]);
  const totalDiffBytes =
    Buffer.byteLength(stagedDiff, "utf8") +
    Buffer.byteLength(unstagedDiff, "utf8") +
    untrackedPreviews.reduce((total, preview) => total + Buffer.byteLength(preview, "utf8"), 0);
  const includeInlineDiff = changedFileSet.size <= MAX_INLINE_DIFF_FILES && totalDiffBytes <= MAX_INLINE_DIFF_BYTES;

  const header = [
    fenced("Staged diff stat", stagedStat),
    fenced("Unstaged diff stat", unstagedStat),
    fenced("Staged files", stagedFiles.join("\n")),
    fenced("Unstaged files", unstagedFiles.join("\n")),
  ];

  return {
    summary: statusShort,
    collectionMode: includeInlineDiff ? "inline-diff" : "self-collect",
    fileCount: changedFileSet.size,
    sections: (includeInlineDiff
      ? [
          ...header,
          fenced("Staged diff", stagedDiff, "diff"),
          fenced("Unstaged diff", unstagedDiff, "diff"),
          untrackedPreviews.length > 0 ? `## Untracked files\n${untrackedPreviews.join("\n\n")}` : null,
        ]
      : [...header, fenced("Untracked files", untrackedFiles.slice(0, 100).join("\n")), SELF_COLLECT_NOTE]
    ).filter(Boolean),
  };
}

function collectBranchContext(repoRoot, baseRef) {
  const mergeBase = runGit(repoRoot, ["merge-base", baseRef, "HEAD"]).stdout.trim();
  const range = `${mergeBase}...HEAD`;
  const statusShort = runGit(repoRoot, ["status", "--short", "--branch"]).stdout.trim();
  const commitLog = runGit(repoRoot, ["log", "--oneline", "--decorate", `${mergeBase}..HEAD`]).stdout.trim();
  const diffStat = runGit(repoRoot, ["diff", "--stat", range]).stdout.trim();
  const changedFiles = splitNonEmptyLines(runGit(repoRoot, ["diff", "--name-status", range]).stdout);
  const diff = runGit(repoRoot, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", range]).stdout.trim();

  if (!diff) {
    throw new Error(`No committed diff found between ${baseRef} and HEAD.`);
  }

  const includeInlineDiff =
    changedFiles.length <= MAX_INLINE_DIFF_FILES && Buffer.byteLength(diff, "utf8") <= MAX_INLINE_DIFF_BYTES;

  const header = [
    fenced(`Commits (${mergeBase}..HEAD)`, commitLog),
    fenced(`Diff stat (${range})`, diffStat),
    fenced(`Changed files (${range})`, changedFiles.join("\n")),
  ];

  return {
    summary: statusShort,
    collectionMode: includeInlineDiff ? "inline-diff" : "self-collect",
    fileCount: changedFiles.length,
    sections: (includeInlineDiff
      ? [...header, fenced(`Diff (${range})`, diff, "diff")]
      : [
          ...header,
          `## Diff collection mode\nFull patches were intentionally omitted to keep the review prompt compact. Run git commands against ${range} and inspect the touched files directly.`,
        ]
    ).filter(Boolean),
  };
}

export function collectReviewContext(cwd, { base, scope = "auto", focusText = "", hasPromptFile = false } = {}) {
  const normalizedScope = PROMPT_SCOPES.has(scope) ? "prompt" : scope;
  if (!["auto", "working-tree", "branch", "prompt"].includes(normalizedScope)) {
    throw new Error(`Invalid --scope "${scope}". Expected auto, working-tree, branch, or decision.`);
  }

  if (normalizedScope === "prompt" || (hasPromptFile && !base && scope === "auto")) {
    return buildPromptReviewContext(cwd, focusText);
  }

  if (base && normalizedScope === "working-tree") {
    throw new Error("--base cannot be combined with --scope working-tree.");
  }

  const repoRoot = resolveGitRoot(cwd);
  if (!repoRoot) {
    if (normalizedScope === "auto" && focusText) {
      return buildPromptReviewContext(cwd, focusText);
    }
    throw new Error("Current directory is not a Git repository. Pass --scope decision with a review brief.");
  }

  if (base) {
    return { repoRoot, mode: "branch", baseRef: base, label: `changes since ${base}`, ...collectBranchContext(repoRoot, base) };
  }

  if (normalizedScope === "working-tree" || (normalizedScope === "auto" && hasWorkingTreeChanges(repoRoot))) {
    return {
      repoRoot,
      mode: "working-tree",
      baseRef: null,
      label: "working tree diff (staged, unstaged, and untracked changes)",
      ...collectWorkingTreeContext(repoRoot),
    };
  }

  const detectedBase = detectDefaultBranch(repoRoot);
  if (detectedBase) {
    try {
      return {
        repoRoot,
        mode: "branch",
        baseRef: detectedBase,
        label: `branch ${getCurrentBranch(repoRoot)} compared against ${detectedBase}`,
        ...collectBranchContext(repoRoot, detectedBase),
      };
    } catch (err) {
      if (normalizedScope === "auto" && focusText) {
        return buildPromptReviewContext(cwd, focusText);
      }
      throw err;
    }
  }

  if (normalizedScope === "auto" && focusText) {
    return buildPromptReviewContext(cwd, focusText);
  }

  throw new Error("Could not determine a git diff for review. Modify the working tree, pass --base <ref>, or pass a decision brief with --scope decision.");
}

export function buildReviewCollectionGuidance(context) {
  if (context.collectionMode === "prompt-brief") {
    return [
      "- You are reviewing an architectural, operational, retention, or design proposal/decision.",
      "- Inspect any referenced files, configs, or scripts in the workspace if needed to verify claims and constraints.",
      "- Stress-test assumptions, failure windows, operational blast radius, cost vs reliability trade-offs, and edge cases.",
    ].join("\n");
  }

  if (context.collectionMode === "inline-diff") {
    return [
      "- The full diff is included below because the change set is small.",
      "- Read touched files and immediate callers when needed to verify invariants, contracts, and edge cases.",
      "- Stay focused on the target change and its direct blast radius.",
    ].join("\n");
  }

  return [
    "- Full patches were omitted because the change set exceeded the inline threshold.",
    "- Start from the git status, diff stat, and changed file list below.",
    "- Inspect the relevant git diffs and touched files directly before making findings.",
    "- Keep context gathering bounded to the changed files and their direct callers/tests.",
  ].join("\n");
}

export function buildReviewInputSection(context) {
  if (context.collectionMode === "prompt-brief") {
    return ["<review_input>", ...context.sections, "</review_input>"].join("\n");
  }

  return [
    "<review_input>",
    "## Git status",
    "```",
    context.summary || "(empty)",
    "```",
    "",
    ...context.sections,
    "</review_input>",
  ].join("\n");
}
