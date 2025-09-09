-- Initial schema for Phase 1 MVP (single deploy)
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  title TEXT,
  category TEXT,
  cost_price NUMERIC,
  retail_price NUMERIC,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_levels (
  id SERIAL PRIMARY KEY,
  sku TEXT,
  location_id TEXT,
  available INTEGER,
  timestamp TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders_lineitems (
  id SERIAL PRIMARY KEY,
  order_id TEXT,
  sku TEXT,
  quantity INTEGER,
  price NUMERIC,
  created_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_lineitems_unique ON orders_lineitems (order_id, sku);

CREATE TABLE IF NOT EXISTS metrics_daily (
  id SERIAL PRIMARY KEY,
  sku TEXT,
  date DATE,
  daily_sales INTEGER,
  rolling7 NUMERIC,
  rolling30 NUMERIC,
  current_stock INTEGER,
  days_of_cover NUMERIC,
  UNIQUE (sku, date)
);
