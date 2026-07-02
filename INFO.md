# Puzzleworks

A puzzle website where **every day, a brand-new browser puzzle is invented, coded, validated, and published entirely by an LLM** — with $0/month hosting.

- **Hosting:** GitHub Pages (free, static)
- **Scheduler:** GitHub Actions cron (free for public repos)
- **Puzzle generation:** Claude API (optional, ~pennies/day) or GitHub Models (free fallback)
- **Database:** none — a `manifest.json` file and the git history

The repo ships with one seed puzzle (DELTA) so the site works from day one.

## How it works

Once a day, `.github/workflows/daily.yml` runs `scripts/daily.mjs`, which:

1. Reads every previous puzzle's title + summary from the manifest and includes them in the prompt, so the model invents a mechanic that isn't a clone of anything already published.
2. Asks the LLM for one complete, self-contained HTML puzzle (rules include: solvability by construction, mobile support, a metadata comment, no external requests).
3. Validates it: static checks (well-formed, has metadata, no external URLs) and a headless-Chromium smoke test (loads without console errors, renders content, has interactive elements).
4. On success, writes `puzzles/YYYY-MM-DD.html`, prepends an entry to `manifest.json`, and commits. GitHub Pages redeploys automatically.
5. On failure, retries up to 3 times; if all fail, it publishes **nothing** — yesterday's puzzle stays on top and visitors never see a broken page.

`index.html` fetches `manifest.json` in the browser and renders today's puzzle as a featured card with the archive below.

## Setup (about 5 minutes)

1. **Create a public GitHub repo** and push these files to the `main` branch.
2. **Enable Pages:** repo → Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. Your site goes live at `https://<user>.github.io/<repo>/`.
3. **(Optional, recommended) Add a Claude API key** for noticeably better puzzles: repo → Settings → Secrets and variables → Actions → New repository secret → name `ANTHROPIC_API_KEY`. Get a key at https://platform.claude.com. Without this secret, the script automatically uses GitHub Models for free.
4. **Test it:** repo → Actions → *Daily puzzle* → Run workflow. Watch the log; a new file should appear in `puzzles/` and the site updates a minute later.

That's it — the cron takes over from there (05:17 UTC daily; edit the schedule in `daily.yml`).

## Customizing

- **Model:** set the `PUZZLE_MODEL` env var in `daily.yml` (e.g. `claude-sonnet-4-6`, or a GitHub Models id like `openai/gpt-4o`).
- **Variety:** each puzzle stores a `summary` of its mechanic in `manifest.json`; all previous summaries are fed back into the prompt so new puzzles stay distinct.
- **Prompt/quality bar:** the whole design brief lives in the `PROMPT` constant in `scripts/daily.mjs`.
- **Site name/branding:** edit `index.html`.
- **Stricter validation:** `browserCheck()` is the place to add assertions (e.g. simulate a full playthrough, enforce a size budget).

## Notes & gotchas

- The scheduled run only starts after the workflow file exists on the default branch; GitHub may delay cron jobs by a few minutes, and pauses schedules on repos with ~60 days of no activity (the daily commits themselves keep it active).
- GitHub Models is rate-limited on the free tier — one call/day is far below the limits, but retries during a bad day are also counted.
- Puzzles are published unreviewed by design. Skim the day's puzzle occasionally; if one is bad, delete its file + manifest entry and re-run the workflow manually.
- Everything a puzzle needs must be inline in its HTML file — the validator rejects external URLs, which also keeps puzzles working forever with no dependencies.
