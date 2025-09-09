export default function Sparkline({values = [], color = '#0f766e'}) {
  if (!values || values.length === 0) return <svg className='sparkline'></svg>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const w = 80, h = 28, padding = 2;
  const points = values.map((v, i) => {
    const x = padding + (i / (values.length - 1)) * (w - padding*2);
    const y = h - padding - ((v - min) / (max - min || 1)) * (h - padding*2);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
