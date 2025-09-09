// pages/api/skus-live.js
import { Pool } from 'pg';
import dayjs from 'dayjs';
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

function safeNum(v, fallback = 0) { if (v === null || v === undefined) return fallback; return Number(v); }

export default async function handler(req, res) {
  if (!pool) return res.status(200).json({ skus: [] });

  const client = await pool.connect();
  try {
    // choose the metrics date as before
    const today = dayjs().format('YYYY-MM-DD');
    const checkRes = await client.query(`SELECT 1 FROM metrics_daily WHERE date = CURRENT_DATE LIMIT 1`);
    let metricsDate = today;
    if (checkRes.rowCount === 0) {
      const latestDateRes = await client.query(`SELECT MAX(date) as d FROM metrics_daily`);
      if (latestDateRes.rowCount && latestDateRes.rows[0].d) metricsDate = latestDateRes.rows[0].d.toISOString().slice(0,10);
      else return res.status(200).json({ skus: [] });
    }

    // get skus + product metadata + aggregated stock
    const q = `
      SELECT m.sku, p.title, p.image, p.shopify_handle, p.retail_price, m.rolling30, m.current_stock, m.days_of_cover,
             COALESCE(mt.mtd_qty,0) as mtd, COALESCE(prev.prev_qty,0) as prev_mtd
      FROM metrics_daily m
      JOIN products p ON p.sku = m.sku
      LEFT JOIN (
        SELECT sku, SUM(quantity) as mtd_qty FROM orders_lineitems
        WHERE created_at >= date_trunc('month', CURRENT_DATE) AND created_at < CURRENT_DATE + INTERVAL '1 day'
        GROUP BY sku
      ) mt ON mt.sku = m.sku
      LEFT JOIN (
        SELECT ol.sku, SUM(ol.quantity) as prev_qty FROM orders_lineitems ol
        WHERE ol.created_at >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')
          AND ol.created_at <= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month') + ( (date_part('day', CURRENT_DATE)::int - 1) * INTERVAL '1 day')
        GROUP BY ol.sku
      ) prev ON prev.sku = m.sku
      WHERE m.date = $1
      ORDER BY COALESCE(mt.mtd_qty,0) DESC
      LIMIT 200
    `;
    const rows = (await client.query(q, [metricsDate])).rows;

    const skus = [];
    for (const r of rows) {
      // gather last 7 days series
      const seriesRes = await client.query(
        `SELECT date, daily_sales FROM metrics_daily WHERE sku=$1 AND date >= CURRENT_DATE - INTERVAL '6 days' ORDER BY date`, [r.sku]
      );
      const map = {};
      for (const s of seriesRes.rows) map[s.date.toISOString().slice(0,10)] = Number(s.daily_sales || 0);
      const dates = [];
      for (let i=6;i>=0;i--) dates.push(dayjs().subtract(i,'day').format('YYYY-MM-DD'));
      const series = dates.map(d => map[d] || 0);

      // derive trend
      let trend = 'steady';
      const mtd = safeNum(r.mtd, 0), prev = safeNum(r.prev_mtd, 0);
      if (prev > 0) {
        if (mtd >= 1.5 * prev) trend = 'fast';
        else if (mtd <= 0.7 * prev) trend = 'slow';
      } else {
        const avg7 = series.reduce((a,b)=>a+b,0)/(series.length||1);
        if (avg7 >= 1.5 * (Number(r.rolling30 || 1))) trend = 'fast';
        else if (avg7 <= 0.7 * (Number(r.rolling30 || 1))) trend = 'slow';
      }

      skus.push({
        sku: r.sku,
        title: r.title,
        image: r.image,
        product_url: r.shopify_handle ? `https://${process.env.SHOPIFY_STORE}/products/${r.shopify_handle}` : null,
        retail_price: Number(r.retail_price||0),
        current_stock: Number(r.current_stock||0),
        avg_daily_30: Number(r.rolling30||0),
        days_of_cover: r.days_of_cover !== null ? Number(r.days_of_cover) : null,
        mtd: Number(r.mtd||0),
        prev_mtd: Number(r.prev_mtd||0),
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
