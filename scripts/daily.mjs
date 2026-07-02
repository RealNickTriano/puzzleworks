/**
 * daily.mjs — generates today's puzzle, validates it, and updates the manifest.
 *
 * Run by GitHub Actions once a day (see .github/workflows/daily.yml).
 * Provider selection:
 *   - If ANTHROPIC_API_KEY is set  -> Claude API (best quality, ~pennies/day)
 *   - Else if GITHUB_TOKEN is set  -> GitHub Models (free tier)
 *
 * Exits non-zero only on unexpected errors. If every generation attempt fails
 * validation, it exits 0 WITHOUT writing anything, so yesterday's puzzle
 * simply remains the newest one and the site never shows a broken page.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const MAX_ATTEMPTS = 3;
const PUZZLES_DIR = "puzzles";
const MANIFEST = "manifest.json";

// ---------- date ----------
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const outFile = `${PUZZLES_DIR}/${today}.html`;

// ---------- previous puzzles (avoid clones) ----------
function loadManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")); }
  catch { return { site: "OnlyPuzzles", puzzles: [] }; }
}
const manifest = loadManifest();
const previousPuzzles = manifest.puzzles
  .map(p => `- ${p.title}: ${p.summary || p.tagline || "(no description)"}`)
  .join("\n") || "(none yet — this is the first puzzle)";

// ---------- the generation prompt ----------
const PROMPT = `You are designing today's puzzle for a daily puzzle website (like an NYT game). Output a COMPLETE, self-contained HTML file and NOTHING else — no markdown fences, no commentary.

Design brief:
- Invent an ORIGINAL browser puzzle: pick the core mechanic and the visual theme yourself.
- Do NOT clone Wordle, Sudoku, 2048, crosswords, or Minesweeper.
- Every puzzle previously published on this site is listed below. Your puzzle must be mechanically distinct from ALL of them — not just a re-theme or minor variation. Before writing code, decide on a mechanic that none of these use:
${previousPuzzles}
- Low skill floor, high skill ceiling: the core rule must fit in one or two sentences, but a perfect/optimal solve should be genuinely hard.
- CRITICAL — guaranteed solvability: generate the puzzle by first constructing a valid SOLUTION with code, then deriving the visible puzzle from it (never generate a random board and hope it's solvable).
- Deterministic daily seed: seed the RNG from today's date so every visitor gets the same puzzle.

Hard technical requirements:
- ONE html file, inline CSS + JS only. Zero external requests (no CDNs, fonts, images, analytics).
- Works with mouse AND touch (pointer events); responsive down to a 360px-wide phone; no page scrolling needed during play.
- Include: a title, a one-line tagline, a "How to play" modal shown on first visit, a win state with a shareable emoji/text result copied to clipboard, and a reset/clear control.
- localStorage may be used for best scores/streaks (guard with try/catch).
- No console errors. No infinite loops. Keep total file under 40KB.
- Accessible basics: buttons are real <button> elements, visible keyboard focus, prefers-reduced-motion respected.
- Near the top of the file include exactly one metadata comment on its own line:
  <!-- PUZZLE-META {"title":"NAME","tagline":"one sentence hook","difficulty":"easy|medium|hard","summary":"2-3 sentences describing the core mechanic and goal, written so a future designer can tell at a glance whether a new idea would be a clone of this one"} -->

Quality bar: clean modern aesthetic, a distinctive palette (not default grays), satisfying micro-feedback on moves. Playtest mentally: walk through a full solve step by step before writing the final code, and make the win condition actually reachable.`;

// ---------- LLM providers ----------
async function callAnthropic(prompt) {
  const model = process.env.PUZZLE_MODEL || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.content.map(b => b.text || "").join(""), model };
}

async function callGitHubModels(prompt) {
  const model = process.env.PUZZLE_MODEL || "openai/gpt-4o";
  const res = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.choices[0].message.content, model };
}

async function generate(prompt) {
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(prompt);
  if (process.env.GITHUB_TOKEN) return callGitHubModels(prompt);
  throw new Error("No credentials: set ANTHROPIC_API_KEY or run inside GitHub Actions.");
}

// ---------- extraction + static checks ----------
function extractHtml(text) {
  // tolerate models that wrap output in fences despite instructions
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/);
  let html = (fence ? fence[1] : text).trim();
  const start = html.search(/<!DOCTYPE html>/i);
  if (start > 0) html = html.slice(start);
  return html;
}

function staticChecks(html) {
  const errors = [];
  if (!/^<!DOCTYPE html>/i.test(html)) errors.push("missing <!DOCTYPE html> at start");
  if (!/<\/html>\s*$/i.test(html)) errors.push("file appears truncated (no closing </html>)");
  if (html.length > 120_000) errors.push("file too large");
  const meta = html.match(/<!--\s*PUZZLE-META\s*(\{[\s\S]*?\})\s*-->/);
  if (!meta) { errors.push("missing PUZZLE-META comment"); return { errors }; }
  let metaJson;
  try { metaJson = JSON.parse(meta[1]); } catch { errors.push("PUZZLE-META is not valid JSON"); }
  if (metaJson && !metaJson.title) errors.push("PUZZLE-META missing title");
  if (metaJson && !metaJson.summary) errors.push("PUZZLE-META missing summary");
  if (/\bsrc\s*=\s*["']https?:|@import\s+url\(["']?https?:|fetch\(\s*["']https?:/i.test(html))
    errors.push("references an external URL (must be fully self-contained)");
  return { errors, meta: metaJson };
}

// ---------- headless browser validation ----------
async function browserCheck(html) {
  const { chromium } = await import("playwright");
  const tmp = `/tmp/puzzle-${Date.now()}.html`;
  writeFileSync(tmp, html);
  const browser = await chromium.launch();
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.on("pageerror", e => problems.push(`pageerror: ${e.message}`));
    page.on("console", m => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
    await page.goto(`file://${tmp}`, { waitUntil: "load", timeout: 15000 });
    await page.waitForTimeout(2500); // let init code + timers run
    const visibleText = await page.evaluate(() => document.body.innerText.trim().length);
    if (visibleText < 20) problems.push("page renders almost no visible content");
    const interactive = await page.evaluate(() =>
      document.querySelectorAll("button, [onclick], canvas, [tabindex]").length);
    if (interactive === 0) problems.push("no interactive elements found");
    // poke it: click roughly mid-board and make sure nothing explodes
    await page.mouse.click(195, 400).catch(() => {});
    await page.waitForTimeout(800);
  } catch (e) {
    problems.push(`load failed: ${e.message}`);
  } finally {
    await browser.close();
  }
  return problems;
}

// ---------- main ----------
if (existsSync(outFile)) {
  console.log(`Puzzle for ${today} already exists — nothing to do.`);
  process.exit(0);
}
mkdirSync(PUZZLES_DIR, { recursive: true });

let published = false;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !published; attempt++) {
  console.log(`\n=== Attempt ${attempt}/${MAX_ATTEMPTS} ===`);
  try {
    const { text, model } = await generate(PROMPT);
    const html = extractHtml(text);
    const { errors, meta } = staticChecks(html);
    if (errors.length) { console.log("Static checks failed:", errors); continue; }

    const problems = await browserCheck(html);
    if (problems.length) { console.log("Browser checks failed:", problems); continue; }

    writeFileSync(outFile, html);
    manifest.puzzles.unshift({
      date: today,
      file: outFile,
      title: meta.title,
      tagline: meta.tagline || "",
      difficulty: meta.difficulty || "medium",
      summary: meta.summary,
      model,
    });
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`✔ Published "${meta.title}" -> ${outFile}`);
    published = true;
  } catch (e) {
    console.log("Attempt error:", e.message);
  }
}

if (!published) {
  console.log("\nAll attempts failed validation. Publishing nothing; yesterday's puzzle stays on top.");
}
