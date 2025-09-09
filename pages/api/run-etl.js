/* pages/api/run-etl.js
   Improved ETL: fetch products+variants, inventory levels, recent orders, and write to Postgres.
   Conservative paging for serverless; suitable for small-to-medium stores.
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
  try { await axios.post(SLACK_WEBHOOK, { text: message }); } catch (e) { console.error('Slack post failed', e.message); }
}

async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const headers = { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' };
  const res = await axios.post(url, { query, variables }, { headers, timeout: 30000 });
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

async function shopifyREST(path, params = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/${path}`;
  const headers = { 'X-Shopify-Access-Token': ACCESS_TOKEN };
  const res = await axios.get(url, { headers, params, timeout: 30000 });
  return res.data;
}

export default async function handler(req, res) {
  const key = req.headers['x-etl-secret'] || req.query.secret;
  if (key !== ETL_SECRET) return res.status(401).send('unauthorized');
  if (!DATABASE_URL) return res.status(500).send('DATABASE_URL not set');
  if (!ACCESS_TOKEN || !SHOP) return res.status(500).send('SHOP or ACCESS_TOKEN not set');

  const client = await pool.connect();
  try {
    // --- 1) Fetch Products + Variants (page through with cursor, small pages)
    const products = [];
    let cursor = null;
    const pageSize = 50;
    const productQuery = `
      query productsPage($pageSize:Int!, $cursor:String) {
        products(first:$pageSize, after:$cursor) {
          edges {
            cursor
            node {
              id
              handle
              title
              images(first:1) { edges { node { src } } }
              variants(first:50) {
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
      const data = await shopifyGraphQL(productQuery, { pageSize, cursor });
      const edges = data.products.edges || [];
      for (const e of edges) {
        products.push(e.node);
      }
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = edges[edges.length-1].cursor;
      if (products.length > 1000) break; // serverless safety
    }

    // Upsert product + variant metadata into products table
    for (const p of products) {
      const img = (p.images && p.images.edges && p.images.edges[0]) ? p.images.edges[0].node.src : null;
      for (const vEdge of p.variants.edges) {
        const v = vEdge.node;
        const sku = (v.sku || '').trim();
        if (!sku) continue; // skip variants without SKU
        await client.query(
          `INSERT INTO products (sku, title, product_id, variant_id, image, shopify_handle, retail_price, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (sku) DO UPDATE SET title=EXCLUDED.title, product_id=EXCLUDED.product_id, variant_id=EXCLUDED.variant_id, image=EXCLUDED.image, shopify_handle=EXCLUDED.shopify_handle, retail_price=EXCLUDED.retail_price`,
          [sku, p.title, p.id, v.id, img, p.handle, v.price || 0, new Date()]
        );
      }
    }

    // --- 2) Fetch Inventory Levels (REST) and map inventory_item_id -> sku
    // First build a map inventoryItemId -> sku from products table (variant.inventoryItem.id is the GraphQL id)
    const invItemToSku = {};
    const skuRows = await client.query(`SELECT sku, variant_id FROM products WHERE variant_id IS NOT NULL`);
    for (const r of skuRows.rows) {
      // variant_id in DB is GraphQL gid; but Shopify REST inventory_levels returns inventory_item_id numeric id.
      // We need to extract numeric inventory_item_id if possible from variant_id: variant_id format often 'gid://shopify/ProductVariant/123456'
      const variantGid = r.variant_id || '';
      const parts = variantGid.split('/');
      const numeric = parts[parts.length-1] || null;
      if (numeric) invItemToSku[numeric.toString()] = r.sku;
    }

    // Fetch inventory levels (REST). This returns inventory_item_id and available
    let invParams = { limit: 250 };
    const invLevels = [];
    let invPage = 1;
    while (true) {
      const payload = await shopifyREST('inventory_levels.json', invParams);
      const items = payload.inventory_levels || [];
      invLevels.push(...items);
      if (items.length < 250) break;
      invPage += 1;
      if (invPage > 5) break; // safety
    }

    // Upsert inventory_levels and aggregate per sku
    for (const item of invLevels) {
      const invItemId = item.inventory_item_id ? String(item.inventory_item_id) : null;
      const sku = invItemToSku[invItemId] || (item.sku || null); // fallback if SKU provided
      if (!sku) continue;
      const locationId = String(item.location_id || 'unknown');
      await client.query(
        `INSERT INTO inventory_levels (sku, location_id, available, timestamp)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (sku, location_id) DO UPDATE SET available=EXCLUDED.available, timestamp=EXCLUDED.timestamp`,
        [sku, locationId, item.available || 0, new Date()]
      );
    }

    // --- 3) Fetch recent Orders (safe window) and insert line items
    const daysBack = 30; // fetch 30 days for better metrics
    const since = dayjs().subtract(daysBack, 'day').startOf('day').toISOString();
    const orders = [];
    let ocursor = null;
    const orderPageSize = 50;
    const ordersQuery = `
      query fetchOrders($pageSize:Int!, $cursor:String, $since:String!) {
        orders(first:$pageSize, after:$cursor, query:"created_at:>=$since", sortKey:CREATED_AT) {
          edges {
            cursor
            node {
              id
              name
              createdAt
              lineItems(first:100) {
                edges {
                  node {
                    sku
                    quantity
                    name
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`;
    while (true) {
      const data = await shopifyGraphQL(ordersQuery, { pageSize: orderPageSize, cursor: ocursor, since });
      const edges = data.orders.edges || [];
      for (const e of edges) orders.push(e.node);
      if (!data.orders.pageInfo.hasNextPage) break;
      ocursor = edges[edges.length-1].cursor;
      if (orders.length > 2000) break; // safety
    }

    for (const o of orders) {
      for (const liEdge of (o.lineItems.edges || [])) {
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

    // --- 4) Compute metrics for each SKU (rolling7, rolling30, days_of_cover) and insert metrics_daily
    const skuListRes = await client.query('SELECT sku FROM products');
    const skus = skuListRes.rows.map(r => r.sku);
    const today = dayjs().format('YYYY-MM-DD');

    for (const sku of skus) {
      // daily sales last 30 days
      const salesRes = await client.query(
        `SELECT created_at::date as day, SUM(quantity) as qty FROM orders_lineitems WHERE sku=$1 AND created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY day ORDER BY day`,
        [sku]
      );
      const daily = {};
      for (const r of salesRes.rows) daily[r.day.toISOString().slice(0,10)] = Number(r.qty || 0);
      const days = [];
      for (let i=29;i>=0;i--) { const d = dayjs().subtract(i,'day').format('YYYY-MM-DD'); days.push(daily[d] || 0); }
      const sum30 = days.reduce((a,b)=>a+b,0);
      const avg30 = sum30 / 30;
      const sum7 = days.slice(-7).reduce((a,b)=>a+b,0);
      const avg7 = sum7 / 7;
      const todaySales = daily[today] || 0;

      // current stock aggregated across locations
      const stockRes = await client.query(`SELECT SUM(available) as total FROM inventory_levels WHERE sku=$1`, [sku]);
      const current_stock = stockRes.rowCount ? Number(stockRes.rows[0].total || 0) : 0;
      const days_of_cover = avg30 > 0 ? (current_stock / avg30) : null;

      await client.query(
        `INSERT INTO metrics_daily (sku, date, daily_sales, rolling7, rolling30, current_stock, days_of_cover)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (sku,date) DO UPDATE SET daily_sales=EXCLUDED.daily_sales, rolling7=EXCLUDED.rolling7, rolling30=EXCLUDED.rolling30, current_stock=EXCLUDED.current_stock, days_of_cover=EXCLUDED.days_of_cover`,
        [sku, today, todaySales, avg7, avg30, current_stock, days_of_cover]
      );

      // alert logic as before
      if (days_of_cover !== null && days_of_cover <= 14) {
        await postSlack(`:warning: *RESTOCK ALERT* — SKU: ${sku}\nStock: ${current_stock} | Avg daily (30d): ${avg30.toFixed(2)} → ~${(days_of_cover).toFixed(1)} days`);
      }
    }

    await postSlack(`:white_check_mark: ETL completed: products ${products.length}, orders ${orders.length}`);
    return res.status(200).send(`ETL completed (products ${products.length}, orders ${orders.length})`);
  } catch (err) {
    console.error('ETL error', err);
    return res.status(500).send('ETL failed: ' + (err.message||err));
  } finally {
    client.release();
  }
}
