<?php

namespace App\Http\Controllers;

use App\Models\FirearmEquipment;
use App\Models\MaintenanceRecord;
use App\Models\Notification;
use App\Models\RepairRequest;
use App\Models\Role;
use App\Services\AuditLogger;
use App\Services\MaintenanceOutcome;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Repair approval (defense feedback, 2026-11). Each step belongs to one role and keeps its date:
 *
 *   1. Armory Custodian reports the damaged firearm to the S4 Officer        (report)
 *   2. S4 Officer enters the request and forwards it to the Command Officer  (forward)
 *   3. Command Officer approves or rejects                                    (decide)
 *   4. S4 Officer reports the decision back to the Custodian                  (inform)
 *   5. Custodian sends the firearm for repair and names who received it       (send)
 *   6. Custodian records its return from maintenance; only now does the
 *      firearm's status change                                                (complete)
 */
class RepairRequestController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $q = RepairRequest::with(RepairRequest::withPeople())
            ->when($request->filled('equipment_id'), fn($qq) => $qq->where('equipment_id', $request->integer('equipment_id')))
            ->when($request->string('status')->value() === 'open', fn($qq) => $qq->whereIn('status', RepairRequest::OPEN_STATUSES))
            ->when($request->filled('status') && $request->string('status')->value() !== 'open',
                fn($qq) => $qq->where('status', $request->string('status')))
            ->latest('reported_at')
            ->latest('repair_id');

        return response()->json($q->paginate($request->integer('per_page', 20)));
    }

    public function show(int $id): JsonResponse
    {
        return response()->json(RepairRequest::with(RepairRequest::withPeople())->findOrFail($id));
    }

    /** 1. The Custodian reports a damaged firearm to the S4 Officer. */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'equipment_id' => ['required', 'integer', 'exists:firearm_equipment,equipment_id'],
            'problem'      => ['required', 'string', 'max:500'],
            'damaged_at'   => ['required', 'date', 'before_or_equal:today'],
        ]);

        return DB::transaction(function () use ($request, $data) {
            $firearm = FirearmEquipment::lockForUpdate()->findOrFail($data['equipment_id']);

            if (in_array((int) $firearm->availability_status, [FirearmEquipment::STATUS_CHECKED_OUT, FirearmEquipment::STATUS_OVERDUE], true)) {
                return response()->json(['message' => "{$firearm->serial_number} is still issued. Receive it back first, then report it for repair."], 409);
            }
            $open = RepairRequest::where('equipment_id', $firearm->equipment_id)->whereIn('status', RepairRequest::OPEN_STATUSES)->first();
            if ($open) {
                return response()->json(['message' => "{$firearm->serial_number} already has an open repair request (#{$open->repair_id}, {$open->status_label})."], 409);
            }

            $repair = RepairRequest::create($data + [
                'status'      => RepairRequest::STATUS_REPORTED,
                'reported_by' => $request->user()->user_id,
                'reported_at' => now(),
            ]);

            $this->log($request, $repair, 'repair_reported', "Reported {$firearm->serial_number} for repair: {$repair->problem}");
            Notification::notifyRoles([
                'type'     => 'repair_reported',
                'severity' => Notification::SEVERITY_WARNING,
                'title'    => 'Firearm Reported for Repair',
                'message'  => "{$request->user()->fullName()} reports that {$firearm->serial_number} needs repair: {$repair->problem}. Forward it to the Command Officer for approval.",
                'equipment_id' => $firearm->equipment_id,
                'payload'  => ['repair_id' => $repair->repair_id],
            ], [Role::S4_OFFICER]);

            return response()->json($this->fresh($repair), 201);
        });
    }

    /** 2. The S4 Officer enters the request and forwards it to the Command Officer. */
    public function forward(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'estimated_cost' => ['nullable', 'integer', 'min:0'],
            's4_notes'       => ['nullable', 'string', 'max:500'],
        ]);

        return $this->step($id, RepairRequest::STATUS_REPORTED, function (RepairRequest $repair) use ($request, $data) {
            $repair->update($data + [
                'status'       => RepairRequest::STATUS_FORWARDED,
                'forwarded_by' => $request->user()->user_id,
                'forwarded_at' => now(),
            ]);

            $serial = $repair->firearm->serial_number;
            $this->log($request, $repair, 'repair_forwarded', "Forwarded the repair of {$serial} to the Command Officer");
            Notification::notifyRoles([
                'type'     => 'repair_forwarded',
                'severity' => Notification::SEVERITY_INFO,
                'title'    => 'Repair Waiting for Your Approval',
                'message'  => sprintf('%s asks to repair %s: %s%s.', $request->user()->fullName(), $serial, $repair->problem,
                    $repair->estimated_cost !== null ? sprintf(' (estimated PHP %s)', number_format($repair->estimated_cost)) : ''),
                'equipment_id' => $repair->equipment_id,
                'payload'  => ['repair_id' => $repair->repair_id],
            ], [Role::COMMAND_OFFICER]);
        });
    }

    /** 3. The Command Officer approves or rejects. */
    public function decide(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'decision' => ['required', 'in:' . RepairRequest::STATUS_APPROVED . ',' . RepairRequest::STATUS_REJECTED],
            'note'     => ['nullable', 'string', 'max:500'],
        ]);

        return $this->step($id, RepairRequest::STATUS_FORWARDED, function (RepairRequest $repair) use ($request, $data) {
            $repair->update([
                'status'        => $data['decision'],
                'decided_by'    => $request->user()->user_id,
                'decided_at'    => now(),
                'decision_note' => $data['note'] ?? null,
            ]);

            $serial = $repair->firearm->serial_number;
            $approved = $data['decision'] === RepairRequest::STATUS_APPROVED;
            $this->log($request, $repair, "repair_{$data['decision']}", ($approved ? 'Approved' : 'Rejected') . " the repair of {$serial}",
                ['note' => $data['note'] ?? null]);
            Notification::create([
                'user_id'  => $repair->forwarded_by,
                'type'     => "repair_{$data['decision']}",
                'severity' => $approved ? Notification::SEVERITY_INFO : Notification::SEVERITY_WARNING,
                'title'    => $approved ? 'Repair Approved' : 'Repair Rejected',
                'message'  => "{$request->user()->fullName()} {$data['decision']} the repair of {$serial}."
                    . (! empty($data['note']) ? " Note: {$data['note']}" : '')
                    . ' Inform the Armory Custodian.',
                'equipment_id' => $repair->equipment_id,
                'payload'  => ['repair_id' => $repair->repair_id],
            ]);
        });
    }

    /** 4. The S4 Officer reports the Command Officer's decision back to the Custodian. */
    public function inform(Request $request, int $id): JsonResponse
    {
        return $this->step($id, [RepairRequest::STATUS_APPROVED, RepairRequest::STATUS_REJECTED], function (RepairRequest $repair) use ($request) {
            if ($repair->custodian_informed_at) {
                return response()->json(['message' => 'The Armory Custodian was already informed.'], 422);
            }
            $repair->update([
                'informed_by'           => $request->user()->user_id,
                'custodian_informed_at' => now(),
            ]);

            $serial = $repair->firearm->serial_number;
            $approved = $repair->status === RepairRequest::STATUS_APPROVED;
            $this->log($request, $repair, 'repair_custodian_informed', "Told the Armory Custodian the repair of {$serial} was {$repair->status}");
            Notification::notifyRoles([
                'type'     => $approved ? 'repair_cleared' : 'repair_rejected',
                'severity' => $approved ? Notification::SEVERITY_INFO : Notification::SEVERITY_WARNING,
                'title'    => $approved ? 'Repair Approved: Send the Firearm' : 'Repair Rejected',
                'message'  => $approved
                    ? "The Command Officer approved the repair of {$serial}. You can now send it for repair."
                    : "The Command Officer rejected the repair of {$serial}." . ($repair->decision_note ? " Note: {$repair->decision_note}" : ''),
                'equipment_id' => $repair->equipment_id,
                'payload'  => ['repair_id' => $repair->repair_id],
            ], [Role::ARMORY_CUSTODIAN], [$repair->reported_by]);
        });
    }

    /** 5. The Custodian sends the firearm for repair. It is tracked while it is away. */
    public function send(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'received_by'      => ['required', 'string', 'max:100'],
            'received_by_unit' => ['nullable', 'string', 'max:100'],
        ]);

        return $this->step($id, RepairRequest::STATUS_APPROVED, function (RepairRequest $repair) use ($request, $data) {
            if (! $repair->custodian_informed_at) {
                return response()->json(['message' => 'Wait for the S4 Officer to report the approval back to you.'], 422);
            }
            $firearm = FirearmEquipment::lockForUpdate()->findOrFail($repair->equipment_id);
            if (in_array((int) $firearm->availability_status, [FirearmEquipment::STATUS_CHECKED_OUT, FirearmEquipment::STATUS_OVERDUE], true)) {
                return response()->json(['message' => "{$firearm->serial_number} is issued. Receive it back first."], 409);
            }

            $repair->update($data + [
                'status'  => RepairRequest::STATUS_IN_REPAIR,
                'sent_by' => $request->user()->user_id,
                'sent_at' => now(),
            ]);
            $firearm->update(['availability_status' => FirearmEquipment::STATUS_MAINTENANCE]);

            $this->log($request, $repair, 'repair_sent', "Sent {$firearm->serial_number} for repair, received by {$data['received_by']}");
            Notification::notifyRoles([
                'type'     => 'repair_sent',
                'severity' => Notification::SEVERITY_INFO,
                'title'    => 'Firearm Sent for Repair',
                'message'  => "{$firearm->serial_number} was sent for repair, received by {$data['received_by']}"
                    . (! empty($data['received_by_unit']) ? " ({$data['received_by_unit']})" : '') . '.',
                'equipment_id' => $firearm->equipment_id,
                'payload'  => ['repair_id' => $repair->repair_id],
            ], [Role::COMMAND_OFFICER, Role::S4_OFFICER]);
        });
    }

    /** 6. Back from maintenance: the firearm's status changes only now. */
    public function complete(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'repaired_at'   => ['required', 'date', 'before_or_equal:today'],
            'result_status' => ['required', 'integer', 'in:' . implode(',', array_keys(MaintenanceRecord::RESULT_LABELS))],
            'cost'          => ['nullable', 'integer', 'min:0'],
            'work_done'     => ['required', 'string', 'max:500'],
            'next_schedule' => ['nullable', 'date', 'after:repaired_at'],
        ]);

        return $this->step($id, RepairRequest::STATUS_IN_REPAIR, function (RepairRequest $repair) use ($request, $data) {
            if ($repair->damaged_at && $data['repaired_at'] < $repair->damaged_at->toDateString()) {
                return response()->json([
                    'message' => 'The repair date cannot be before the date the firearm broke.',
                    'errors'  => ['repaired_at' => ['The repair date cannot be before the date the firearm broke.']],
                ], 422);
            }
            $firearm = FirearmEquipment::lockForUpdate()->findOrFail($repair->equipment_id);

            $record = MaintenanceRecord::create([
                'equipment_id'     => $firearm->equipment_id,
                'performed_by'     => $request->user()->user_id,
                'repaired_by'      => $repair->received_by,
                'description'      => $data['work_done'],
                'maintenance_date' => $data['repaired_at'],
                'next_schedule'    => $data['next_schedule'] ?? null,
                'maintenance_type' => 'Repair',
                'result_status'    => $data['result_status'],
                'cost'             => $data['cost'] ?? 0,
                'remarks'          => "Repair request #{$repair->repair_id}: {$repair->problem}",
            ]);

            $repair->update([
                'status'         => RepairRequest::STATUS_COMPLETED,
                'repaired_at'    => $data['repaired_at'],
                'returned_to'    => $request->user()->user_id,
                'returned_at'    => now(),
                'result_status'  => $data['result_status'],
                'cost'           => $data['cost'] ?? 0,
                'work_done'      => $data['work_done'],
                'maintenance_id' => $record->maintenance_id,
            ]);
            MaintenanceOutcome::apply($firearm, (int) $data['result_status'], $data['next_schedule'] ?? null);

            $result = $record->resultLabel();
            $this->log($request, $repair, 'repair_returned', "{$firearm->serial_number} came back from maintenance: {$result}",
                ['maintenance_id' => $record->maintenance_id, 'result_status' => $result]);
            Notification::notifyRoles([
                'type'     => 'repair_returned',
                'severity' => Notification::SEVERITY_INFO,
                'title'    => 'Firearm Back from Maintenance',
                'message'  => "{$firearm->serial_number} is back from maintenance ({$result}), received by {$request->user()->fullName()}.",
                'equipment_id' => $firearm->equipment_id,
                'payload'  => ['repair_id' => $repair->repair_id],
            ], [Role::COMMAND_OFFICER, Role::S4_OFFICER]);
        });
    }

    /**
     * Runs one step on a repair that must be in $from, inside a transaction, and answers with the
     * updated repair. The callback may return a response to refuse the step.
     */
    private function step(int $id, string|array $from, callable $apply): JsonResponse
    {
        return DB::transaction(function () use ($id, $from, $apply) {
            $repair = RepairRequest::with('firearm')->lockForUpdate()->findOrFail($id);
            if (! in_array($repair->status, (array) $from, true)) {
                return response()->json(['message' => "This repair request is already {$repair->status_label}."], 422);
            }
            $refused = $apply($repair);
            if ($refused instanceof JsonResponse) {
                return $refused;
            }
            return response()->json($this->fresh($repair));
        });
    }

    private function fresh(RepairRequest $repair): RepairRequest
    {
        return $repair->fresh(RepairRequest::withPeople());
    }

    private function log(Request $request, RepairRequest $repair, string $action, string $description, array $extra = []): void
    {
        AuditLogger::log($action, $description, $request->user(), equipmentId: $repair->equipment_id, request: $request,
            metadata: ['repair_id' => $repair->repair_id, 'status' => $repair->status] + $extra);
    }
}
