// pages/api/webhooks.js
import crypto from 'crypto';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function verifyHmac(body, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(body, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const hmac = req.headers['x-shopify-hmac-sha256'] || '';
  if (!verifyHmac(raw, hmac)) {
    console.warn('Webhook HMAC failed');
    return res.status(401).send('unauthorized');
  }

  const topic = req.headers['x-shopify-topic'];
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).send('invalid json'); }

  const client = await pool.connect();
  try {
    if (topic === 'orders/create' || topic === 'orders/updated') {
      const order = payload;
      for (const li of (order.line_items || [])) {
        const sku = (li.sku || '').trim();
        if (!sku) continue;
        await client.query(
          `INSERT INTO orders_lineitems (order_id, sku, quantity, price, created_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [String(order.id), sku, Number(li.quantity || 0), Number(li.price || 0), order.created_at]
        );
      }
      // Optionally trigger metrics recompute for affected SKUs (simple approach: not compute here to avoid heavy work)
    } else if (topic === 'inventory_levels/update') {
      // payload contains inventory_level details
      const inv = payload;
      const sku = inv.sku || null;
      const locationId = String(inv.location_id || 'unknown');
      const available = Number(inv.available || 0);
      await client.query(
        `INSERT INTO inventory_levels (sku, location_id, available, timestamp)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (sku, location_id) DO UPDATE SET available=EXCLUDED.available, timestamp=EXCLUDED.timestamp`,
        [sku, locationId, available, new Date()]
      );
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('Webhook handler error', e && e.message ? e.message : e);
    res.status(500).send('err');
  } finally {
    client.release();
  }
}
