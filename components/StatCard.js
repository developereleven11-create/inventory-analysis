export default function StatCard({title, value, delta}) {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
      <div className="text-sm text-gray-500">{title}</div>
      <div className="mt-2 flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
          {delta && <div className="text-xs text-gray-400 mt-1">{delta}</div>}
        </div>
      </div>
    </div>
  );
}
