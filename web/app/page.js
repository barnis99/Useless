'use client';

import { useState, useEffect, useCallback } from 'react';

function formatPT() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function getCountdown() {
  const now = new Date();
  const ptNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const next = new Date(ptNow);
  next.setHours(10, 0, 0, 0);
  if (ptNow >= next) next.setDate(next.getDate() + 1);
  const ms = next - ptNow;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
}

function getVisitDate() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  pt.setDate(pt.getDate() + 2);
  return `${pt.getMonth() + 1}/${pt.getDate()}/${pt.getFullYear()}`;
}

const STYLES = {
  idle:    { pill: 'bg-gray-100 text-gray-500',   card: 'border-gray-200 bg-gray-50'   },
  running: { pill: 'bg-amber-100 text-amber-700',  card: 'border-amber-300 bg-amber-50' },
  success: { pill: 'bg-green-100 text-green-700',  card: 'border-green-300 bg-green-50' },
  failed:  { pill: 'bg-red-100 text-red-700',      card: 'border-red-300 bg-red-50'     },
};

export default function Dashboard() {
  const [ptTime, setPtTime]       = useState('');
  const [countdown, setCountdown] = useState('');
  const [status, setStatus]       = useState({ state: 'idle' });
  const [inFlight, setInFlight]   = useState(false);

  const visitDate = getVisitDate();

  // Clock + countdown ticker
  useEffect(() => {
    const tick = () => { setPtTime(formatPT()); setCountdown(getCountdown()); };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  // Status poller
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) setStatus(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 2_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  async function handleRunNow() {
    setInFlight(true);
    try {
      await fetch('/api/book', { method: 'POST' });
    } catch {}
    await fetchStatus();
    setInFlight(false);
  }

  const styles = STYLES[status?.state] ?? STYLES.idle;
  const busy   = inFlight || status?.state === 'running';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-sm space-y-4">

        {/* Title */}
        <div className="text-center pb-2">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Booking Agent</h1>
          <p className="text-xs text-gray-400 mt-1">recreation.gov · facility 253731 · ticket 255</p>
        </div>

        {/* Time grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-center">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">
              PT Time
            </p>
            <p className="text-sm font-mono font-bold text-gray-800 tabular-nums">{ptTime}</p>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-center">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">
              10 AM in
            </p>
            <p className="text-sm font-mono font-bold text-amber-500 tabular-nums">{countdown}</p>
          </div>
        </div>

        {/* Visit date */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-center">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">
            Target Visit Date
          </p>
          <p className="text-2xl font-bold text-blue-600">{visitDate}</p>
          <p className="text-xs text-gray-400 mt-1">2 days from today (PT)</p>
        </div>

        {/* Run Now */}
        <button
          onClick={handleRunNow}
          disabled={busy}
          className={[
            'w-full py-5 rounded-2xl text-lg font-bold tracking-wide transition-all duration-150',
            'active:scale-95 shadow-sm select-none',
            busy
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white',
          ].join(' ')}
        >
          {busy ? 'Booking in progress...' : 'Run Now'}
        </button>

        {/* Status card */}
        <div className={`rounded-2xl border p-4 ${styles.card}`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${styles.pill}`}>
              {status?.state ?? 'idle'}
            </span>
            {status?.updatedAt && (
              <span className="text-xs text-gray-400">
                {new Date(status.updatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          {status?.message && (
            <p className="text-sm text-gray-700">{status.message}</p>
          )}
        </div>

        {/* Log */}
        {status?.log && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Log</p>
            <pre className="text-xs text-gray-600 font-mono whitespace-pre-wrap leading-relaxed">
              {status.log}
            </pre>
          </div>
        )}

        <p className="text-center text-xs text-gray-300 pb-4">
          Cron auto-runs at 10:00 AM PT · adjust to 18:00 UTC in winter (PST)
        </p>
      </div>
    </div>
  );
}
