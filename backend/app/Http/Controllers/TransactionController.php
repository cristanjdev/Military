<?php

namespace App\Http\Controllers;

use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use App\Models\Notification;
use App\Models\RepairRequest;
use App\Models\Role;
use App\Models\Transaction;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\BiometricStepUp;
use App\Services\TripMonitor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TransactionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $isPersonnel = $request->user()->hasRole(Role::PERSONNEL);

        $q = Transaction::with(['firearm.category', 'user', 'authorizer', 'destination'])
            ->when($isPersonnel, fn($query) => $query->where('user_id', $request->user()->user_id))
            ->when($request->filled('status'), fn($qq) => $qq->where('status', $request->string('status')))
            ->when($request->filled('user_id'), fn($qq) => $qq->where('user_id', $request->integer('user_id')))
            ->when($request->filled('equipment_id'), fn($qq) => $qq->where('equipment_id', $request->integer('equipment_id')))
            // Free-text search: borrower name/rank/username, firearm serial/model, or "#12".
            ->when($request->string('search')->trim()->value(), function ($qq, $s) {
                $like = '%' . addcslashes($s, '%_\\') . '%';
                $qq->where(function ($w) use ($s, $like) {
                    $id = ltrim($s, '#');
                    if (ctype_digit($id)) {
                        $w->orWhere('transaction_id', (int) $id);
                    }
                    $w->orWhereHas('user', fn($u) => $u->where('first_name', 'like', $like)
                            ->orWhere('last_name', 'like', $like)
                            ->orWhere('username', 'like', $like)
                            ->orWhereRaw("CONCAT_WS(' ', `rank`, first_name, last_name) LIKE ?", [$like])
                            ->orWhereRaw("CONCAT_WS(' ', first_name, last_name) LIKE ?", [$like]))
                      ->orWhereHas('firearm', fn($f) => $f->where('serial_number', 'like', $like)
                            ->orWhere('model', 'like', $like));
                });
            });

        // Column sorting from the table headers; newest checkout first by default.
        $dir = $request->string('dir')->lower()->value() === 'asc' ? 'asc' : 'desc';
        match ($request->string('sort')->value()) {
            'transaction'     => $q->orderBy('transaction_id', $dir),
            'firearm'         => $q->orderBy(FirearmEquipment::select('serial_number')
                ->whereColumn('firearm_equipment.equipment_id', 'transactions.equipment_id'), $dir),
            'personnel'       => $q->orderBy(User::select('last_name')
                ->whereColumn('users.user_id', 'transactions.user_id'), $dir)
                ->orderBy(User::select('first_name')
                    ->whereColumn('users.user_id', 'transactions.user_id'), $dir),
            'purpose'         => $q->orderBy('purpose', $dir),
            'expected_return' => $q->orderBy('expected_return_at', $dir),
            'status'          => $q->orderBy('status', $dir),
            default           => $q->orderBy('checkout_at', $dir),
        };
        $q->orderBy('transaction_id', $dir);

        return response()->json($q->paginate($request->integer('per_page', 15)));
    }

    /**
     * Active personnel a firearm can be issued to: names only, for the issuance form. The
     * custodian who issues firearms has no access to User Management.
     */
    public function personnel(Request $request): JsonResponse
    {
        $people = User::where('status', User::STATUS_ACTIVE)
            ->whereHas('role', fn($q) => $q->where('role_name', Role::PERSONNEL))
            ->orderBy('last_name')
            ->get(['user_id', 'rank', 'first_name', 'last_name']);

        return response()->json(['data' => $people]);
    }

    public function show(Request $request, int $id): JsonResponse
    {
        $isPersonnel = $request->user()->hasRole(Role::PERSONNEL);
        $relations = ['firearm.category', 'user', 'authorizer', 'destination'];
        if (! $isPersonnel) {
            $relations[] = 'gpsLogs';
        }

        $transaction = Transaction::with($relations)
            ->when($isPersonnel, fn($query) => $query->where('user_id', $request->user()->user_id))
            ->findOrFail($id);

        return response()->json($transaction);
    }

    /**
     * ISSUANCE WORKFLOW (server side).
     * Caller (Armory Custodian, the only role that releases firearms) authorizes; the personnel must already be authenticated separately.
     */
    public function issue(Request $request): JsonResponse
    {
        $data = $request->validate([
            'equipment_id'      => ['required', 'exists:firearm_equipment,equipment_id'],
            'user_id'           => ['required', 'exists:users,user_id'],
            'expected_return_at'=> ['required', 'date', 'after:now'],
            // Issuance is for Training or Funeral only. Maintenance and inspection are
            // logged on the Maintenance page; 2/3/4 survive only on historical rows.
            'purpose'           => ['required', 'integer', 'in:' . Transaction::PURPOSE_TRAINING . ',' . Transaction::PURPOSE_FUNERAL],
            'condition_on_issue'=> ['required', 'integer', 'between:1,4'],
            'notes'             => ['nullable', 'string', 'max:500'],
            'gps_tracking_enabled' => ['sometimes', 'boolean'],
            // Where the firearm is going; TripMonitor follows it there and back.
            'destination_location_id' => ['required', 'integer', 'exists:gps_locations,location_id'],
        ]);
        if ($refused = $this->refuseCampDestination((int) $data['destination_location_id'])) {
            return $refused;
        }

        // Fresh fingerprint scan, bound to this firearm, when biometrics are required.
        if ($denied = BiometricStepUp::consume($request, 'issue', 'equipment:' . $data['equipment_id'])) {
            return $denied;
        }

        $authorizer = $request->user();

        return DB::transaction(function () use ($data, $authorizer, $request) {
            $firearm = FirearmEquipment::lockForUpdate()->findOrFail($data['equipment_id']);

            if ($firearm->availability_status !== FirearmEquipment::STATUS_AVAILABLE) {
                return response()->json([
                    'message' => 'Firearm is not available for issuance.',
                    'current_status' => $firearm->availability_label,
                ], 409);
            }

            // A firearm reported for repair stays in the armory until the repair is decided.
            $repair = RepairRequest::where('equipment_id', $firearm->equipment_id)
                ->whereIn('status', RepairRequest::OPEN_STATUSES)->first();
            if ($repair) {
                return response()->json([
                    'message' => "{$firearm->serial_number} is reported for repair (#{$repair->repair_id}, {$repair->status_label}) and cannot be issued.",
                    'current_status' => $repair->status_label,
                ], 409);
            }

            $issuee = User::findOrFail($data['user_id']);
            if ((int) $issuee->status !== User::STATUS_ACTIVE) {
                return response()->json(['message' => 'Recipient personnel is inactive.'], 422);
            }

            $tx = Transaction::create([
                'equipment_id'         => $firearm->equipment_id,
                'user_id'              => $issuee->user_id,
                'authorized_by'        => $authorizer->user_id,
                'checkout_at'          => now(),
                'expected_return_at'   => $data['expected_return_at'],
                'purpose'              => $data['purpose'],
                'status'               => Transaction::STATUS_ACTIVE,
                'condition_on_issue'   => $data['condition_on_issue'],
                'notes'                => $data['notes'] ?? null,
                'gps_tracking_enabled' => $data['gps_tracking_enabled'] ?? true,
                'destination_location_id' => $data['destination_location_id'],
                'trip_stage'           => Transaction::TRIP_AT_CAMP,
                'trip_place'           => TripMonitor::PLACE_CAMP,
            ]);

            $firearm->update(['availability_status' => FirearmEquipment::STATUS_CHECKED_OUT]);

            AuditLogger::log(
                action: 'issuance',
                description: "Issued {$firearm->serial_number} to {$issuee->fullName()}",
                user: $authorizer,
                equipmentId: $firearm->equipment_id,
                request: $request,
                metadata: ['transaction_id' => $tx->transaction_id, 'recipient_id' => $issuee->user_id,
                    'destination_location_id' => $tx->destination_location_id],
            );

            return response()->json($tx->fresh(['firearm', 'user', 'authorizer', 'destination']), 201);
        });
    }

    /**
     * Change an issuance's destination before the firearm gets there: the Armory Custodian and the
     * roles above it (Command Officer, Administrator). An issuance from before destinations existed
     * starts its trip here.
     */
    public function changeDestination(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'destination_location_id' => ['required', 'integer', 'exists:gps_locations,location_id'],
        ]);
        if ($refused = $this->refuseCampDestination((int) $data['destination_location_id'])) {
            return $refused;
        }

        return DB::transaction(function () use ($id, $data, $request) {
            $tx = Transaction::with(['firearm', 'destination'])->lockForUpdate()->findOrFail($id);

            if ($tx->status !== Transaction::STATUS_ACTIVE && $tx->status !== Transaction::STATUS_OVERDUE) {
                return response()->json(['message' => 'Transaction is not active.'], 409);
            }
            if ($tx->destination_location_id
                && ! in_array($tx->trip_stage, [Transaction::TRIP_AT_CAMP, Transaction::TRIP_OUTBOUND], true)) {
                return response()->json(['message' => 'The firearm has already reached its destination; the destination can no longer change.'], 409);
            }

            $before = optional($tx->destination)->location_name;
            $tx->update([
                'destination_location_id' => $data['destination_location_id'],
                'trip_stage'              => $tx->trip_stage ?? Transaction::TRIP_AT_CAMP,
                'trip_place'              => $tx->trip_place ?? TripMonitor::PLACE_CAMP,
            ]);
            $after = $tx->fresh('destination')->destination->location_name;

            AuditLogger::log(
                action: 'destination_change',
                description: "Destination of {$tx->firearm->serial_number} changed from " . ($before ?? 'none') . " to {$after}",
                user: $request->user(),
                equipmentId: $tx->equipment_id,
                request: $request,
                metadata: ['transaction_id' => $tx->transaction_id, 'from' => $before, 'to' => $after],
            );

            return response()->json($tx->fresh(['firearm', 'user', 'authorizer', 'destination']));
        });
    }

    /** A destination is somewhere the firearm travels to, so never a camp or armory zone. */
    private function refuseCampDestination(int $locationId): ?JsonResponse
    {
        if (GpsLocation::findOrFail($locationId)->isCamp()) {
            return response()->json([
                'message' => 'The destination must be a zone outside the camp.',
                'errors'  => ['destination_location_id' => ['The destination must be a zone outside the camp.']],
            ], 422);
        }
        return null;
    }

    public function returnFirearm(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'condition_on_return' => ['required', 'integer', 'between:1,4'],
            'notes'               => ['nullable', 'string', 'max:500'],
        ]);

        // Fresh fingerprint scan, bound to this transaction, when biometrics are required.
        if ($denied = BiometricStepUp::consume($request, 'return', 'transaction:' . $id)) {
            return $denied;
        }

        return DB::transaction(function () use ($id, $data, $request) {
            $tx = Transaction::with('firearm')->lockForUpdate()->findOrFail($id);

            if ($tx->status !== Transaction::STATUS_ACTIVE && $tx->status !== Transaction::STATUS_OVERDUE) {
                return response()->json(['message' => 'Transaction is not active.'], 409);
            }

            $tx->update([
                'actual_return_at'    => now(),
                'condition_on_return' => $data['condition_on_return'],
                'status'              => Transaction::STATUS_RETURNED,
                'gps_tracking_enabled'=> false,
                'notes'               => trim(($tx->notes ? $tx->notes."\n" : '') . ($data['notes'] ?? '')),
            ]);

            $newStatus = (int) $data['condition_on_return'] >= FirearmEquipment::CONDITION_FAIR
                ? FirearmEquipment::STATUS_MAINTENANCE
                : FirearmEquipment::STATUS_AVAILABLE;

            $tx->firearm->update([
                'availability_status' => $newStatus,
                'condition_status'    => $data['condition_on_return'],
            ]);

            AuditLogger::log(
                action: 'return',
                description: "Returned {$tx->firearm->serial_number} (condition {$data['condition_on_return']})",
                user: $request->user(),
                equipmentId: $tx->equipment_id,
                request: $request,
                metadata: ['transaction_id' => $tx->transaction_id],
            );

            return response()->json($tx->fresh(['firearm', 'user', 'authorizer']));
        });
    }

    /**
     * Mark overdue transactions and emit notifications. Intended to be called by a scheduled job.
     */
    public function sweepOverdue(Request $request): JsonResponse
    {
        $now = now();
        $overdue = Transaction::where('status', Transaction::STATUS_ACTIVE)
            ->where('expected_return_at', '<', $now)
            ->get();

        foreach ($overdue as $tx) {
            $tx->update(['status' => Transaction::STATUS_OVERDUE]);
            $tx->firearm?->update(['availability_status' => FirearmEquipment::STATUS_OVERDUE]);

            Notification::create([
                'user_id'      => $tx->authorized_by,
                'equipment_id' => $tx->equipment_id,
                'type'         => 'overdue_return',
                'severity'     => Notification::SEVERITY_WARNING,
                'title'        => 'Firearm Overdue',
                'message'      => "Firearm {$tx->firearm?->serial_number} is overdue for return.",
                'payload'      => ['transaction_id' => $tx->transaction_id],
            ]);

            AuditLogger::log(
                action: 'overdue_flagged',
                description: "Transaction {$tx->transaction_id} flagged overdue",
                user: $request->user(),
                equipmentId: $tx->equipment_id,
                request: $request,
            );
        }

        return response()->json(['flagged' => $overdue->count()]);
    }
}
