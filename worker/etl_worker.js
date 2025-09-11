// worker/etl_worker.js
// Run this on Render/Railway as a long-running job or cron.
// Node 18+ recommended.

import pg from 'pg';
import axios from 'axios';
import dayjs from 'dayjs';
import fs from 'fs/promises';
import path from 'path';

const {
  DATABASE_URL,
  SHOPIFY_STORE,
  SHOPIFY_ADMIN_API_KEY,
  SHOPIFY_API_VERSION = '2025-07',
  SLACK_WEBHOOK_URL,
  STATE_FILE = '/tmp/etl_state.json', // On Render use /tmp; on Railway adjust
  BACKFILL_DAYS = '365'
} = process.env;

if (!DATABASE_URL || !SHOPIFY_STORE || !SHOPIFY_ADMIN_API_KEY) {
  console.error('Missing required envs: DATABASE_URL, SHOPIFY_STORE, SHOPIFY_ADMIN_API_KEY');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function postSlack(msg) {
  if (!SLACK_WEBHOOK_URL) return;
  try { await axios.post(SLACK_WEBHOOK_URL, { text: msg }); } catch (e) { console.warn('Slack post failed', e && e.message); }
}

function parseLinkHeader(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const [urlPart, relPart] = part.split(';').map(s => s.trim());
    if (relPart && relPart.includes('rel="next"')) return urlPart.replace(/^<|>$/g, '');
  }
  return null;
}

async function getState() {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) { return {}; }
}
async function saveState(s) {
  try { await fs.writeFile(STATE_FILE, JSON.stringify(s)); } catch (e) { console.warn('Failed to write state', e && e.message); }
}

/** Helper: call Shopify REST GET returning axios response */
async function shopifyGet(url, params = {}, absolute = false) {
  const fullUrl = absolute ? url : `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/${url}`;
  const headers = { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY };
  return axios.get(fullUrl, { headers, params, timeout: 60000 });
}

/** 1) Fetch all products & variants (paged GraphQL), idempotent upsert */
async function fetchAndUpsertProducts(pgClient) {
  console.log('starting fetchAndUpsertProducts');
  const productQuery = `
    query productsPage($pageSize:Int!, $cursor:String) {
      products(first:$pageSize, after:$cursor) {
        edges {
          cursor
          node {
            id
            handle
            title
            images(first:1) { edges { node { src altText } } }
            variants(first:250) {
              edges {
                node { id sku price inventoryItem { id } }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }`;
  let cursor = null;
  let total = 0;
  const pageSize = 100;
  while (true) {
    const resp = await axios.post(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: productQuery, variables: { pageSize, cursor } },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_KEY, 'Content-Type': 'application/json' }, timeout: 60000 });
    if (resp.status !== 200) throw new Error('Products GraphQL failed');
    const data = resp.data && resp.data.data;
    const edges = (data && data.products && data.products.edges) || [];
    for (const e of edges) {
      const p = e.node;
      const image = (p.images && p.images.edges && p.images.edges[0]) ? p.images.edges[0].node.src : null;
      for (const vEdge of (p.variants && p.variants.edges) || []) {
        const v = vEdge.node;
        const sku = (v.sku || '').trim();
        if (!sku) continue;
        await pgClient.query(
          `INSERT INTO products (sku, title, product_id, variant_id, image, shopify_handle, retail_price, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now())
           ON CONFLICT (sku) DO UPDATE SET title=EXCLUDED.title, product_id=EXCLUDED.product_id, variant_id=EXCLUDED.variant_id, image=EXCLUDED.image, shopify_handle=EXCLUDED.shopify_handle, retail_price=EXCLUDED.retail_price, updated_at=now()`,
          [sku, p.title, p.id, v.id, image, p.handle, v.price || 0]
        );
        total++;
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
    // safety cap
    if (total > 20000) break;
  }
  console.log('products upserted:', total);
}

/** 2) Fetch inventory_levels with Link header paging and upsert */
async function fetchAndUpsertInventory(pgClient) {
  console.log('starting fetchAndUpsertInventory');
  let url = `orders.json`; // dummy init
  let params = { limit: 250 };
  // initial call
  const firstResp = await shopifyGet('inventory_levels.json', { limit: 250 });
  if (firstResp.status !== 200) throw new Error('inventory_levels failed');
  let payload = firstResp.data;
  let rows = payload.inventory_levels || [];
  for (const item of rows) {
    // map inventory_item_id -> sku via products table if possible
    // We'll compute map once
  }
  // Build map inventory_item_id -> sku from products.variant_id
  const invMapRes = await pgClient.query(`SELECT sku, variant_id FROM products WHERE variant_id IS NOT NULL`);
  const invMap = {};
  for (const r of invMapRes.rows) {
    const parts = (r.variant_id || '').split('/');
    const numeric = parts[parts.length-1] || null;
    if (numeric) invMap[numeric] = r.sku;
  }

  // process first page and subsequent pages via Link header
  const allItems = [];
  allItems.push(...(payload.inventory_levels || []));

  let link = firstResp.headers && (firstResp.headers.link || firstResp.headers.Link);
  let nextUrl = parseLinkHeader(link);
  let pages = 0;
  while (nextUrl && pages < 40) {
    pages++;
    const respNext = await shopifyGet(nextUrl, {}, true);
    if (respNext.status !== 200) break;
    const p2 = respNext.data;
    allItems.push(...(p2.inventory_levels || []));
    const link2 = respNext.headers && (respNext.headers.link || respNext.headers.Link);
    nextUrl = parseLinkHeader(link2);
  }

  // upsert inventory_levels
  let upserts = 0;
  for (const item of allItems) {
    const invItemId = item.inventory_item_id ? String(item.inventory_item_id) : null;
    const sku = invMap[invItemId] || (item.sku || null);
    if (!sku) continue;
    const locationId = String(item.location_id || 'unknown');
    await pgClient.query(
      `INSERT INTO inventory_levels (sku, location_id, available, timestamp)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (sku, location_id) DO UPDATE SET available=EXCLUDED.available, timestamp=EXCLUDED.timestamp`,
      [sku, locationId, item.available || 0, new Date()]
    );
    upserts++;
  }
  console.log('inventory upserted rows:', upserts);
}

/** 3) Fetch orders via REST with robust Link header paging (created_at_min) */
async function fetchAndUpsertOrders(pgClient, daysBack = Number(BACKFILL_DAYS || 90)) {
  console.log('starting fetchAndUpsertOrders daysBack=', daysBack);
  const since = dayjs().subtract(daysBack, 'day').startOf('day').toISOString().split('.')[0] + 'Z';
  const orders = [];
  // initial call
  let resp = await shopifyGet('orders.json', { limit: 250, status: 'any', created_at_min: since });
  if (resp.status !== 200) throw new Error('orders.json failed');
  let payload = resp.data;
  orders.push(...(payload.orders || []));

  let link = resp.headers && (resp.headers.link || resp.headers.Link);
  let next = parseLinkHeader(link);
  let pageCount = 0;
  while (next && pageCount < 200 && orders.length < 50000) {
    pageCount++;
    const nextResp = await shopifyGet(next, {}, true);
    if (nextResp.status !== 200) break;
    const p2 = nextResp.data;
    orders.push(...(p2.orders || []));
    const link2 = nextResp.headers && (nextResp.headers.link || nextResp.headers.Link);
    next = parseLinkHeader(link2);
  }

  // upsert orders_lineitems
  let inserted = 0;
  for (const o of orders) {
    const createdAt = o.created_at;
    for (const li of (o.line_items || [])) {
      const sku = (li.sku || '').trim();
      if (!sku) continue;
      await pgClient.query(
        `INSERT INTO orders_lineitems (order_id, sku, quantity, price, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [String(o.id), sku, Number(li.quantity || 0), Number(li.price || 0), createdAt]
      );
      inserted++;
    }
  }
  console.log('orders_lineitems inserted:', inserted);
}

/** 4) Compute metrics for all SKUs */
async function computeMetrics(pgClient) {
  console.log('computeMetrics starting');
  const skuRows = await pgClient.query('SELECT sku FROM products');
  const skus = skuRows.rows.map(r => r.sku);
  const today = dayjs().format('YYYY-MM-DD');

  for (const sku of skus) {
    const salesRes = await pgClient.query(
      `SELECT created_at::date as day, SUM(quantity) as qty FROM orders_lineitems WHERE sku=$1 AND created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY day ORDER BY day`,
      [sku]
    );
    const daily = {};
    for (const r of salesRes.rows) daily[r.day.toISOString().slice(0,10)] = Number(r.qty || 0);
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
      days.push(daily[d] || 0);
    }
    const sum30 = days.reduce((a,b)=>a+b,0);
    const avg30 = sum30 / 30;
    const sum7 = days.slice(-7).reduce((a,b)=>a+b,0);
    const avg7 = sum7 / 7;
    const todaySales = daily[today] || 0;

    const stockRes = await pgClient.query(`SELECT SUM(available) as total FROM inventory_levels WHERE sku=$1`, [sku]);
    const current_stock = stockRes.rowCount ? Number(stockRes.rows[0].total || 0) : 0;
    const days_of_cover = avg30 > 0 ? (current_stock / avg30) : null;

    await pgClient.query(
      `INSERT INTO metrics_daily (sku, date, daily_sales, rolling7, rolling30, current_stock, days_of_cover)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (sku,date) DO UPDATE SET daily_sales=EXCLUDED.daily_sales, rolling7=EXCLUDED.rolling7, rolling30=EXCLUDED.rolling30, current_stock=EXCLUDED.current_stock, days_of_cover=EXCLUDED.days_of_cover`,
      [sku, today, todaySales, avg7, avg30, current_stock, days_of_cover]
    );

    if (days_of_cover !== null && days_of_cover <= 14) {
      await postSlack(`:warning: RESTOCK ALERT — SKU: ${sku}\nStock: ${current_stock} | Avg daily (30d): ${avg30.toFixed(2)} → ~${days_of_cover.toFixed(1)} days`);
    }
  }
  console.log('computeMetrics finished for', skus.length, 'skus');
}

async function main() {
  console.log('ETL worker start', new Date().toISOString());
  const client = await pool.connect();
  try {
    // load state and allow incremental/backfill orchestration
    const state = await getState();
    await fetchAndUpsertProducts(client);
    await fetchAndUpsertInventory(client);
    await fetchAndUpsertOrders(client, Number(process.env.BACKFILL_DAYS || BACKFILL_DAYS || 90));
    await computeMetrics(client);
    // update state
    state.last_run = new Date().toISOString();
    await saveState(state);
    console.log('ETL worker completed successfully');
    await postSlack(`:white_check_mark: ETL worker completed: ${new Date().toISOString()}`);
  } catch (e) {
    console.error('ETL worker error', e && e.message ? e.message : e);
    await postSlack(`:x: ETL worker failed: ${e && e.message ? e.message : e}`);
  } finally {
    try { client.release(); } catch (e) { console.warn('client release failed', e && e.message); }
    process.exit(0); // if invoked as a job
  }
}

if (require.main === module) {
  main();
}
