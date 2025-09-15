// pages/api/run-etl.js
// Final ETL: products (GraphQL), inventory & locations (REST), orders (REST with Link header pagination).
// Robust logging + safety caps for Vercel serverless.

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
  try { await axios.post(SLACK_WEBHOOK, { text: msg }); } catch (e) { console.error('Slack post failed', e && e.message ? e.message : e); }
}

async function shopifyGraphQL(opName, query, variables = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  console.log(`SHOPIFY: graphql op=${opName} url=${url} variables=${JSON.stringify(variables)}`);
  const headers = { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' };
  return axios.post(url, { query, variables }, { headers, timeout: 30000 });
}

async function shopifyREST(opName, pathOrUrl, params = {}, absolute = false) {
  const url = absolute ? pathOrUrl : `https://${SHOP}/admin/api/${API_VERSION}/${pathOrUrl}`;
  console.log(`SHOPIFY: rest op=${opName} url=${url} params=${JSON.stringify(params)}`);
  const headers = { 'X-Shopify-Access-Token': ACCESS_TOKEN };
  return axios.get(url, { headers, params, timeout: 60000 });
}

function parseLinkHeader(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const sections = part.split(';').map(s => s.trim());
    if (sections.length < 2) continue;
    const urlPart = sections[0].replace(/^<|>$/g, '');
    const relPart = sections[1];
    if (relPart.includes('rel="next"')) return urlPart;
  }
  return null;
}

export default async function handler(req, res) {
  const key = req.headers['x-etl-secret'] || req.query.secret;
  if (key !== ETL_SECRET) return res.status(401).send('unauthorized');
  if (!DATABASE_URL) return res.status(500).send('DATABASE_URL not set');
  if (!ACCESS_TOKEN || !SHOP) return res.status(500).send('SHOP or ACCESS_TOKEN not set');

  const client = await pool.connect();
  try {
    // ---------- 1) Products (GraphQL paging)
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
      if (!resp || resp.status !== 200) {
        console.error(`SHOPIFY CALL FAILED — op=${op} status=${resp && resp.status} body=${JSON.stringify(resp && resp.data || {})}`);
        throw new Error(`Shopify ${op} failed with status ${resp && resp.status}`);
      }
      const data = resp.data && resp.data.data;
      const edges = (data && data.products && data.products.edges) || [];
      for (const e of edges) products.push(e.node);
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
      if (products.length > 3000) break; // safety cap
    }

    // Upsert products + variants (store variant_id and inventory_item_id as GraphQL GIDs numeric tail)
for (const p of products) {
  const firstImage = p.images && p.images.edges && p.images.edges[0] ? p.images.edges[0].node.src : null;
  for (const vEdge of (p.variants && p.variants.edges) || []) {
    const v = vEdge.node;
    const sku = (v.sku || '').trim();
    if (!sku) continue;

    // inventoryItem id (GraphQL GID like gid://shopify/InventoryItem/123456789)
    const invGid = (v.inventoryItem && v.inventoryItem.id) ? v.inventoryItem.id : null;
    const invNumeric = invGid ? String(invGid).split('/').pop() : null;

    await client.query(
      `INSERT INTO products (sku, title, product_id, variant_id, inventory_item_id, image, shopify_handle, retail_price, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (sku) DO UPDATE
       SET title=EXCLUDED.title,
           product_id=EXCLUDED.product_id,
           variant_id=EXCLUDED.variant_id,
           inventory_item_id=EXCLUDED.inventory_item_id,
           image=EXCLUDED.image,
           shopify_handle=EXCLUDED.shopify_handle,
           retail_price=EXCLUDED.retail_price`,
      [sku, p.title, p.id, v.id, invNumeric, firstImage, p.handle, v.price || 0, new Date()]
    );
  }
}


    // ---------- 2) Locations (REST)
    try {
      const respLoc = await shopifyREST('locations', 'locations.json', { limit: 250 });
      const locPayload = respLoc.data || respLoc;
      const locs = locPayload.locations || [];
      for (const l of locs) {
        await client.query(
          `INSERT INTO locations (location_id, name) VALUES ($1,$2) ON CONFLICT (location_id) DO UPDATE SET name=EXCLUDED.name`,
          [String(l.id), l.name || String(l.id)]
        );
      }
    } catch (e) {
      console.warn('Locations fetch warning:', e && e.message ? e.message : e);
    }

    // --- Robust inventory processing (replacement)
    console.log('INVENTORY: start');
    const invLevels = [];
    try {
      // first page
      const firstInvResp = await shopifyREST('inventory_levels', 'inventory_levels.json', { limit: 250 });
      const firstPayload = firstInvResp.data || firstInvResp;
      invLevels.push(...(firstPayload.inventory_levels || []));

      // follow Link header
      const parseLink = (str) => {
        if (!str) return null;
        const parts = str.split(',');
        for (const p of parts) {
          const [urlPart, relPart] = p.split(';').map(s => s.trim());
          if (relPart && relPart.includes('rel="next"')) return urlPart.replace(/^<|>$/g, '');
        }
        return null;
      };

      let nextInv = (firstInvResp.headers && (firstInvResp.headers.link || firstInvResp.headers.Link)) || null;
      let pages = 0;
      while (nextInv && pages < 20) {
        pages++;
        const nextResp = await shopifyREST('inventory_levels_next', nextInv, {}, true);
        const payload = nextResp.data || nextResp;
        invLevels.push(...(payload.inventory_levels || []));
        const lh = (nextResp.headers && (nextResp.headers.link || nextResp.headers.Link)) || null;
        nextInv = parseLink(lh);
      }
    } catch (e) {
      console.warn('INVENTORY fetch failed:', e && e.message ? e.message : e);
    }

    // Build mapping from inventory_item_id -> sku from products
    const invItemToSku = {};
    const skuRows = await client.query(`SELECT sku, inventory_item_id FROM products WHERE inventory_item_id IS NOT NULL`);
    for (const r of skuRows.rows) if (r.inventory_item_id) invItemToSku[String(r.inventory_item_id)] = r.sku;

    // Counters for debug
    let totalInv = 0, mapped = 0, autopopulated = 0, inserted = 0;

    for (const item of invLevels) {
      totalInv++;
      const invItemId = item.inventory_item_id ? String(item.inventory_item_id) : null;
      const skuFromRow = item.sku ? String(item.sku).trim() : null;
      let sku = invItemId && invItemToSku[invItemId] ? invItemToSku[invItemId] : null;

      // If missing, but inventory row carries sku, backfill products.inventory_item_id
      if (!sku && skuFromRow) {
        const pcheck = await client.query(`SELECT sku FROM products WHERE sku=$1 LIMIT 1`, [skuFromRow]);
        if (pcheck.rowCount === 1) {
          await client.query(`UPDATE products SET inventory_item_id=$1 WHERE sku=$2`, [invItemId, skuFromRow]);
          invItemToSku[invItemId] = skuFromRow;
          sku = skuFromRow;
          autopopulated++;
        }
      }

      if (sku) mapped++;

      const locationId = String(item.location_id || 'unknown');
      try {
        await client.query(
          `INSERT INTO inventory_levels (sku, location_id, available, timestamp, inventory_item_id)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (sku, location_id) DO UPDATE SET available=EXCLUDED.available, timestamp=EXCLUDED.timestamp, inventory_item_id=EXCLUDED.inventory_item_id`,
          [sku || skuFromRow || (invItemId ? ('invitem_' + invItemId) : null), locationId, item.available || 0, new Date(), invItemId]
        );
        inserted++;
      } catch (e) {
        console.error('INVENTORY upsert error', invItemId, e && e.message ? e.message : e);
      }
    }

    console.log(`INVENTORY: processed ${totalInv}; mapped=${mapped}; autopopulated=${autopopulated}; inserted=${inserted}`);

    // ---------- 4) Orders via REST (robust Link-header paging)
    const daysBack = 60;
    const sinceIsoFull = dayjs().subtract(daysBack, 'day').startOf('day').toISOString(); // ISO with ms
    const sinceForRest = sinceIsoFull.split('.')[0] + 'Z'; // remove ms
    const orders = [];

    // initial orders call
    let ordersUrl = `orders.json`;
    let params = { limit: 250, status: 'any', created_at_min: sinceForRest };
    try {
      let resp = await shopifyREST('orders', ordersUrl, params);
      if (!resp) throw new Error('orders initial response empty');
      let payload = resp.data || resp;
      orders.push(...(payload.orders || []));

      let link = (resp.headers && (resp.headers.link || resp.headers.Link)) || null;
      let next = parseLinkHeader(link);
      let pageCount = 0;
      while (next && pageCount < 40 && orders.length < 20000) {
        pageCount += 1;
        console.log('SHOPIFY: orders next page', next);
        const nextResp = await shopifyREST('orders_next', next, {}, true);
        const nextPayload = nextResp.data || nextResp;
        orders.push(...(nextPayload.orders || []));
        const lh = (nextResp.headers && (nextResp.headers.link || nextResp.headers.Link)) || null;
        next = parseLinkHeader(lh);
      }
    } catch (e) {
      console.error('Orders fetch failed:', e && e.message ? e.message : e);
      // If orders fetch fails, we continue — orders absent will simply reduce metrics
    }

    // Insert orders_lineitems into DB
    for (const o of orders) {
      const createdAt = o.created_at || o.createdAt || new Date().toISOString();
      const line_items = o.line_items || o.lineItems || [];
      for (const li of line_items) {
        const sku = (li.sku || '').trim();
        const qty = Number(li.quantity || li.quantity || 0);
        if (!sku) continue;
        await client.query(
          `INSERT INTO orders_lineitems (order_id, sku, quantity, price, created_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [String(o.id || o.id), sku, qty, 0, createdAt]
        );
      }
    }

    // ---------- 5) Compute metrics and upsert metrics_daily
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
