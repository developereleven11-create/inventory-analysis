// pages/api/skus-live.js
// Returns SKUs with metrics for the dashboard (uses Neon Postgres via DATABASE_URL)

import { Pool } from 'pg';
import dayjs from 'dayjs';

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

function safeNum(v, fallback = 0) {
  if (v === null || v === undefined) return fallback;
  return Number(v);
}

export default async function handler(req, res) {
  if (!pool) {
    // No DB configured — return small mock so dashboard still works
    return res.status(200).json({
      skus: [
        {"sku":"POK-234","title":"Baby Oil 200ml","current_stock":42,"avg_daily_30":5.5,"days_of_cover":7.6,"mtd":100,"prev_mtd":60,"trend":"fast","series":[2,3,4,6,7,9,10]},
        {"sku":"POK-789","title":"Mother Cream 100g","current_stock":180,"avg_daily_30":4.0,"days_of_cover":45,"mtd":60,"prev_mtd":120,"trend":"slow","series":[6,5,4,3,2,2,1]}
      ]
    });
  }

  const client = await pool.connect();
  try {
    // 1) Get SKUs that have metrics for today (or most recent date)
    const today = dayjs().format('YYYY-MM-DD');

    // Prefer metrics for current date; if not present, fallback to most recent date available.
    let metricsDate = today;
    const checkRes = await client.query(
      `SELECT 1 FROM metrics_daily WHERE date = CURRENT_DATE LIMIT 1`
    );
    if (checkRes.rowCount === 0) {
      const latestDateRes = await client.query(`SELECT MAX(date) as d FROM metrics_daily`);
      if (latestDateRes.rowCount && latestDateRes.rows[0].d) {
        metricsDate = latestDateRes.rows[0].d.toISOString().slice(0,10);
      } else {
        // no metrics in DB, fallback to empty -> returns small mock below
        return res.status(200).json({ skus: [] });
      }
    }

    // 2) Get top SKUs by recent activity (limit to 200 to keep response size reasonable)
    // This retrieves sku, last known title from products, rolling30, current_stock and MTD totals.
    const skusQuery = `
      SELECT
        m.sku,
        p.title,
        m.rolling30,
        m.current_stock,
        m.days_of_cover,
        COALESCE(mt.mtd_qty, 0) as mtd,
        COALESCE(prev.prev_qty, 0) as prev_mtd
      FROM (
        SELECT sku, rolling30, current_stock, days_of_cover
        FROM metrics_daily
        WHERE date = $1
      ) m
      LEFT JOIN products p ON p.sku = m.sku
      LEFT JOIN (
        SELECT sku, SUM(quantity) as mtd_qty
        FROM orders_lineitems
        WHERE created_at >= date_trunc('month', CURRENT_DATE) AND created_at < CURRENT_DATE + INTERVAL '1 day'
        GROUP BY sku
      ) mt ON mt.sku = m.sku
      LEFT JOIN (
        -- previous month same days
        SELECT ol.sku, SUM(ol.quantity) as prev_qty FROM orders_lineitems ol
        WHERE ol.created_at >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')
          AND ol.created_at <= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month') + ( (date_part('day', CURRENT_DATE)::int - 1) * INTERVAL '1 day')
        GROUP BY ol.sku
      ) prev ON prev.sku = m.sku
      ORDER BY COALESCE(mt.mtd_qty,0) DESC
      LIMIT 200
    `;
    const skusRes = await client.query(skusQuery, [metricsDate]);

    const skus = [];

    // 3) For each sku fetch a 7-day series (for sparkline)
    for (const row of skusRes.rows) {
      const sku = row.sku;
      const title = row.title || sku;
      const avg_daily_30 = safeNum(row.rolling30, 0);
      const current_stock = safeNum(row.current_stock, 0);
      const days_of_cover = row.days_of_cover !== null ? Number(row.days_of_cover) : null;
      const mtd = safeNum(row.mtd, 0);
      const prev_mtd = safeNum(row.prev_mtd, 0);

      // Fetch last 7 days of daily_sales for this SKU (ordered)
      const seriesRes = await client.query(
        `SELECT date, daily_sales FROM metrics_daily WHERE sku = $1 AND date >= CURRENT_DATE - INTERVAL '6 days' ORDER BY date`,
        [sku]
      );
      const series = [];
      // Build 7-element array (fill missing days with zeros)
      const dates = [];
      for (let i=6;i>=0;i--) dates.push(dayjs().subtract(i,'day').format('YYYY-MM-DD'));
      const map = {};
      for (const r of seriesRes.rows) map[r.date.toISOString().slice(0,10)] = Number(r.daily_sales || 0);
      for (const d of dates) series.push(map[d] || 0);

      // Determine trend (fast/slow/steady) using MTD vs prev_mtd
      let trend = 'steady';
      if (prev_mtd > 0) {
        if (mtd >= 1.5 * prev_mtd) trend = 'fast';
        else if (mtd <= 0.7 * prev_mtd) trend = 'slow';
      } else {
        // if no prev data, fallback to comparing last 7 days avg vs 30d avg
        const avg7 = series.reduce((a,b)=>a+b,0) / (series.length || 1);
        if (avg7 >= 1.5 * (avg_daily_30 || 1)) trend = 'fast';
        else if (avg7 <= 0.7 * (avg_daily_30 || 1)) trend = 'slow';
      }

      skus.push({
        sku,
        title,
        current_stock,
        avg_daily_30: Number(avg_daily_30.toFixed(2)),
        days_of_cover: days_of_cover !== null ? Number(days_of_cover.toFixed(1)) : null,
        mtd,
        prev_mtd,
        trend,
        series
      });
    }

    return res.status(200).json({ skus });
  } catch (err) {
    console.error('skus-live error', err);
    return res.status(500).json({ error: 'Failed to fetch SKUs', detail: err.message });
  } finally {
    client.release();
  }
}
