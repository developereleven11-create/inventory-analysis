// pages/api/run-etl.js
// ETL with diagnostic logging: logs operation name + variables before each Shopify call,
// and prints upstream status/body on error for easy diagnosis in Vercel logs.

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

async function postSlack(msg) {
  if (!SLACK_WEBHOOK) return;
  try { await axios.post(SLACK_WEBHOOK, { text: msg }); } catch(e){ console.error('Slack post failed', e && e.message ? e.message : e); }
}

async function shopifyGraphQL(opName, query, variables = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  console.log(`SHOPIFY: graphql op=${opName} url=${url} variables=${JSON.stringify(variables)}`);
  const headers = { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' };
  return axios.post(url, { query, variables }, { headers, timeout: 30000 });
}

async function shopifyREST(opName, path, params = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/${path}`;
  console.log(`SHOPIFY: rest op=${opName} url=${url} params=${JSON.stringify(params)}`);
  const headers = { 'X-Shopify-Access-Token': ACCESS_TOKEN };
  return axios.get(url, { headers, params, timeout: 30000 });
}

export default async function handler(req, res) {
  const key = req.headers['x-etl-secret'] || req.query.secret;
  if (key !== ETL_SECRET) return res.status(401).send('unauthorized');
  if (!DATABASE_URL) return res.status(500).send('DATABASE_URL not set');
  if (!ACCESS_TOKEN || !SHOP) return res.status(500).send('SHOP or ACCESS_TOKEN not set');

  const client = await pool.connect();
  try {
    // 1) Products pagination
    const products = [];
    let cursor = null;
    const productPageSize = 50;
    const productQuery = `
      query productsPage($pageSize:Int!, $cursor:String) {
        products(first:$pageSize, after:$cursor) {
          edges {
            cursor
            node {
              id
              handle
              title
              images(first:5) { edges { node { src altText } } }
              variants(first:250) {
                edges {
                  node {
                    id
                    sku
                    price
                    inventoryItem { id }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`;

    while (true) {
      const op = 'productsPage';
      const variables = { pageSize: productPageSize, cursor };
      const resp = await shopifyGraphQL(op, productQuery, variables);
      if (resp.status !== 200) {
        console.error(`SHOPIFY CALL FAILED — op=${op} url=graphql status=${resp.status} body=${JSON.stringify(resp.data||{})}`);
        throw new Error(`Shopify ${op} failed with status ${resp.status}`);
      }
      const data = resp.data && resp.data.data;
      const edges = (data && data.products && data.products.edges) || [];
      for (const e of edges) products.push(e.node);
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
      if (products.length > 3000) break;
    }

    // Upsert products & variants
    for (const p of products) {
      const firstImage = p.images && p.images.edges && p.images.edges[0] ? p.images.edges[0].node.src : null;
      for (const vEdge of (p.variants && p.variants.edges) || []) {
        const v = vEdge.node;
        const sku = (v.sku || '').trim();
        if (!sku) continue;
        await client.query(
          `INSERT INTO products (sku, title, product_id, variant_id, image, shopify_handle, retail_price, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (sku) DO UPDATE
           SET title=EXCLUDED.title, product_id=EXCLUDED.product_id, variant_id=EXCLUDED.variant_id, image=EXCLUDED.image, shopify_handle=EXCLUDED.shopify_handle, retail_price=EXCLUDED.retail_price`,
          [sku, p.title, p.id, v.id, firstImage, p.handle, v.price || 0, new Date()]
        );
      }
    }

    // 2) Locations
    try {
      const op = 'locations';
      const resp = await shopifyREST(op, 'locations.json', { limit: 250 });
      if (resp.status && resp.status !== 200) {
        console.error(`SHOPIFY CALL FAILED — op=${op} url=locations.json status=${resp.status} body=${JSON.stringify(resp.data||{})}`);
        throw new Error(`Shopify ${op} failed with status ${resp.status}`);
      }
      const locPayload = resp.data || resp; // axios returns {data:...}, but we also accept raw payload
      const locs = locPayload.locations || [];
      for (const l of locs) {
        await client.query(
          `INSERT INTO locations (location_id, name) VALUES ($1,$2) ON CONFLICT (location_id) DO UPDATE SET name=EXCLUDED.name`,
          [String(l.id), l.name || String(l.id)]
        );
      }
    } catch (e) {
      console.warn('Locations fetch warning:', e && e.message ? e.message : e);
      // continue — locations optional
    }

    // 3) Build inventory_item -> sku map from products.variant_id
    const invItemToSku = {};
    const skuRows = await client.query(`SELECT sku, variant_id FROM products WHERE variant_id IS NOT NULL`);
    for (const r of skuRows.rows) {
      const variantGid = r.variant_id || '';
      const parts = variantGid.split('/');
      const numeric = parts[parts.length - 1] || null;
      if (numeric) invItemToSku[numeric.toString()] = r.sku;
    }

    // 4) Inventory levels (REST)
    const invLevels = [];
    let invPage = 0;
    while (true) {
      const op = 'inventory_levels';
      invPage += 1;
      const resp = await shopifyREST(op, 'inventory_levels.json', { limit: 250 });
      if (resp.status && resp.status !== 200) {
        console.error(`SHOPIFY CALL FAILED — op=${op} url=inventory_levels.json status=${resp.status} body=${JSON.stringify(resp.data||{})}`);
        throw new Error(`Shopify ${op} failed with status ${resp.status}`);
      }
      const payload = resp.data || resp;
      const items = payload.inventory_levels || [];
      invLevels.push(...items);
      if (items.length < 250 || invPage > 10) break;
    }

    for (const item of invLevels) {
      const invItemId = item.inventory_item_id ? String(item.inventory_item_id) : null;
      const sku = invItemToSku[invItemId] || (item.sku || null);
      if (!sku) continue;
      const locationId = String(item.location_id || 'unknown');
      await client.query(
        `INSERT INTO inventory_levels (sku, location_id, available, timestamp)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (sku, location_id) DO UPDATE SET available=EXCLUDED.available, timestamp=EXCLUDED.timestamp`,
        [sku, locationId, item.available || 0, new Date()]
      );
    }

    // ---------- 5) Fetch Orders (use GraphQL variable q) — REPLACEMENT BLOCK
    const daysBack = 60;
    // Use full ISO date-time and include quotes in the query string for Shopify
    const sinceIso = dayjs().subtract(daysBack, 'day').startOf('day').toISOString(); // e.g. 2025-07-01T00:00:00.000Z
    const sinceForQuery = sinceIso.split('.')[0] + 'Z'; // remove ms, keep Z
    const orders = [];
    let ocursor = null;
    const orderPageSize = 50;
    const ordersQuery = `
      query fetchOrders($pageSize:Int!, $cursor:String, $q:String!) {
        orders(first:$pageSize, after:$cursor, query:$q, sortKey:CREATED_AT) {
          edges {
            cursor
            node {
              id
              name
              createdAt
              lineItems(first:250) {
                edges { node { sku quantity name } }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`;
    // Format with quotes around the timestamp (Shopify expects a quoted value)
    const queryString = `created_at:>="${sinceForQuery}"`;

    while (true) {
      const op = 'ordersQuery';
      const variables = { pageSize: orderPageSize, cursor: ocursor, q: queryString };
      console.log(`SHOPIFY: graphql op=${op} variables=${JSON.stringify(variables)}`);
      const resp = await shopifyGraphQL(op, ordersQuery, variables);
      if (!resp || resp.status !== 200) {
        console.error(`SHOPIFY CALL FAILED — op=${op} url=graphql status=${resp && resp.status} body=${JSON.stringify(resp && resp.data || {})} variables=${JSON.stringify(variables)}`);
        throw new Error(`Shopify ${op} failed with status ${resp && resp.status}`);
      }
      const data = resp.data && resp.data.data;
      const edges = (data && data.orders && data.orders.edges) || [];
      for (const e of edges) orders.push(e.node);
      if (!data.orders.pageInfo.hasNextPage) break;
      ocursor = edges[edges.length - 1].cursor;
      if (orders.length > 5000) break; // safety cap
    }

    for (const o of orders) {
      for (const liEdge of (o.lineItems && o.lineItems.edges) || []) {
        const li = liEdge.node;
        const sku = (li.sku || '').trim();
        if (!sku) continue;
        await client.query(
          `INSERT INTO orders_lineitems (order_id, sku, quantity, price, created_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [o.id, sku, li.quantity || 0, 0, o.createdAt]
        );
      }
    }

    // 6) Metrics generation
    const skuListRes = await client.query('SELECT sku FROM products');
    const skus = skuListRes.rows.map(r => r.sku);
    const today = dayjs().format('YYYY-MM-DD');

    for (const sku of skus) {
      const salesRes = await client.query(
        `SELECT created_at::date as day, SUM(quantity) as qty FROM orders_lineitems WHERE sku=$1 AND created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY day ORDER BY day`,
        [sku]
      );
      const daily = {};
      for (const r of salesRes.rows) daily[r.day.toISOString().slice(0,10)] = Number(r.qty || 0);
      const days = [];
      for (let i = 29; i >= 0; i--) { const d = dayjs().subtract(i, 'day').format('YYYY-MM-DD'); days.push(daily[d] || 0); }
      const sum30 = days.reduce((a,b)=>a+b,0);
      const avg30 = sum30 / 30;
      const sum7 = days.slice(-7).reduce((a,b)=>a+b,0);
      const avg7 = sum7 / 7;
      const todaySales = daily[today] || 0;

      const stockRes = await client.query(`SELECT SUM(available) as total FROM inventory_levels WHERE sku=$1`, [sku]);
      const current_stock = stockRes.rowCount ? Number(stockRes.rows[0].total || 0) : 0;
      const days_of_cover = avg30 > 0 ? (current_stock / avg30) : null;

      await client.query(
        `INSERT INTO metrics_daily (sku, date, daily_sales, rolling7, rolling30, current_stock, days_of_cover)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (sku,date) DO UPDATE SET daily_sales=EXCLUDED.daily_sales, rolling7=EXCLUDED.rolling7, rolling30=EXCLUDED.rolling30, current_stock=EXCLUDED.current_stock, days_of_cover=EXCLUDED.days_of_cover`,
        [sku, today, todaySales, avg7, avg30, current_stock, days_of_cover]
      );

      if (days_of_cover !== null && days_of_cover <= 14) {
        await postSlack(`:warning: RESTOCK ALERT — SKU: ${sku}\nStock: ${current_stock} | Avg daily (30d): ${avg30.toFixed(2)} → ~${days_of_cover.toFixed(1)} days`);
      }
    }

    await postSlack(`:white_check_mark: ETL completed: products ${products.length}, orders ${orders.length}`);
    res.status(200).send(`ETL completed (products ${products.length}, orders ${orders.length})`);
  } catch (err) {
    // Enhanced logging: include op info if present in earlier logs
    try {
      console.error('ETL error message:', err && err.message ? err.message : String(err));
      if (err.response) {
        console.error('ETL upstream status:', err.response.status);
        console.error('ETL upstream headers:', JSON.stringify(err.response.headers || {}));
        console.error('ETL upstream body:', JSON.stringify(err.response.data || {}));
      } else {
        console.error('ETL no response object on error.');
      }
    } catch (logErr) {
      console.error('Failed to log upstream error details:', logErr && logErr.message ? logErr.message : logErr);
    }
    return res.status(500).send('ETL failed: ' + (err && err.message ? err.message : 'unknown error'));
  } finally {
    try { client.release(); } catch (e) { console.error('Failed to release DB client', e && e.message ? e.message : e); }
  }
}
