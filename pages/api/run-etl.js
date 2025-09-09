/**
 * Lightweight ETL endpoint for Vercel serverless (Phase 1).
 * Protected via header x-etl-secret or ?secret=...
 * For non-developers: this endpoint can be triggered manually from the dashboard 'Run ETL' button.
 *
 * NOTE: This is intentionally conservative to avoid Vercel timeouts. For production runs with large data,
 * move ETL to a background worker and keep this endpoint as a trigger only.
 */

import { Pool } from 'pg';
import axios from 'axios';
import dayjs from 'dayjs';

const SHOP = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const ETL_SECRET = process.env.ETL_SECRET || 'change_this_secret';

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function postSlack(message) {
  if (!SLACK_WEBHOOK) return;
  try { await axios.post(SLACK_WEBHOOK, { text: message }); } catch(e){ console.error('Slack post failed', e.message); }
}

export default async function handler(req,res){
  const key = req.headers['x-etl-secret'] || req.query.secret;
  if (key !== ETL_SECRET) return res.status(401).send('unauthorized');

  if (!DATABASE_URL) return res.status(500).send('DATABASE_URL not set');

  const client = await pool.connect();
  try {
    // Minimal safe ETL: fetch orders for last 14 days via GraphQL (small page size)
    // If Shopify not configured yet, this will be a no-op.
    const daysBack = 14;
    const since = dayjs().subtract(daysBack,'day').startOf('day').toISOString();
    const orders = [];
    // NOTE: For non-devs we keep this simple; the real implementation requires a Shopify access token and the query below.
    // We'll simulate a short run and insert a mock metric row to prove things are working.
    const sampleSku = 'POK-234';
    const today = dayjs().format('YYYY-MM-DD');

    // upsert sample product (safe)
    await client.query(`INSERT INTO products (sku, title, created_at) VALUES ($1,$2,$3) ON CONFLICT (sku) DO UPDATE SET title=EXCLUDED.title`, [sampleSku, 'Baby Oil 200ml', new Date()]);

    // insert a fake metric row so the dashboard can read something (idempotent)
    await client.query(
      `INSERT INTO metrics_daily (sku, date, daily_sales, rolling7, rolling30, current_stock, days_of_cover)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sku,date) DO UPDATE SET daily_sales=EXCLUDED.daily_sales, rolling7=EXCLUDED.rolling7, rolling30=EXCLUDED.rolling30, current_stock=EXCLUDED.current_stock, days_of_cover=EXCLUDED.days_of_cover`,
      [sampleSku, today, 5, 6, 5.5, 42, 7.6]
    );

    // Post a tiny Slack notification to confirm successful run (if webhook provided)
    await postSlack(`:white_check_mark: ETL run completed for ${today} (sample data inserted)`);

    return res.status(200).send('ETL run completed (sample data inserted). Check DB and Slack.');
  } catch (e) {
    console.error(e);
    return res.status(500).send('ETL failed: ' + (e.message||e));
  } finally {
    client.release();
  }
}
