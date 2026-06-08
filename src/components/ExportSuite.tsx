import {
  FileSpreadsheet, FileText, Share2, Printer,
} from 'lucide-react';
import { AttendanceLog } from '../types';
import { formatDuration } from '../utils/storage';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface ExportSuiteProps {
  logs: AttendanceLog[];
  weeklyMinutes: number;
}

export default function ExportSuite({ logs, weeklyMinutes }: ExportSuiteProps) {
  const exportCSV = () => {
    const header = 'Date,Profile,Check-In,Check-Out,Duration (min),Status,Attended\n';
    const rows = logs.map(l => {
      const ci = new Date(l.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const co = l.checkOut ? new Date(l.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--';
      return `${l.date},"${l.profileName}",${ci},${co},${l.duration ?? '--'},${l.status},${l.attended ? 'Yes' : 'No'}`;
    }).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.setTextColor(30, 41, 59);
    doc.text('Attendance Report', 14, 22);

    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
    doc.text(`Weekly Total: ${formatDuration(weeklyMinutes)}`, 14, 36);

    const tableData = logs.map(l => [
      l.date,
      l.profileName,
      new Date(l.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      l.checkOut ? new Date(l.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active',
      formatDuration(l.duration),
      l.status === 'auto' ? 'Auto' : 'Manual',
      l.attended ? 'Yes' : 'No',
    ]);

    autoTable(doc, {
      head: [['Date', 'Profile', 'Check-In', 'Check-Out', 'Duration', 'Status', 'Attended']],
      body: tableData,
      startY: 42,
      styles: { fontSize: 7, cellPadding: 3 },
      headStyles: { fillColor: [79, 70, 229], textColor: [255, 255, 255] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 10, right: 10 },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column?.index === 6 && data.cell) {
          const val = tableData[data.row?.index ?? 0]?.[6];
          if (val === 'Yes') data.cell.styles.fillColor = [34, 197, 94];
          else if (val === 'No') data.cell.styles.fillColor = [239, 68, 68];
        }
      },
    });

    doc.save(`attendance_${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  const shareWhatsApp = () => {
    const latestLog = logs[logs.length - 1];
    if (!latestLog) return;
    const ci = new Date(latestLog.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const co = latestLog.checkOut
      ? new Date(latestLog.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'Active';
    const text = encodeURIComponent(
      `Attendance Report\n` +
      `Date: ${latestLog.date}\n` +
      `Profile: ${latestLog.profileName}\n` +
      `Check-In: ${ci}\n` +
      `Check-Out: ${co}\n` +
      `Duration: ${formatDuration(latestLog.duration)}\n` +
      `Attended: ${latestLog.attended ? 'Yes' : 'No'}\n` +
      `Weekly Total: ${formatDuration(weeklyMinutes)}\n` +
      `Status: ${latestLog.status === 'auto' ? 'Auto-Logged' : 'Manual'}`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const shareFullReport = () => {
    const lines = logs.map(l => {
      const ci = new Date(l.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const co = l.checkOut ? new Date(l.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active';
      return `${l.date} | ${l.profileName} | ${ci}-${co} | ${formatDuration(l.duration)} | ${l.attended ? 'Present' : 'Absent'} | ${l.status}`;
    });
    const text = encodeURIComponent(
      `Attendance Report - Total Duration: ${formatDuration(weeklyMinutes)}\n` +
      `${'='.repeat(40)}\n` +
      lines.join('\n')
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-heading">Export & Share</h2>
        <p className="text-sm text-sub">Download or share your attendance data</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* CSV Export */}
        <button
          onClick={exportCSV}
          disabled={logs.length === 0}
          className="card p-5 hover:shadow-md transition-all text-left group disabled:opacity-40 active:scale-[0.98]"
        >
          <div className="h-12 w-12 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3 group-hover:bg-emerald-200 transition dark:bg-emerald-950 dark:text-emerald-400 dark:group-hover:bg-emerald-900">
            <FileSpreadsheet className="h-6 w-6" />
          </div>
          <h3 className="font-semibold text-heading">Export to CSV</h3>
          <p className="text-sm text-sub mt-1">Download a spreadsheet file of all attendance logs</p>
        </button>

        {/* PDF Export */}
        <button
          onClick={exportPDF}
          disabled={logs.length === 0}
          className="card p-5 hover:shadow-md transition-all text-left group disabled:opacity-40 active:scale-[0.98]"
        >
          <div className="h-12 w-12 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center mb-3 group-hover:bg-rose-200 transition dark:bg-rose-950 dark:text-rose-400 dark:group-hover:bg-rose-900">
            <FileText className="h-6 w-6" />
          </div>
          <h3 className="font-semibold text-heading">Export to PDF</h3>
          <p className="text-sm text-sub mt-1">Generate a printable attendance summary report</p>
        </button>

        {/* WhatsApp Latest */}
        <button
          onClick={shareWhatsApp}
          disabled={logs.length === 0}
          className="card p-5 hover:shadow-md transition-all text-left group disabled:opacity-40 active:scale-[0.98]"
        >
          <div className="h-12 w-12 rounded-xl bg-green-100 text-green-600 flex items-center justify-center mb-3 group-hover:bg-green-200 transition dark:bg-green-950 dark:text-green-400 dark:group-hover:bg-green-900">
            <Share2 className="h-6 w-6" />
          </div>
          <h3 className="font-semibold text-heading">Share Latest Entry</h3>
          <p className="text-sm text-sub mt-1">Send your latest attendance record via WhatsApp</p>
        </button>

        {/* WhatsApp Full Report */}
        <button
          onClick={shareFullReport}
          disabled={logs.length === 0}
          className="card p-5 hover:shadow-md transition-all text-left group disabled:opacity-40 active:scale-[0.98]"
        >
          <div className="h-12 w-12 rounded-xl bg-teal-100 text-teal-600 flex items-center justify-center mb-3 group-hover:bg-teal-200 transition dark:bg-teal-950 dark:text-teal-400 dark:group-hover:bg-teal-900">
            <Printer className="h-6 w-6" />
          </div>
          <h3 className="font-semibold text-heading">Share Full Report</h3>
          <p className="text-sm text-sub mt-1">Send a complete attendance summary via WhatsApp</p>
        </button>
      </div>

      {logs.length === 0 && (
        <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 text-amber-700 text-sm dark:bg-amber-950 dark:border-amber-800 dark:text-amber-300">
          No attendance records to export yet. Check in to a location profile to start logging.
        </div>
      )}
    </div>
  );
}
