#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import showdown from "showdown";

// Showdown's stock `unhashHTMLSpans` aborts placeholder resolution after just
// 10 levels of nested spans, printing "maximum nesting of 10 spans reached!!!"
// and leaving raw `¨CNNC` markers in the output. Dense inline code (e.g. a
// paragraph with 30+ backticked words) easily exceeds that limit. Reinstall
// the sub-parser with a much higher safety bound so deep but finite nesting
// resolves cleanly.
showdown.subParser("unhashHTMLSpans", function (text, options, globals) {
  text = globals.converter._dispatch(
    "unhashHTMLSpans.before",
    text,
    options,
    globals,
  );
  const HARD_LIMIT = 10000;
  for (let i = 0; i < globals.gHtmlSpans.length; ++i) {
    let repText = globals.gHtmlSpans[i];
    let depth = 0;
    while (/¨C(\d+)C/.test(repText)) {
      if (depth >= HARD_LIMIT) {
        console.error(
          `[build-html] showdown span unhash exceeded hard limit ${HARD_LIMIT}`,
        );
        break;
      }
      const num = RegExp.$1;
      repText = repText.replace("¨C" + num + "C", globals.gHtmlSpans[num]);
      depth++;
    }
    text = text.replace("¨C" + i + "C", repText);
  }
  text = globals.converter._dispatch(
    "unhashHTMLSpans.after",
    text,
    options,
    globals,
  );
  return text;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CHAPTER_RE = /^(\d+)\.\s.+\.md$/;
const README = "README.md";
const OUTPUT_HTML = "index.html";
const TITLE = "Робот и мальчик: разговоры о программировании";

const NAV_PREV_START = "<!-- nav:prev:start -->";
const NAV_PREV_END = "<!-- nav:prev:end -->";
const NAV_NEXT_START = "<!-- nav:next:start -->";
const NAV_NEXT_END = "<!-- nav:next:end -->";
const TOC_START = "<!-- toc:start -->";
const TOC_END = "<!-- toc:end -->";
// Content wrapped in these markers lives only in README.md (e.g. a link to the
// online version of the book) and is stripped from the generated index.html.
const README_ONLY_START = "<!-- readme-only:start -->";
const README_ONLY_END = "<!-- readme-only:end -->";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripBlock(text, startMarker, endMarker) {
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${escapeRe(startMarker)}[\\s\\S]*?${escapeRe(endMarker)}\\s*(?:\\n|$)`,
    "g",
  );
  return text.replace(pattern, (_m, offset) => (offset === 0 ? "" : "\n"));
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
      number: m[1],
      anchor: `chapter-${m[1]}`,
      title: entry.name.replace(/\.md$/i, ""),
    });
  }
  chapters.sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));
  return chapters;
}

function readChapter(filename) {
  const text = readFileSync(join(ROOT, filename), "utf8");
  let body = stripBlock(text, NAV_PREV_START, NAV_PREV_END);
  body = stripBlock(body, NAV_NEXT_START, NAV_NEXT_END);
  return body.trim();
}

function readReadme() {
  const text = readFileSync(join(ROOT, README), "utf8");
  let body = stripBlock(text, TOC_START, TOC_END);
  body = stripBlock(body, README_ONLY_START, README_ONLY_END);
  return body.trim();
}

function buildTocHtml(chapters) {
  const items = chapters
    .map(
      (ch) =>
        `      <li><a href="#${ch.anchor}">${escapeHtml(ch.title)}</a></li>`,
    )
    .join("\n");
  return `<nav class="toc" id="toc">
  <h2>Оглавление</h2>
  <ul>
${items}
  </ul>
</nav>`;
}

function makeConverter() {
  return new showdown.Converter({
    tables: true,
    strikethrough: true,
    tasklists: true,
    ghCodeBlocks: true,
    simpleLineBreaks: false,
    ghCompatibleHeaderId: true,
    openLinksInNewWindow: false,
    emoji: false,
    smartIndentationFix: true,
  });
}

// Showdown 2.x doesn't list <details>/<summary> in its block-level HTML tags,
// so it wraps them in <p>, hashes their inline content into spans and trips the
// "maximum nesting of 10 spans reached" warning. We pre-render every
// <details>...</details> block with its own sub-converter and replace it with
// a placeholder that the main pass will pass through untouched.
const DETAILS_RE = /<details\b([^>]*)>([\s\S]*?)<\/details>/gi;
const SUMMARY_RE = /^\s*<summary\b([^>]*)>([\s\S]*?)<\/summary>\s*/i;
// SOH-delimited token of only letters/digits — avoids any markdown-active
// characters (e.g. underscores, which showdown would turn into <em>).
const PLACEHOLDER_PREFIX = "\u0001DETAILSBLOCK";
const PLACEHOLDER_SUFFIX = "\u0001";

function stripParagraphWrap(html) {
  const trimmed = html.trim();
  const m = trimmed.match(/^<p>([\s\S]*)<\/p>$/);
  return m && !/<\/p>\s*<p>/.test(m[1]) ? m[1] : trimmed;
}

function renderMarkdown(md, converter) {
  const blocks = [];
  const preprocessed = md.replace(DETAILS_RE, (_match, attrs, body) => {
    let summary = "";
    const rest = body.replace(SUMMARY_RE, (_m, sattrs, scontent) => {
      const inner = stripParagraphWrap(converter.makeHtml(scontent.trim()));
      summary = `<summary${sattrs}>${inner}</summary>\n`;
      return "";
    });
    const bodyHtml = converter.makeHtml(rest.trim());
    const blockHtml = `<details${attrs}>\n${summary}${bodyHtml}\n</details>`;
    const id = blocks.push(blockHtml) - 1;
    return `\n\n${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}\n\n`;
  });

  let html = converter.makeHtml(preprocessed);

  const placeholderRe = new RegExp(
    `(?:<p>\\s*)?${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}(?:\\s*</p>)?`,
    "g",
  );
  return html.replace(placeholderRe, (_m, id) => blocks[Number(id)]);
}

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1f1f1f;
    background: #fafafa;
    font-size: 17px;
  }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 24px 80px;
    background: #fff;
  }
  h1, h2, h3, h4 { color: #111; line-height: 1.25; }
  h1 { font-size: 1.95em; margin: 1.1em 0 0.6em; }
  h2 { font-size: 1.45em; margin: 1.6em 0 0.5em; }
  h3 { font-size: 1.2em; margin: 1.3em 0 0.4em; }
  p { margin: 0.6em 0; }
  hr { border: 0; border-top: 1px solid #e4e4e4; margin: 2em 0; }
  code {
    font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    background: #f2f2f2;
    padding: 0.08em 0.32em;
    border-radius: 3px;
    font-size: 0.9em;
  }
  pre {
    background: #f5f5f5;
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.45;
  }
  pre code { background: transparent; padding: 0; font-size: 0.88em; }
  blockquote {
    border-left: 3px solid #ddd;
    margin: 0.6em 0;
    padding: 0.1em 0 0.1em 14px;
    color: #555;
  }
  a { color: #1a4fbf; text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; }

  nav.toc {
    background: #f6f8fa;
    border: 1px solid #e4e4e4;
    border-radius: 8px;
    padding: 18px 24px;
    margin: 2.2em 0;
  }
  nav.toc h2 { margin: 0 0 0.5em; font-size: 1.25em; }
  nav.toc ol { margin: 0; padding-left: 1.5em; }
  nav.toc li { margin: 0.3em 0; }

  section.chapter { scroll-margin-top: 16px; }
  section.chapter + section.chapter,
  nav.toc + section.chapter {
    padding-top: 2em;
    border-top: 1px solid #eee;
    margin-top: 2em;
  }
  .back-to-toc {
    display: inline-block;
    margin-top: 2em;
    font-size: 0.9em;
    color: #666;
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1b1b1b; color: #e8e8e8; }
    main { background: #181818; }
    h1, h2, h3, h4 { color: #f5f5f5; }
    code { background: #2b2b2b; }
    pre { background: #232323; }
    blockquote { border-left-color: #444; color: #bbb; }
    a { color: #7ab2ff; }
    nav.toc { background: #1f2025; border-color: #2b2b30; }
    section.chapter + section.chapter,
    nav.toc + section.chapter { border-top-color: #2b2b30; }
    hr { border-top-color: #2b2b30; }
    th, td { border-color: #2b2b30; }
    .back-to-toc { color: #999; }
  }
`;

const READER_JS = readFileSync(
  join(__dirname, "reader-position.js"),
  "utf8",
);

function main() {
  const chapters = findChapters();
  if (chapters.length === 0 && !existsSync(join(ROOT, README))) {
    console.log("[build-html] no source files found, skipping");
    return;
  }

  const converter = makeConverter();

  const readmeHtml = existsSync(join(ROOT, README))
    ? renderMarkdown(readReadme(), converter)
    : "";

  const tocHtml = buildTocHtml(chapters);

  const chaptersHtml = chapters
    .map((ch) => {
      const body = renderMarkdown(readChapter(ch.filename), converter);
      return `<section class="chapter" id="${ch.anchor}">
${body}
<a class="back-to-toc" href="#toc">↑ К оглавлению</a>
</section>`;
    })
    .join("\n\n");

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(TITLE)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${readmeHtml}

${tocHtml}

${chaptersHtml}
</main>
<script>${READER_JS}</script>
</body>
</html>
`;

  writeFileSync(join(ROOT, OUTPUT_HTML), html, "utf8");
  console.log(`[build-html] generated ${OUTPUT_HTML}`);

  try {
    execFileSync("git", ["add", "--", OUTPUT_HTML], { cwd: ROOT, stdio: "inherit" });
  } catch (err) {
    console.error("[build-html] git add failed:", err.message);
    process.exit(1);
  }
}

main();
