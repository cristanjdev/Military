<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Models\FirearmEquipment;
use App\Models\GpsLog;
use App\Models\MaintenanceRecord;
use App\Models\Transaction;
use Barryvdh\DomPDF\Facade\Pdf;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

class ReportController extends Controller
{
    public function inventory(Request $request)
    {
        $rows = FirearmEquipment::with('category', 'currentLocation')->get()
            ->map(fn($f) => [
                'serial_number' => $f->serial_number,
                'model'         => $f->model,
                'manufacturer'  => $f->manufacturer,
                'caliber'       => $f->caliber,
                'category'      => optional($f->category)->category_name,
                'condition'     => $f->condition_label,
                'status'        => $f->availability_label,
                'location'      => optional($f->currentLocation)->location_name,
                'acquisition'   => optional($f->acquisition_date)->format('Y-m-d'),
                'cost_php'      => $f->acquisition_cost,
            ])->values();

        return $this->respond($request, $rows, 'inventory_report', [
            'title' => 'Inventory Report',
            'columns' => array_keys($rows->first() ?? ['serial_number'=>null]),
            'money'   => ['cost_php'],
        ]);
    }

    public function transactions(Request $request)
    {
        $rows = Transaction::with(['firearm', 'user', 'authorizer'])
            ->when($request->filled('from'), fn($q) => $q->where('checkout_at', '>=', $request->date('from')))
            ->when($request->filled('to'),   fn($q) => $q->where('checkout_at', '<=', $request->date('to')))
            ->latest('checkout_at')->get()
            ->map(fn($t) => [
                'transaction_id' => $t->transaction_id,
                'firearm'        => optional($t->firearm)->serial_number,
                'model'          => optional($t->firearm)->model,
                'issued_to'      => optional($t->user)->fullName(),
                'authorized_by'  => optional($t->authorizer)->fullName(),
                'checkout_at'    => optional($t->checkout_at)->format('Y-m-d H:i'),
                'expected'       => optional($t->expected_return_at)->format('Y-m-d H:i'),
                'returned'       => optional($t->actual_return_at)->format('Y-m-d H:i'),
                'status'         => $t->status,
                'purpose'        => $t->purposeLabel(),
            ])->values();

        return $this->respond($request, $rows, 'issuance_report', [
            'title'   => 'Firearm Issuance / Return Report',
            'columns' => array_keys($rows->first() ?? ['transaction_id'=>null]),
        ]);
    }

    public function audit(Request $request)
    {
        $rows = AuditLog::with('user')
            ->when($request->filled('from'), fn($q) => $q->where('created_at', '>=', $request->date('from')))
            ->when($request->filled('to'),   fn($q) => $q->where('created_at', '<=', $request->date('to')))
            ->latest('created_at')->get()
            ->map(fn($a) => [
                'log_id'      => $a->log_id,
                'created_at'  => $a->created_at->format('Y-m-d H:i:s'),
                'user'        => optional($a->user)->username ?? 'system',
                'role'        => $a->role,
                'action'      => $a->action,
                'description' => $a->description,
                'ip'          => $a->ip_address,
            ])->values();

        return $this->respond($request, $rows, 'audit_report', [
            'title'   => 'Audit Trail Report',
            'columns' => array_keys($rows->first() ?? ['log_id'=>null]),
        ]);
    }

    public function maintenance(Request $request)
    {
        $rows = MaintenanceRecord::with(['firearm', 'technician'])->latest('maintenance_date')->get()
            ->map(fn($m) => [
                'maintenance_id' => $m->maintenance_id,
                'firearm'        => optional($m->firearm)->serial_number,
                'type'           => $m->maintenance_type,
                'description'    => $m->description,
                'status'         => $m->resultLabel(),
                'date'           => $m->maintenance_date->format('Y-m-d'),
                'next'           => optional($m->next_schedule)->format('Y-m-d'),
                'technician'     => optional($m->technician)->fullName(),
                'cost'           => $m->cost,
            ])->values();

        return $this->respond($request, $rows, 'maintenance_report', [
            'title'   => 'Maintenance Report',
            'columns' => array_keys($rows->first() ?? ['maintenance_id'=>null]),
            'money'   => ['cost'],
        ]);
    }

    public function gpsHistory(Request $request, int $equipmentId)
    {
        $rows = GpsLog::where('equipment_id', $equipmentId)
            ->when($request->filled('from'), fn($q) => $q->where('captured_at', '>=', $request->date('from')))
            ->when($request->filled('to'),   fn($q) => $q->where('captured_at', '<=', $request->date('to')))
            ->latest('captured_at')->limit(5000)->get()
            ->map(fn($g) => [
                'gps_log_id'  => $g->gps_log_id,
                'captured_at' => $g->captured_at->format('Y-m-d H:i:s'),
                'latitude'    => $g->latitude,
                'longitude'   => $g->longitude,
                'accuracy_m'  => $g->accuracy_meters,
                'speed_mps'   => $g->speed_mps,
                'inside_geo'  => $g->is_inside_geofence ? 'YES' : 'NO',
            ])->values();

        return $this->respond($request, $rows, "gps_history_{$equipmentId}", [
            'title'   => "GPS Movement History — Firearm #{$equipmentId}",
            'columns' => array_keys($rows->first() ?? ['gps_log_id'=>null]),
        ]);
    }

    /**
     * Personnel Assignment Report — who has what, and history.
     */
    public function personnelAssignment(Request $request)
    {
        $rows = Transaction::with(['firearm.category', 'user', 'authorizer'])
            ->latest('checkout_at')->get()
            ->map(fn($t) => [
                'personnel'      => optional($t->user)->fullName(),
                'rank'           => optional($t->user)->rank,
                'firearm'        => optional($t->firearm)->serial_number,
                'model'          => optional($t->firearm)->model,
                'category'       => optional($t->firearm?->category)->category_name,
                'checkout_at'    => optional($t->checkout_at)->format('Y-m-d H:i'),
                'returned_at'    => optional($t->actual_return_at)->format('Y-m-d H:i'),
                'status'         => $t->status,
                'purpose'        => $t->purposeLabel(),
                'authorized_by'  => optional($t->authorizer)->fullName(),
            ])->values();

        return $this->respond($request, $rows, 'personnel_assignment_report', [
            'title'   => 'Personnel Assignment Report',
            'columns' => array_keys($rows->first() ?? ['personnel'=>null]),
        ]);
    }

    /**
     * Security Incident Report — failed logins, access denials, geofence violations.
     */
    public function securityIncidents(Request $request)
    {
        $securityActions = ['failed_login', 'access_denied', 'account_locked', 'gps_signature_invalid'];

        $auditRows = AuditLog::with('user')
            ->whereIn('action', $securityActions)
            ->when($request->filled('from'), fn($q) => $q->where('created_at', '>=', $request->date('from')))
            ->when($request->filled('to'),   fn($q) => $q->where('created_at', '<=', $request->date('to')))
            ->latest('created_at')->limit(2000)->get()
            ->map(fn($a) => [
                'timestamp'   => $a->created_at->format('Y-m-d H:i:s'),
                'type'        => $a->action,
                'user'        => optional($a->user)->username ?? 'unknown',
                'role'        => $a->role ?? '—',
                'description' => $a->description,
                'ip_address'  => $a->ip_address,
                'firearm'     => $a->equipment_id ? "#{$a->equipment_id}" : '—',
            ])->values();

        // Also include geofence and trip security alerts. Each alert is stored once per recipient,
        // so keep one row per alert.
        $geoViolations = \App\Models\Notification::whereIn('type', [
                'geofence_violation', 'premature_departure', 'off_route', 'camp_exit_after_return',
            ])
            ->when($request->filled('from'), fn($q) => $q->where('created_at', '>=', $request->date('from')))
            ->when($request->filled('to'),   fn($q) => $q->where('created_at', '<=', $request->date('to')))
            ->latest('created_at')->limit(2000)->get()
            ->unique(fn($n) => $n->type . '|' . $n->created_at->format('Y-m-d H:i:s') . '|' . $n->message)
            ->take(500)
            ->map(fn($n) => [
                'timestamp'   => $n->created_at->format('Y-m-d H:i:s'),
                'type'        => $n->type,
                'user'        => '—',
                'role'        => '—',
                'description' => $n->message,
                'ip_address'  => '—',
                'firearm'     => $n->equipment_id ? "#{$n->equipment_id}" : '—',
            ])->values();

        $rows = $auditRows->merge($geoViolations)->sortByDesc('timestamp')->values();

        return $this->respond($request, $rows, 'security_incidents_report', [
            'title'   => 'Security Incident Report',
            'columns' => array_keys($rows->first() ?? ['timestamp'=>null]),
        ]);
    }

    /* --------------------------------------------------------------------- */

    protected function respond(Request $request, $rows, string $name, array $meta)
    {
        $format = strtolower((string) $request->query('format', 'json'));

        return match ($format) {
            'csv'   => $this->csv($rows, $name, $meta['columns']),
            'xlsx'  => $this->xlsx($rows, $name, $meta),
            'pdf'   => $this->pdf($request, $rows, $name, $meta),
            default => response()->json(['title' => $meta['title'], 'rows' => $rows]),
        };
    }

    protected function csv($rows, string $name, array $cols): StreamedResponse
    {
        $headers = [
            'Content-Type'        => 'text/csv',
            'Content-Disposition' => "attachment; filename=\"{$name}_" . now()->format('Ymd_His') . '.csv"',
        ];

        return response()->stream(function () use ($rows, $cols) {
            $out = fopen('php://output', 'w');
            fputcsv($out, $cols);
            foreach ($rows as $row) {
                fputcsv($out, array_map(fn($c) => $row[$c] ?? '', $cols));
            }
            fclose($out);
        }, 200, $headers);
    }

    protected function xlsx($rows, string $name, array $meta): StreamedResponse
    {
        $filename = "{$name}_" . now()->format('Ymd_His') . '.xlsx';

        return response()->streamDownload(function () use ($rows, $meta) {
            $options = new \OpenSpout\Writer\XLSX\Options();
            $writer = new \OpenSpout\Writer\XLSX\Writer($options);
            $writer->openToFile('php://output');

            // Header row
            $headerRow = \OpenSpout\Common\Entity\Row::fromValues($meta['columns']);
            $writer->addRow($headerRow);

            // Data rows
            foreach ($rows as $row) {
                $values = array_map(fn($c) => $row[$c] ?? '', $meta['columns']);
                $writer->addRow(\OpenSpout\Common\Entity\Row::fromValues($values));
            }

            $writer->close();
        }, $filename, [
            'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ]);
    }

    protected function pdf(Request $request, $rows, string $name, array $meta)
    {
        // Peso columns print as whole pesos and get a total row at the bottom.
        $money  = array_values(array_intersect($meta['money'] ?? [], $meta['columns']));
        $totals = [];
        foreach ($money as $c) {
            // Sum of the whole-peso amounts as printed, so the column adds up on paper.
            $totals[$c] = (int) $rows->sum(fn($r) => (int) round((float) ($r[$c] ?? 0)));
        }

        $logoPath = resource_path('images/10rcdg-logo.png');
        $logo = is_file($logoPath) ? 'data:image/png;base64,' . base64_encode(file_get_contents($logoPath)) : null;

        $pdf = Pdf::loadView('reports.generic', [
            'title'       => $meta['title'],
            'columns'     => $meta['columns'],
            'rows'        => $rows,
            'money'       => $money,
            'totals'      => $totals,
            'logo'        => $logo,
            'preparedBy'  => optional($request->user())->fullName(),
            'generatedAt' => now()->format('Y-m-d H:i:s'),
        ])->setPaper('a4', 'landscape');

        if ($request->query('disposition') === 'inline' || $request->boolean('inline')) {
            return $pdf->stream("{$name}_" . now()->format('Ymd_His') . '.pdf');
        }

        return $pdf->download("{$name}_" . now()->format('Ymd_His') . '.pdf');
    }
}
