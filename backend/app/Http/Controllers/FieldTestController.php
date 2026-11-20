<?php

namespace App\Http\Controllers;

use App\Models\FieldTest;
use App\Models\FieldTestMark;
use App\Models\Transaction;
use App\Services\AuditLogger;
use App\Services\FieldTestReport;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Field tests of the tracker (mock defense feedback, 2026-11): measured numbers for the
 * Metric | Target | Actual table. See FieldTestReport.
 */
class FieldTestController extends Controller
{
    /** Opening / closing taps of each test step, and the step a tap belongs in. */
    private const PAIRS = [
        FieldTestMark::SPOT_START  => FieldTestMark::SPOT_END,
        FieldTestMark::RANGE_START => FieldTestMark::RANGE_END,
        FieldTestMark::ZONE_START  => FieldTestMark::ZONE_END,
        FieldTestMark::HOTSPOT_OFF => FieldTestMark::HOTSPOT_ON,
    ];

    public function index(): JsonResponse
    {
        $tests = FieldTest::with(['firearm:equipment_id,serial_number,model', 'starter:user_id,rank,first_name,last_name'])
            ->latest('started_at')
            ->limit(30)
            ->get();

        // Firearms that can be tested now: issued with GPS tracking on.
        $firearms = Transaction::with(['firearm:equipment_id,serial_number,model', 'user:user_id,rank,first_name,last_name'])
            ->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->where('gps_tracking_enabled', true)
            ->latest('checkout_at')
            ->get()
            ->filter(fn($tx) => $tx->firearm)
            ->unique('equipment_id')
            ->map(fn($tx) => [
                'equipment_id'  => $tx->equipment_id,
                'serial_number' => $tx->firearm->serial_number,
                'model'         => $tx->firearm->model,
                'holder'        => $tx->user?->fullName(),
            ])
            ->values();

        return response()->json(['tests' => $tests, 'firearms' => $firearms]);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'equipment_id' => ['required', 'integer', 'exists:firearm_equipment,equipment_id'],
        ]);

        $issued = Transaction::where('equipment_id', $data['equipment_id'])
            ->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->where('gps_tracking_enabled', true)
            ->exists();
        if (! $issued) {
            return response()->json(['message' => 'Issue this firearm with GPS tracking on first: the tracker only sends positions while it is issued.'], 422);
        }

        // One running test per firearm: starting again returns the one already running.
        $open = FieldTest::where('equipment_id', $data['equipment_id'])->whereNull('ended_at')->first();
        if ($open) {
            return response()->json($this->payload($open));
        }

        $test = FieldTest::create([
            'equipment_id' => $data['equipment_id'],
            'started_by'   => $request->user()->user_id,
            'started_at'   => now(),
        ]);

        AuditLogger::log('field_test_start', "Started field test #{$test->field_test_id}", $request->user(),
            equipmentId: $test->equipment_id, request: $request);

        return response()->json($this->payload($test), 201);
    }

    public function show(int $id): JsonResponse
    {
        return response()->json($this->payload(FieldTest::findOrFail($id)));
    }

    /** The marked spot. It can be corrected after the test too; the numbers are worked out again. */
    public function reference(Request $request, int $id): JsonResponse
    {
        $test = FieldTest::findOrFail($id);
        $data = $request->validate([
            'latitude'  => ['required', 'numeric', 'between:-90,90'],
            'longitude' => ['required', 'numeric', 'between:-180,180'],
        ]);

        $test->update(['reference_latitude' => $data['latitude'], 'reference_longitude' => $data['longitude']]);

        return response()->json($this->payload($test));
    }

    public function mark(Request $request, int $id): JsonResponse
    {
        $test = FieldTest::findOrFail($id);
        $data = $request->validate(['kind' => ['required', Rule::in(FieldTestMark::KINDS)]]);
        $kind = $data['kind'];

        if (! $test->isOpen()) {
            return response()->json(['message' => 'This test has ended.'], 422);
        }

        $open = $this->openSteps($test);

        if (in_array($kind, [FieldTestMark::SPOT_START, FieldTestMark::RANGE_START], true) && ! $test->hasReference()) {
            return response()->json(['message' => 'Set the marked spot first.'], 422);
        }
        if (isset(self::PAIRS[$kind]) && in_array($kind, $open, true)) {
            return response()->json(['message' => 'This step is already running.'], 422);
        }
        $opener = array_search($kind, self::PAIRS, true);
        if ($opener !== false && ! in_array($opener, $open, true)) {
            return response()->json(['message' => 'This step is not running.'], 422);
        }
        if (in_array($kind, [FieldTestMark::ENTERED, FieldTestMark::LEFT], true) && ! in_array(FieldTestMark::ZONE_START, $open, true)) {
            return response()->json(['message' => 'Start the zone walks first.'], 422);
        }

        FieldTestMark::create([
            'field_test_id' => $test->field_test_id,
            'kind'          => $kind,
            'occurred_at'   => now(),
            'created_by'    => $request->user()->user_id,
        ]);

        return response()->json($this->payload($test->fresh()));
    }

    /** Undo the last tap, for a mistap. */
    public function undo(int $id): JsonResponse
    {
        $test = FieldTest::findOrFail($id);
        if (! $test->isOpen()) {
            return response()->json(['message' => 'This test has ended.'], 422);
        }

        $last = $test->marks()->reorder()->latest('occurred_at')->latest('mark_id')->first();
        if (! $last) {
            return response()->json(['message' => 'Nothing to undo.'], 422);
        }
        $last->delete();

        return response()->json($this->payload($test->fresh()));
    }

    public function finish(Request $request, int $id): JsonResponse
    {
        $test = FieldTest::findOrFail($id);
        if ($test->isOpen()) {
            $test->update(['ended_at' => now()]);
            AuditLogger::log('field_test_finish', "Finished field test #{$test->field_test_id}", $request->user(),
                equipmentId: $test->equipment_id, request: $request);
        }

        return response()->json($this->payload($test->fresh()));
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $test = FieldTest::findOrFail($id);
        $test->delete();
        AuditLogger::log('field_test_delete', "Deleted field test #{$id}", $request->user(),
            equipmentId: $test->equipment_id, request: $request);

        return response()->json(['message' => 'Test deleted.']);
    }

    /** Opening taps whose closing tap has not come yet. */
    private function openSteps(FieldTest $test): array
    {
        $open = [];
        foreach ($test->marks as $m) {
            if (isset(self::PAIRS[$m->kind])) {
                $open[$m->kind] = true;
            } elseif (($opener = array_search($m->kind, self::PAIRS, true)) !== false) {
                unset($open[$opener]);
            }
        }
        return array_keys($open);
    }

    private function payload(FieldTest $test): array
    {
        $test->loadMissing(['firearm:equipment_id,serial_number,model', 'starter:user_id,rank,first_name,last_name', 'marks']);

        return [
            'test'   => $test,
            'report' => FieldTestReport::build($test),
        ];
    }
}
