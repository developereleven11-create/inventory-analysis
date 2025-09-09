// pages/index.js
import useSWR from 'swr';
import Image from 'next/image';

const fetcher = (url) => fetch(url).then((r) => r.json());

function StatCard({ title, value, hint }) {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
      <div className="text-sm text-gray-500">{title}</div>
      <div className="mt-2">
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
      </div>
    </div>
  );
}

function Sparkline({ values = [], color = '#059669' }) {
  if (!values || values.length === 0) return <div style={{ width: 80, height: 28 }} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const w = 80, h = 28, p = 2;
  const points = values.map((v, i) => {
    const x = p + (i / (values.length - 1)) * (w - p * 2);
    const y = h - p - ((v - min) / (max - min || 1)) * (h - p * 2);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="inline-block" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrendBadge({ trend }) {
  if (trend === 'fast') return <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">FAST</span>;
  if (trend === 'slow') return <span className="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">SLOW</span>;
  return <span className="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">STEADY</span>;
}

export default function Dashboard() {
  const { data, error } = useSWR('/api/skus-live', fetcher, { refreshInterval: 60_000 });
  const skus = data?.skus || [];

  const totalSKUs = skus.length;
  const lowStock = skus.filter(s => s.days_of_cover !== null && s.days_of_cover < 14).length;
  const fastMovers = skus.filter(s => s.trend === 'fast').length;

  return (
    <div className="min-h-screen py-8">
      <div className="max-w-6xl mx-auto px-4">
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-gradient-to-br from-teal-700 to-cyan-500 text-white font-bold shadow">P</div>
            <div>
              <h1 className="text-2xl font-extrabold">Pokonut Inventory Intelligence</h1>
              <div className="text-sm text-gray-500">Live inventory · Velocity · Nudges</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => location.reload()} className="px-4 py-2 rounded-md bg-white border shadow">Refresh</button>
            <button
              onClick={async () => {
                const res = await fetch(`/api/run-etl?secret=${process.env.NEXT_PUBLIC_ETL_SECRET || ''}`);
                const txt = await res.text();
                alert(txt);
              }}
              className="px-4 py-2 rounded-md bg-teal-700 text-white shadow-lg"
            >
              Run ETL
            </button>
          </div>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <StatCard title="SKUs Tracked" value={totalSKUs} />
          <StatCard title="Low Stock (<14d cover)" value={lowStock} />
          <StatCard title="Fast Movers (MTD)" value={fastMovers} />
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <main className="lg:col-span-2 bg-white rounded-xl p-5 shadow-sm border">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Products & Velocity</h2>
              <div className="text-sm text-gray-500">Updated from live ETL</div>
            </div>

            {error && <div className="text-sm text-red-600 mb-2">Failed to load data: {String(error.message)}</div>}
            <div className="overflow-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="py-2">Product</th>
                    <th>Price</th>
                    <th>Stock</th>
                    <th>Avg/day (30d)</th>
                    <th>Days cover</th>
                    <th>MTD vs Prev</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.map(s => (
                    <tr key={s.sku} className="border-t">
                      <td className="py-3 flex items-center gap-3">
                        <div className="w-12 h-12 rounded-md bg-gray-50 flex items-center justify-center overflow-hidden">
                          {s.image ? (
                            // next/image requires domain config in next.config.js to work on Vercel.
                            // If domain not set, fallback to plain img tag:
                            <img src={s.image} alt={s.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <div className="text-sm text-gray-400">{s.sku}</div>
                          )}
                        </div>
                        <div>
                          <a href={s.product_url || '#'} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                            {s.title}
                          </a>
                          <div className="text-xs text-gray-400">{s.sku}</div>
                        </div>
                      </td>

                      <td className="py-3">${(s.retail_price || 0).toFixed(2)}</td>
                      <td className="py-3">{s.current_stock}</td>
                      <td className="py-3">{s.avg_daily_30}</td>
                      <td className="py-3">{s.days_of_cover !== null ? s.days_of_cover.toFixed(1) : '—'}</td>
                      <td className="py-3">{s.mtd} / {s.prev_mtd}</td>
                      <td className="py-3 flex items-center gap-3">
                        <SparklineSmall values={s.series} trend={s.trend} />
                        <TrendBadge trend={s.trend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {skus.length === 0 && <div className="p-4 text-sm text-gray-500">No SKU metrics found. Run ETL to populate metrics.</div>}
            </div>
          </main>

          <aside className="bg-white rounded-xl p-5 shadow-sm border">
            <h3 className="font-semibold mb-3">Alerts & Quick Actions</h3>

            <div className="space-y-3 mb-4">
              {skus.filter(s => s.days_of_cover !== null && s.days_of_cover < 14).map(s => (
                <div key={'a-'+s.sku} className="p-3 rounded-md bg-red-50 border border-red-100">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-sm font-medium">RESTOCK</div>
                      <div className="text-xs text-gray-500">{s.sku} • {s.title}</div>
                      <div className="text-xs mt-1">Stock: <strong>{s.current_stock}</strong> • {s.days_of_cover.toFixed(1)} days left</div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button className="px-3 py-1 rounded-md bg-white border">Create PO</button>
                      <button className="px-3 py-1 rounded-md bg-white border">Snooze</button>
                    </div>
                  </div>
                </div>
              ))}

              {skus.filter(s => s.trend === 'slow').map(s => (
                <div key={'b-'+s.sku} className="p-3 rounded-md bg-yellow-50 border border-yellow-100">
                  <div className="text-sm font-medium">SLOWDOWN</div>
                  <div className="text-xs text-gray-500">{s.sku} • {s.title}</div>
                  <div className="text-xs mt-1">Consider campaign / bundle • Inventory: {s.current_stock}</div>
                </div>
              ))}
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Quick Actions</h4>
              <div className="space-y-2">
                <button className="w-full text-left px-4 py-3 rounded-md border bg-white">Create Purchase Order</button>
                <button className="w-full text-left px-4 py-3 rounded-md border bg-white">Create Promo Brief</button>
                <button className="w-full text-left px-4 py-3 rounded-md border bg-white">Export CSV</button>
              </div>
            </div>
          </aside>
        </div>

        <footer className="mt-8 text-xs text-gray-400">Live data from Neon · ETL runs via /api/run-etl</footer>
      </div>
    </div>
  );
}

function SparklineSmall({ values, trend }) {
  const color = trend === 'fast' ? '#059669' : trend === 'slow' ? '#dc2626' : '#6b7280';
  return <Sparkline values={values} color={color} />;
}
