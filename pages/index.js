import useSWR from 'swr';
import StatCard from '../components/StatCard';
import Sparkline from '../components/Sparkline';

const fetcher = (url) => fetch(url).then(r=>r.json());

function Badge({children, type}) {
  const cls = type === 'fast' ? 'bg-green-100 text-green-800' : type === 'slow' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800';
  return <span className={'px-2 py-1 rounded-full text-xs font-medium ' + cls}>{children}</span>;
}

export default function Dashboard() {
  const {data, error} = useSWR('/api/skus-live', fetcher, {fallbackData: {skus:[]}});

  const skus = data.skus || [];
  const totalSKUs = skus.length;
  const lowStock = skus.filter(s=>s.days_of_cover && s.days_of_cover < 14).length;
  const fastMovers = skus.filter(s=>s.trend==='fast').length;

  return (
    <div className="min-h-screen py-8">
      <div className="container">
        <header className="flex items-center justify-between mb-8">
          <div className="header-logo">
            <div className="logo-badge">P</div>
            <div>
              <h1 className="text-2xl font-extrabold">Pokonut Inventory Intelligence</h1>
              <div className="text-sm text-gray-500">Phase 1 • Velocity tracking & smart nudges</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={()=>location.reload()} className="px-4 py-2 rounded-md bg-white border shadow">Refresh</button>
            <button onClick={async ()=>{ const res = await fetch('/api/run-etl?secret=' + (process.env.NEXT_PUBLIC_ETL_SECRET || 'demo_secret')); const t = await res.text(); alert(t); }} className="px-4 py-2 rounded-md bg-primary text-white shadow-lg">Run ETL</button>
          </div>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <StatCard title="SKUs Tracked" value={totalSKUs} />
          <StatCard title="Low Stock (<14d cover)" value={lowStock} />
          <StatCard title="Fast Movers (MTD)" value={fastMovers} />
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white rounded-xl p-5 shadow-sm border">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">SKU Velocity</h2>
              <div className="text-sm text-gray-500">Updated live from ETL</div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="py-2">SKU</th><th>Title</th><th>Stock</th><th>Avg/day (30d)</th><th>Days cover</th><th>MTD vs Prev</th><th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.map(s=>(
                    <tr key={s.sku} className="border-t">
                      <td className="py-3 font-mono text-sm">{s.sku}</td>
                      <td className="py-3">{s.title}</td>
                      <td className="py-3">{s.current_stock}</td>
                      <td className="py-3">{s.avg_daily_30}</td>
                      <td className="py-3">{s.days_of_cover ? s.days_of_cover.toFixed(1) : '—'}</td>
                      <td className="py-3">{s.mtd} / {s.prev_mtd}</td>
                      <td className="py-3 flex items-center gap-3"><Sparkline values={s.series} color={s.trend==='fast' ? '#059669' : s.trend==='slow' ? '#dc2626' : '#6b7280'} /> <Badge type={s.trend}>{s.trend.toUpperCase()}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="bg-white rounded-xl p-5 shadow-sm border">
            <h3 className="font-semibold mb-3">Alerts & Quick Actions</h3>
            <div className="space-y-3 mb-4">
              {skus.filter(s=>s.days_of_cover && s.days_of_cover < 14).map(s=>(
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

              {skus.filter(s=>s.trend==='slow').map(s=>(
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

        <footer className="mt-8 text-xs text-gray-400">This dashboard is a Phase 1 MVP — replace mock API with real Shopify + Neon Postgres ETL.</footer>
      </div>
    </div>
  );
}
