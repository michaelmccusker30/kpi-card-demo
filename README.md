# KPI Card — demo builds

The three staged builds from dry run 4, packaged so either can drive the SF TUG
talk: **served locally** or **hosted on Vercel**. Same files either way — the
only difference is which `.trex` you load.

Source of truth for these builds is
`idea-to-extension-demo/dry-run-results/Dry Run 4/`. That folder stays
untouched; this one is the production copy.

```
kpi-card-demo/
├── stage1/  stage2/  stage3/     the three builds (relative paths, so they
│                                 work under any origin unchanged)
├── server.js                     one HTTPS server for all three, port 3001
├── vercel.json                   static deploy + iframe headers
├── set-hosted-url.sh             stamps the real Vercel URL into the manifests
└── trex/
    ├── local/   kpi-card-stage{1,2,3}.trex          → localhost:3001
    └── hosted/  kpi-card-stage{1,2,3}.hosted.trex   → Vercel
```

Each stage has its own extension id (`…kpi-card.stage1`, `.stage2`, `.stage3`),
so Tableau treats them as three separate extensions and they can sit on three
sheets at once.

---

## Local

One server, one port, all three stages:

```bash
cd kpi-card-demo
mkcert localhost        # once — creates localhost.pem + localhost-key.pem here
node server.js          # leave it running
```

Then load `trex/local/kpi-card-stage1.trex` (and 2, 3) in Tableau.

That's the change from the old three-port scheme: because the stages are
folders rather than separate projects, one server covers all of them. No
`demo-servers.sh`, no port juggling, nothing to start per stage.

## Hosted

1. Push this folder to its own GitHub repo.
2. vercel.com → **Add New → Project** → import it. `vercel.json` handles the
   config; no build settings to change.
3. Deploy. Note the URL it gives you.
4. Stamp that URL into the hosted manifests:

   ```bash
   bash set-hosted-url.sh https://your-project.vercel.app
   ```

5. Check each stage loads in a browser:
   `https://your-project.vercel.app/stage1/index.html`
6. Load `trex/hosted/kpi-card-stage{1,2,3}.hosted.trex` in Tableau.

Pushing to main redeploys automatically. For **Tableau Cloud**, a site admin
must add the Vercel URL under Settings → Extensions first.

---

## On the day

Keep **two copies of the demo workbook** — one with the sheets wired to the
local manifests, one to the hosted. Extensions can't be re-pointed mid-talk
without a remove-and-re-add, so the choice is made by opening the right
workbook. Decide ~15 minutes out:

- **Local** unless there's a reason not to — no network dependency at the
  moment Tableau loads the page.
- **Hosted** if you'd rather not run anything, or you're presenting from a
  machine without the certs.

Either way, open each stage once before going live so it's warm.

## Handout

The hosted `.trex` files are worth including in the post-session download —
attendees can load the finished card in their own Tableau without building
anything. Stage 3 is the one to give them; stages 1 and 2 are demo scaffolding.
