#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CHAPTER_RE = /^(\d+)\.\s.+\.md$/;
const README = "README.md";

const NAV_PREV_START = "<!-- nav:prev:start -->";
const NAV_PREV_END = "<!-- nav:prev:end -->";
const NAV_NEXT_START = "<!-- nav:next:start -->";
const NAV_NEXT_END = "<!-- nav:next:end -->";
const TOC_START = "<!-- toc:start -->";
const TOC_END = "<!-- toc:end -->";

function encodePath(name) {
  return encodeURI(name).replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function titleFromFilename(filename) {
  return filename.replace(/\.md$/i, "");
}

function findChapters() {
  const entries = readdirSync(ROOT, { withFileTypes: true });
  const chapters = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(CHAPTER_RE);
    if (!m) continue;
    chapters.push({
      filename: entry.name,
      number: parseInt(m[1], 10),
      title: titleFromFilename(entry.name),
    });
  }
  chapters.sort((a, b) => a.number - b.number);
  return chapters;
}

function stripBlock(text, startMarker, endMarker) {
  // Remove the block including any blank lines immediately surrounding it
  // so re-insertion doesn't accumulate blank lines.
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${escapeRe(startMarker)}[\\s\\S]*?${escapeRe(endMarker)}\\s*(?:\\n|$)`,
    "g",
  );
  return text.replace(pattern, (match, offset) => {
    // Preserve a single newline boundary where appropriate.
    if (offset === 0) return "";
    return "\n";
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPrevBlock(prev, isFirst) {
  let link;
  if (isFirst) {
    link = `[← Назад: README](README.md)`;
  } else if (prev) {
    link = `[← Предыдущая: ${prev.title}](${encodePath(prev.filename)})`;
  } else {
    return null;
  }
  return `${NAV_PREV_START}\n${link}\n${NAV_PREV_END}`;
}

function buildNextBlock(next) {
  if (!next) return null;
  const link = `[Следующая: ${next.title} →](${encodePath(next.filename)})`;
  return `${NAV_NEXT_START}\n${link}\n${NAV_NEXT_END}`;
}

function updateChapterFile(chapter, prev, next, isFirst) {
  const path = join(ROOT, chapter.filename);
  const original = readFileSync(path, "utf8");

  let body = original;
  body = stripBlock(body, NAV_PREV_START, NAV_PREV_END);
  body = stripBlock(body, NAV_NEXT_START, NAV_NEXT_END);
  body = body.replace(/^\s+/, "").replace(/\s+$/, "");

  const prevBlock = buildPrevBlock(prev, isFirst);
  const nextBlock = buildNextBlock(next);

  const parts = [];
  if (prevBlock) parts.push(prevBlock);
  parts.push(body);
  if (nextBlock) parts.push(nextBlock);

  const updated = parts.join("\n\n") + "\n";

  if (updated !== original) {
    writeFileSync(path, updated, "utf8");
    return true;
  }
  return false;
}

function buildTocBlock(chapters) {
  const lines = [TOC_START, "## Оглавление", ""];
  for (const ch of chapters) {
    lines.push(`- [${ch.title}](${encodePath(ch.filename)})`);
  }
  lines.push(TOC_END);
  return lines.join("\n");
}

function updateReadme(chapters) {
  const path = join(ROOT, README);
  if (!existsSync(path)) {
    console.error(`[update-toc] ${README} not found, skipping TOC update`);
    return false;
  }
  const original = readFileSync(path, "utf8");
  let stripped = stripBlock(original, TOC_START, TOC_END);
  stripped = stripped.replace(/\s+$/, "");

  const tocBlock = buildTocBlock(chapters);
  const updated = `${stripped}\n\n${tocBlock}\n`;

  if (updated !== original) {
    writeFileSync(path, updated, "utf8");
    return true;
  }
  return false;
}

function gitAdd(files) {
  if (files.length === 0) return;
  try {
    execFileSync("git", ["add", "--", ...files], { cwd: ROOT, stdio: "inherit" });
  } catch (err) {
    console.error("[update-toc] git add failed:", err.message);
  }
}

function main() {
  const chapters = findChapters();
  if (chapters.length === 0) {
    console.log("[update-toc] no chapter files found");
    return;
  }

  const modified = [];

  for (let i = 0; i < chapters.length; i++) {
    const prev = i > 0 ? chapters[i - 1] : null;
    const next = i < chapters.length - 1 ? chapters[i + 1] : null;
    const isFirst = i === 0;
    const changed = updateChapterFile(chapters[i], prev, next, isFirst);
    if (changed) modified.push(chapters[i].filename);
  }

  const readmeChanged = updateReadme(chapters);
  if (readmeChanged) modified.push(README);

  if (modified.length > 0) {
    console.log(`[update-toc] updated: ${modified.join(", ")}`);
    gitAdd(modified);
  } else {
    console.log("[update-toc] nothing to update");
  }
}

main();
