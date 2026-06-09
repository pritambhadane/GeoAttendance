import { useState, useEffect } from 'react';
import { getLogs, clearLogs, exportLogs, LogEntry } from '../utils/logger';

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
  gps:  'text-green-400',
  geo:  'text-purple-400',
  tick: 'text-gray-400',
};

export default function LogViewer({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = () => setEntries([...getLogs()].reverse());

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  const filtered = filter
    ? entries.filter(e => e.tag.includes(filter.toUpperCase()) || e.msg.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const handleCopy = () => {
    navigator.clipboard.writeText(exportLogs()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleClear = () => {
    clearLogs();
    refresh();
  };

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col font-mono text-xs">
      {/* Header */}
      <div className="flex items-center gap-2 p-2 bg-gray-900 border-b border-gray-700">
        <button onClick={onClose} className="text-white bg-gray-700 px-2 py-1 rounded">✕ Close</button>
        <input
          className="flex-1 bg-gray-800 text-white px-2 py-1 rounded border border-gray-600"
          placeholder="Filter by tag or message..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <button onClick={handleCopy} className="text-white bg-blue-700 px-2 py-1 rounded whitespace-nowrap">
          {copied ? '✅ Copied' : '📋 Copy All'}
        </button>
        <button onClick={handleClear} className="text-white bg-red-800 px-2 py-1 rounded">🗑 Clear</button>
        <button onClick={refresh} className="text-white bg-gray-700 px-2 py-1 rounded">↻</button>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {filtered.length === 0 && (
          <div className="text-gray-500 text-center mt-8">No logs yet</div>
        )}
        {filtered.map((e, i) => (
          <div key={i} className="flex gap-2 leading-5">
            <span className="text-gray-600 shrink-0">{e.ts.slice(11, 19)}</span>
            <span className={`shrink-0 w-12 ${LEVEL_COLORS[e.level] ?? 'text-white'}`}>[{e.tag}]</span>
            <span className="text-gray-200 break-all">{e.msg}</span>
          </div>
        ))}
      </div>

      <div className="p-2 bg-gray-900 border-t border-gray-700 text-gray-500">
        {filtered.length} entries {filter && `(filtered from ${entries.length})`}
      </div>
    </div>
  );
}
