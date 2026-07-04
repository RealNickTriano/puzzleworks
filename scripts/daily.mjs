/**
 * daily.mjs — generates today's puzzle, validates it, and updates the manifest.
 *
 * Run by GitHub Actions once a day (see .github/workflows/daily.yml).
 * Provider selection:
 *   - If ANTHROPIC_API_KEY is set  -> Claude API (best quality, ~pennies/day)
 *   - Else if GITHUB_TOKEN is set  -> GitHub Models (free tier)
 *
 * If every generation attempt fails validation, it exits 1 WITHOUT writing
 * anything, so the workflow run fails visibly while yesterday's puzzle simply
 * remains the newest one and the site never shows a broken page.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const MAX_ATTEMPTS = 3;      // fresh generations (new conversation each time)
const MAX_FIX_ROUNDS = 2;    // repair rounds within one attempt before starting fresh
const PUZZLES_DIR = "puzzles";
const MANIFEST = "manifest.json";

// ---------- date ----------
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const outFile = `${PUZZLES_DIR}/${today}.html`;

// ---------- previous puzzles (avoid clones) ----------
function loadManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")); }
  catch { return { site: "Puzzleworks", puzzles: [] }; }
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
- Every puzzle previously published on this site is listed below. Your puzzle must be mechanically distinct from ALL of them — not just a re-theme or minor variation — and its visual design should be distinct too. Before writing code, decide on a mechanic that none of these use:
${previousPuzzles}
- Low skill floor, high skill ceiling: the core rule must fit in one or two sentences, but a perfect/optimal solve should be genuinely hard.
- CRITICAL — hand-author the puzzle instance: do NOT generate the board/level with a random number generator. Design ONE specific puzzle instance yourself (the board, the pieces, the target — whatever the mechanic needs) and hardcode it as data in the file, so every visitor gets the exact same puzzle. Randomness is only acceptable for cosmetic flourishes (particle effects, etc.), never for puzzle content.
- CRITICAL — guaranteed solvability: work out the full solution to your hand-authored instance BEFORE writing the code, then derive the visible starting state from that solution. Include the solution as a comment or data structure so the win-check logic can be verified against it.
- CRITICAL — real difficulty: today's instance must make a sharp adult think. Concretely: it must NOT be solvable by greedy/obvious first moves; it should require some combination of planning ahead, deduction across multiple constraints, or backtracking from dead ends; a typical solver should need several minutes and at least one wrong path before cracking it. If your drafted instance can be solved on autopilot, redesign the instance (add constraints, tighten the margin, deepen the required lookahead) before writing the final code. Err on the side of too hard rather than too easy — a puzzle that takes 15 minutes is a success, one that takes 60 seconds is a failure.

Hard technical requirements:
- ONE html file, inline CSS + JS only. Zero external requests (no CDNs, fonts, images, analytics).
- Works with mouse AND touch (pointer events); responsive down to a 360px-wide phone; no page scrolling needed during play.
- Include: a title, a one-line tagline, a "How to play" modal shown on first visit, a win state with a shareable emoji/text result copied to clipboard, and a reset/clear control.
- localStorage may be used for best scores/streaks (guard with try/catch).
- No console errors. No infinite loops. Keep total file under 40KB.
- Accessible basics: buttons are real <button> elements, visible keyboard focus, prefers-reduced-motion respected.
- Near the top of the file include exactly one metadata comment on its own line:
  <!-- PUZZLE-META {"title":"NAME","tagline":"one sentence hook","difficulty":"medium|hard","summary":"2-3 sentences describing the core mechanic and goal, plus a short note on the visual style, written so a future designer can tell at a glance whether a new idea would be a clone of this one"} -->

Visual identity — every puzzle gets its OWN design:
- Design this puzzle's look from scratch to fit ITS theme: choose your own palette, typography, background, and motion language. Commit to a strong art direction rather than a generic "clean app" look.
- Do NOT reuse the site's home-page aesthetic (deep pine-green wall, white tear-off calendar page, big red date numerals, monospaced metadata) — the puzzle should feel like its own little world, not a page of the home site.
- Avoid converging on the same look day after day: no default grays, and don't fall back on the overused purple-gradient-on-dark-card style.

Quality bar: satisfying micro-feedback on moves, and a cohesive look where every element (buttons, modal, win screen) belongs to the same art direction. Playtest mentally before writing the final code: walk through YOUR solution step by step to confirm the win condition is reachable, then walk through it as a naive player — if the naive walkthrough stumbles into the solution without ever getting stuck or having to think, the instance is too easy and you must redesign it first.`;

// ---------- LLM providers ----------
async function callAnthropic(messages) {
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
      max_tokens: 64000,
      stream: true, // non-streaming waits on the full generation, which blows past undici's 5-min headers timeout
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  let text = "";
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta")
        text += event.delta.text;
      if (event.type === "error")
        throw new Error(`Anthropic stream error: ${JSON.stringify(event.error)}`);
    }
  }
  return { text, model };
}

async function callGitHubModels(messages) {
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
      messages,
    }),
  });
  if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: data.choices[0].message.content, model };
}

async function generate(messages) {
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(messages);
  if (process.env.GITHUB_TOKEN) return callGitHubModels(messages);
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

async function validate(html) {
  const { errors, meta } = staticChecks(html);
  if (errors.length) return { problems: errors.map(e => `static check: ${e}`), meta };
  return { problems: await browserCheck(html), meta };
}

function fixRequest(problems) {
  return `The puzzle you produced failed automated validation with these problems:
${problems.map(p => `- ${p}`).join("\n")}

Fix these specific problems while keeping the puzzle's mechanic and design intact. Reply with the COMPLETE corrected HTML file and NOTHING else — no markdown fences, no commentary, no diff. The file must satisfy every requirement from the original brief.`;
}

let published = false;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !published; attempt++) {
  console.log(`\n=== Attempt ${attempt}/${MAX_ATTEMPTS} ===`);
  const messages = [{ role: "user", content: PROMPT }];
  try {
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      const { text, model } = await generate(messages);
      const html = extractHtml(text);
      const { problems, meta } = await validate(html);

      if (problems.length === 0) {
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
        break;
      }

      if (round < MAX_FIX_ROUNDS) {
        console.log(`Validation failed (fix round ${round + 1}/${MAX_FIX_ROUNDS}):`, problems);
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: fixRequest(problems) },
        );
      } else {
        console.log("Validation failed, out of fix rounds — regenerating from scratch:", problems);
      }
    }
  } catch (e) {
    console.log("Attempt error:", e.cause ? `${e.message} (cause: ${e.cause.message || e.cause})` : e.message);
  }
}

if (!published) {
  console.error("\nAll attempts failed validation. Publishing nothing; yesterday's puzzle stays on top.");
  process.exit(1);
}
