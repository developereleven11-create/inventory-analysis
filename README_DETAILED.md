# Pokonut Predictive Inventory — Step-by-step (for non-developers)

This guide walks you through deploying the provided zip as a single Vercel project with Neon (Postgres) and GitHub Actions. Follow each step carefully. If you prefer, a developer can run these steps for you.

---

## PREP: What you'll need
1. A GitHub account.
2. A Vercel account (sign up at vercel.com).
3. A Neon account (sign up at neon.tech) — Postgres DB.
4. Your Shopify Admin access token (Admin API access).
5. Slack Incoming Webhook URL (optional but recommended).
6. A computer to unzip and upload files.

---

## STEP A — Unzip the file locally
1. Download the zip you received and save it to your computer.
2. Unzip it (double-click on macOS/Windows or use right-click -> Extract).

---

## STEP B — Create GitHub repo and upload the project
You can use GitHub web UI (no git required).

1. Go to https://github.com and log in.
2. Click **New repository**.
3. Name it `pokonut-inventory-mvp` (or any name).
4. Create repository (do NOT initialize README; you'll upload files).
5. On the repo page, click **"Add file" → "Upload files"**.
6. Drag the entire unzipped folder contents into the upload area (all files/folders).
7. Commit the changes at the bottom ("Commit changes").

Now your code is on GitHub.

---

## STEP C — Create Neon (Postgres) and run migrations
1. Go to https://neon.tech and create a new project (free tier is fine).
2. Once created, open the project and create a branch & compute endpoint (Neon UI will show a `connection string` like `postgresql://...`).
3. Copy the `connection string` — you'll need this in Vercel.
4. In Neon, open **SQL Editor** (left sidebar), paste the contents of `db/migrations/001_init.sql` (open the file from your unzipped folder), and **Run**. This creates the necessary tables.

---

## STEP D — Create Vercel project and set Environment Variables
1. Go to https://vercel.com and click **New Project → Import Git Repository**.
2. Select the GitHub repo you just uploaded.
3. When configuring the project, set:
   - Root Directory: (leave blank — repo root)
   - Framework: Next.js (should be detected)
4. Before deploying, set Environment Variables (Project Settings → Environment Variables):
   - `SHOPIFY_STORE` → yourstore.myshopify.com
   - `SHOPIFY_ADMIN_API_KEY` → (Admin access token)
   - `SHOPIFY_API_VERSION` → 2025-07
   - `DATABASE_URL` → (Neon connection string copied earlier)
   - `SLACK_WEBHOOK_URL` → (optional)
   - `ETL_SECRET` → (pick a strong secret, e.g., a random 20+ char string)
   - `NEXT_PUBLIC_ETL_SECRET` → (same as ETL_SECRET; allows demo Run ETL button)
5. Save variables and deploy. Vercel will build and publish your site.

---

## STEP E — Find your deployed URL and test
1. In Vercel dashboard, open the project and copy the Production URL (e.g., https://pokonut-inventory.vercel.app).
2. Visit `https://<your-url>` — you should see the dashboard (mock data).
3. Health check: Visit `https://<your-url>/api/run-etl?secret=<ETL_SECRET>` in a browser — it should return "ETL run completed..." and insert a sample metric into DB.
4. Optionally, test via curl:
   ```
   curl -H "x-etl-secret: <ETL_SECRET>" https://<your-url>/api/run-etl
   ```

---

## STEP F — Set GitHub Actions secrets (so scheduled ETL runs)
1. Go to your GitHub repo → Settings → Secrets and variables → Actions.
2. Add the following secrets:
   - `ETL_SECRET` = same as ETL_SECRET you set in Vercel.
   - `ETL_API_BASE_URL` = https://<your-vercel-url>  (no trailing slash)
3. The included GitHub Actions workflow (`.github/workflows/trigger-etl.yml`) will now run daily and call your ETL endpoint.

---

## STEP G — Verify Neon data & Slack
1. In Neon, use the SQL Editor to run:
   ```sql
   SELECT * FROM metrics_daily ORDER BY date DESC LIMIT 20;
   ```
   You should see the sample metric row inserted by ETL.
2. If you set SLACK_WEBHOOK_URL, check the configured Slack channel — you should see a confirmation message from the ETL run.

---

## Troubleshooting (common issues)
- **Blank dashboard / build fail on Vercel:** Check "Deployments" logs in Vercel. Missing env var? Add it and re-deploy.
- **Database connection errors:** Ensure `DATABASE_URL` is correct and Neon branch is active (not paused).
- **ETL returns "unauthorized":** Use correct ETL_SECRET header or query param.
- **No Slack messages:** Ensure `SLACK_WEBHOOK_URL` is set and valid.

---

## Security notes
- Do not commit `.env` or secrets to GitHub. Use Vercel and GitHub secrets UI.
- For production, rotate Shopify access tokens and store credentials securely.

---

## If you want help live
If you'd like, I can:
- Prepare the exact "Upload & Set" checklist formatted as a single message for you to copy while doing each step, OR
- Generate a short video-style checklist (text) that you can follow step-by-step.

Tell me which you'd prefer after you download & unzip the zip.
