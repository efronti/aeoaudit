# Business AEO Audit — Netlify version

A web app that grades any business website on how ready it is to be crawled, understood, and cited by AI search (ChatGPT, Claude, Perplexity, Google AI Overviews). Static frontend + a Netlify serverless Function that does the fetching/scoring — deploys to a real shareable Netlify URL.

## Why not drag-and-drop

This app needs to make a live web request to whatever site you're auditing every time you run it, so it needs a backend, not just static files. Netlify's plain drag-and-drop zone only publishes static assets — it can't run the audit function. Deploying with the Netlify CLI (below) takes one extra command and gives you the same shareable Netlify link you're used to.

## Deploy (one time setup, ~5 minutes)

```
cd aeo-audit-netlify
npm install
npm install -g netlify-cli   # skip if you already have it
netlify login
netlify deploy --prod
```

When prompted:
- "Create & configure a new site" (or link to an existing one)
- Publish directory: `public`
- Functions directory: `netlify/functions` (already set in `netlify.toml`, so it should auto-detect)

Netlify will print a live URL like `https://your-site-name.netlify.app` when it's done. That's your shareable audit tool.

## Using it

Open the URL, paste any business's website (e.g. `https://webuy616.com`), click "Run audit." Same scoring breakdown as before: score out of 100, letter grade, and category-by-category detail.

## Redeploying after changes

```
netlify deploy --prod
```

## What it checks (114 raw points, scaled to /100)

- **Fetchability & Crawler Access (43 pts)** — reachable without bot blocking, HTTPS, page size, robots.txt allowlist for ChatGPT-User/OAI-SearchBot/PerplexityBot/ClaudeBot/Google-Extended, server-side rendered content.
- **Core SEO (21 pts)** — title tag, meta description, canonical, OpenGraph, Twitter Card, `<html lang>`, sitemap.
- **Semantic HTML (13 pts)** — single `<h1>`, heading hierarchy, landmarks, image alt text.
- **Answer Engine Signals (31 pts)** — `/llms.txt`, `/llms-full.txt`, JSON-LD, author/org authority signals, freshness, content depth, readability extraction, NAP/contact info.
- **Content Quality (6 pts)** — front-loaded answers, question-shaped headings, concrete stats, quotations.

Grade: A 90+, B 80-89, C 70-79, D 60-69, F <60.

## Notes

- The only network calls the function makes are to the site being audited (homepage, robots.txt, sitemap, llms.txt) — no data is stored.
- This scoring rubric was reverse-engineered from a sample third-party report and is a close approximation, not a certified standard — treat scores as directionally useful.
- A local Python/Flask version of the same tool (no Netlify account needed, runs on `python app.py`) is available if you'd rather not deploy anywhere.
