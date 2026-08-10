# Pacifica Rentals — Tableau Pulse Demo

A single-page operations portal: Pulse metrics up top, an AI-written safety narrative in the middle, and a one-click drill into the incidents driving it — all served from Tableau, no external LLM.

**Stack:** Node + Express · Tableau Connected App JWT · Pulse Insights API · VizQL Data Service · Tableau Embedding API v3

The Express server mints a JWT for the Tableau Connected App, calls Pulse Insights for the AI-generated narratives, and uses VizQL Data Service for row-level incident data. The AI summarization happens inside Tableau Pulse itself — there's no external LLM, no API keys, and no MCP proxy.

---

## What's in the code 

| File | Purpose |
| --- | --- |
| `server.js` | Express server. Mints the Tableau JWT, calls Pulse + VizQL DS REST, serves the UI. |
| `index.html` | Single-page UI for the brief. |
| `pulse-brief-utils.js` | Helpers used by the brief renderer. |
| `start.sh` | Boots the Express server on `:5500` and opens the browser. |
| `.env.example` | Required environment variables — copy to `.env` and fill in. |

---

## 1. Configure your `.env`

```bash
cp .env.example .env
```

> ⚠️ Heads up: `cp .env.example .env` will **overwrite** an existing `.env` without prompting. If you already have a `.env` with values you want to keep, skip this step (or back it up first with `cp .env .env.bak`).

Fill in every value. **Never commit this file** — it's already in `.gitignore`.

| Variable | Where it comes from |
| --- | --- |
| `TABLEAU_CLIENT_ID` | Tableau → Settings → **Connected Apps** → your app |
| `TABLEAU_SECRET_ID` | Same Connected App → secret pair |
| `TABLEAU_SECRET_VALUE` | Same Connected App → secret pair (shown once) |
| `TABLEAU_USER` | Email of the service account that owns the Connected App |
| `TABLEAU_SERVER` | Your Tableau Cloud URL, e.g. `https://10az.online.tableau.com` |
| `TABLEAU_SITE` | Site name from the Tableau URL |
| `TABLEAU_API` | API version, e.g. `3.28` |
| `SAFETY_METRIC_ID` | UUID of the safety metric in Tableau Pulse |
| `SAFETY_DATASOURCE_LUID` | LUID of the safety datasource (queried via VizQL Data Service) |

---

## 2. Run it

```bash
npm run start
```

The Express server starts on **http://localhost:5500**

---

## 3. How it fits together

```
Browser (index.html)
        │
        ▼
Express :5500
        │
        ▼
Tableau Cloud (JWT-authenticated)
  ├── Pulse Insights API     → AI-written narrative summaries
  └── VizQL Data Service API → row-level incident queries
```
---

## 4. Stop the server

When you are done, press `Ctrl+C` in the terminal — or just close the terminal window.

---

## 5. Security notes

- `.env`, `*.pem`, `*.key`, and `*.crt` are gitignored. **Do not commit secrets.**
- The Tableau Connected App secret gives wide access — rotate it if it ever lands in a commit, screenshot, or chat thread.
- The self-signed cert is for **local development only**. Don't reuse it for anything reachable from the internet.

---
## 6. Repo layout

```
pacifica-rentals/
├── architecture.html          # Static architecture diagram
├── index.html                 # Brief UI
├── pulse-brief-utils.js       # Brief renderer helpers
├── server.js                  # Express server, Tableau JWT, Pulse + VizQL DS REST
├── start.sh                   # Boots Express and opens the browser
├── Safety_Production_Mock_2.csv
├── .env.example               # Template — copy to .env
├── package.json
└── README.md
```
