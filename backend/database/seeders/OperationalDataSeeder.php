<?php

namespace Database\Seeders;

use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use App\Models\GpsLog;
use App\Models\MaintenanceRecord;
use App\Models\Notification;
use App\Models\Transaction;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * Seeds a realistic operating history so dashboards, reports and the live map
 * have something meaningful to show: closed issuances, firearms currently in
 * the field with GPS breadcrumbs, one overdue item, and a maintenance log.
 *
 * Safe to re-run: it bails out if transactions already exist, so it can never
 * duplicate history or overwrite real operational records.
 */
class OperationalDataSeeder extends Seeder
{
    public function run(): void
    {
        if (Transaction::exists()) {
            $this->command?->info('Operational data already present. Skipping.');

            return;
        }

        $firearms = FirearmEquipment::orderBy('equipment_id')->get();

        if ($firearms->count() < 4) {
            $this->command?->warn('Not enough inventory to seed operations. Run FirearmSeeder first.');

            return;
        }

        $custodian = User::where('username', 'armory.custodian')->first();
        $s4        = User::where('username', 's4.officer')->first();
        $borrowers = User::whereIn('username', ['pvt.dela.cruz', 'cpl.santos', 'cmd.officer'])->get();

        if (! $custodian || ! $s4 || $borrowers->isEmpty()) {
            $this->command?->warn('Baseline accounts missing. Run UserSeeder first.');

            return;
        }

        $armory = GpsLocation::where('is_armory', true)->first();
        $range  = GpsLocation::where('location_name', 'Northern Mindanao Training Range')->first();
        $fences = GpsLocation::all();

        $this->seedClosedHistory($firearms, $borrowers, [$custodian, $s4]);
        $this->seedActiveIssuances($firearms, $borrowers, $custodian, $armory, $range, $fences);
        $this->seedMaintenance($firearms, $custodian);

        $this->command?->info(sprintf(
            'Seeded %d transactions, %d GPS logs, %d maintenance records.',
            Transaction::count(),
            GpsLog::count(),
            MaintenanceRecord::count()
        ));
    }

    /**
     * Completed issue/return cycles spread across the last two months.
     */
    private function seedClosedHistory($firearms, $borrowers, array $authorizers): void
    {
        $purposes = [
            Transaction::PURPOSE_TRAINING,
            Transaction::PURPOSE_FUNERAL,
        ];

        for ($i = 0; $i < 14; $i++) {
            $firearm  = $firearms[$i % $firearms->count()];
            $borrower = $borrowers[$i % $borrowers->count()];
            $issuer   = $authorizers[$i % count($authorizers)];

            $checkout = now()->subDays(60 - ($i * 4))->setTime(random_int(7, 10), random_int(0, 59));
            $due      = (clone $checkout)->addHours(random_int(6, 24));
            $returned = (clone $due)->subMinutes(random_int(10, 240));

            Transaction::create([
                'equipment_id'         => $firearm->equipment_id,
                'user_id'              => $borrower->user_id,
                'authorized_by'        => $issuer->user_id,
                'checkout_at'          => $checkout,
                'expected_return_at'   => $due,
                'actual_return_at'     => $returned,
                'purpose'              => $purposes[$i % count($purposes)],
                'status'               => Transaction::STATUS_RETURNED,
                'condition_on_issue'   => $firearm->condition_status,
                'condition_on_return'  => $firearm->condition_status,
                'notes'                => 'Returned complete with no discrepancies.',
                'gps_tracking_enabled' => true,
            ]);
        }
    }

    /**
     * Two firearms currently in the field plus one overdue item, each with a
     * GPS breadcrumb trail ending in the last few minutes.
     */
    private function seedActiveIssuances($firearms, $borrowers, User $custodian, ?GpsLocation $armory, ?GpsLocation $range, $fences): void
    {
        $plan = [
            ['index' => 0, 'hoursOut' => 3,  'dueInHours' => 5,   'status' => Transaction::STATUS_ACTIVE,  'availability' => FirearmEquipment::STATUS_CHECKED_OUT, 'purpose' => Transaction::PURPOSE_TRAINING],
            ['index' => 5, 'hoursOut' => 6,  'dueInHours' => 2,   'status' => Transaction::STATUS_ACTIVE,  'availability' => FirearmEquipment::STATUS_CHECKED_OUT, 'purpose' => Transaction::PURPOSE_FUNERAL],
            ['index' => 7, 'hoursOut' => 40, 'dueInHours' => -16, 'status' => Transaction::STATUS_OVERDUE, 'availability' => FirearmEquipment::STATUS_OVERDUE,     'purpose' => Transaction::PURPOSE_FUNERAL],
        ];

        foreach ($plan as $slot => $row) {
            $firearm  = $firearms[$row['index'] % $firearms->count()];
            $borrower = $borrowers[$slot % $borrowers->count()];

            $checkout = now()->subHours($row['hoursOut']);

            $transaction = Transaction::create([
                'equipment_id'         => $firearm->equipment_id,
                'user_id'              => $borrower->user_id,
                'authorized_by'        => $custodian->user_id,
                'checkout_at'          => $checkout,
                'expected_return_at'   => now()->addHours($row['dueInHours']),
                'purpose'              => $row['purpose'],
                'status'               => $row['status'],
                'condition_on_issue'   => $firearm->condition_status,
                'notes'                => $row['status'] === Transaction::STATUS_OVERDUE
                    ? 'Return window elapsed. Custodian notified for follow-up.'
                    : 'Issued for scheduled activity. GPS tracking active.',
                'gps_tracking_enabled' => true,
            ]);

            $firearm->update([
                'availability_status' => $row['availability'],
                'current_location_id' => optional($range)->location_id ?? optional($armory)->location_id,
            ]);

            $this->seedTrack($transaction, $firearm, $armory, $range, $fences, $slot);

            if ($row['status'] === Transaction::STATUS_OVERDUE) {
                $this->seedOverdueAlert($transaction, $firearm, $borrower, $custodian);
            }
        }
    }

    /**
     * Builds a breadcrumb trail from the armory out to the training range.
     */
    private function seedTrack(Transaction $transaction, FirearmEquipment $firearm, ?GpsLocation $armory, ?GpsLocation $range, $fences, int $deviceIndex): void
    {
        if (! $armory || ! $range) {
            return;
        }

        $points  = 20;
        $battery = 100;

        for ($i = 0; $i < $points; $i++) {
            $progress = $i / max(1, $points - 1);

            $lat = (float) $armory->center_latitude
                + ((float) $range->center_latitude - (float) $armory->center_latitude) * $progress
                + (random_int(-40, 40) / 100000);

            $lon = (float) $armory->center_longitude
                + ((float) $range->center_longitude - (float) $armory->center_longitude) * $progress
                + (random_int(-40, 40) / 100000);

            $capturedAt = now()->subSeconds(($points - 1 - $i) * 30);
            $battery    = max(35, $battery - random_int(0, 2));

            GpsLog::create([
                'transaction_id'     => $transaction->transaction_id,
                'equipment_id'       => $firearm->equipment_id,
                'captured_at'        => $capturedAt,
                'received_at'        => (clone $capturedAt)->addSeconds(random_int(1, 3)),
                'latitude'           => round($lat, 7),
                'longitude'          => round($lon, 7),
                'accuracy_meters'    => random_int(300, 900) / 100,
                'speed_mps'          => $i === 0 || $i === $points - 1 ? 0 : random_int(50, 900) / 100,
                'heading_deg'        => random_int(0, 359),
                'altitude_meters'    => random_int(150, 320),
                'satellites'         => random_int(7, 12),
                'battery_pct'        => $battery,
                'is_inside_geofence' => $this->insideAnyFence($lat, $lon, $fences),
                'device_id'          => sprintf('ESP32-GPS-%02d', $deviceIndex + 1),
            ]);
        }
    }

    private function seedOverdueAlert(Transaction $transaction, FirearmEquipment $firearm, User $borrower, User $custodian): void
    {
        // Events suppressed: AlertDispatcher would queue outbound email for
        // warning/critical severities, and seeded history should not page anyone.
        Notification::withoutEvents(function () use ($transaction, $firearm, $borrower, $custodian) {
            Notification::create([
                'user_id'      => $custodian->user_id,
                'equipment_id' => $firearm->equipment_id,
                'type'         => 'overdue',
                'severity'     => Notification::SEVERITY_CRITICAL,
                'title'        => 'Overdue Firearm',
                'message'      => sprintf(
                    '%s (%s) issued to %s is past its expected return time.',
                    $firearm->model,
                    $firearm->serial_number,
                    $borrower->fullName()
                ),
                'payload'      => [
                    'transaction_id'      => $transaction->transaction_id,
                    'expected_return_at'  => optional($transaction->expected_return_at)->toIso8601String(),
                ],
                'status'       => Notification::STATUS_UNREAD,
            ]);
        });
    }

    private function seedMaintenance($firearms, User $technician): void
    {
        $jobs = [
            ['index' => 2, 'type' => 'Cleaning',    'desc' => 'Routine bore cleaning and lubrication after range use.',      'before' => 78, 'after' => 92, 'cost' => 0,       'parts' => []],
            ['index' => 3, 'type' => 'Repair',      'desc' => 'Replaced worn extractor spring and firing pin.',              'before' => 54, 'after' => 88, 'cost' => 2850, 'parts' => ['Extractor spring', 'Firing pin']],
            ['index' => 6, 'type' => 'Inspection',  'desc' => 'Quarterly armorer inspection, headspace within tolerance.',   'before' => 85, 'after' => 85, 'cost' => 0,       'parts' => []],
            ['index' => 7, 'type' => 'Calibration', 'desc' => 'Sight realignment and function check on crew-served weapon.', 'before' => 60, 'after' => 80, 'cost' => 4200, 'parts' => ['Rear sight assembly']],
        ];

        foreach ($jobs as $i => $job) {
            $firearm = $firearms[$job['index'] % $firearms->count()];
            $date    = now()->subDays(45 - ($i * 10));

            MaintenanceRecord::create([
                'equipment_id'     => $firearm->equipment_id,
                'performed_by'     => $technician->user_id,
                'description'      => $job['desc'],
                'maintenance_date' => $date,
                'next_schedule'    => (clone $date)->addMonths(3),
                'maintenance_type' => $job['type'],
                'result_status'    => MaintenanceRecord::RESULT_SERVICEABLE,
                'cost'             => $job['cost'],
                'parts_replaced'   => $job['parts'],
                'remarks'          => 'Serviced by unit armorer. Returned to serviceable status.',
            ]);
        }

        // One firearm is on the bench right now, so the inventory reflects it.
        $inShop = $firearms->firstWhere('availability_status', FirearmEquipment::STATUS_AVAILABLE);

        if ($inShop) {
            $inShop->update(['availability_status' => FirearmEquipment::STATUS_MAINTENANCE]);
        }
    }

    private function insideAnyFence(float $lat, float $lon, $fences): bool
    {
        foreach ($fences as $fence) {
            $distance = $this->haversine(
                $lat,
                $lon,
                (float) $fence->center_latitude,
                (float) $fence->center_longitude
            );

            if ($distance <= (float) $fence->radius_meters) {
                return true;
            }
        }

        return false;
    }

    private function haversine(float $lat1, float $lon1, float $lat2, float $lon2): float
    {
        $earthRadius = 6371000;

        $dLat = deg2rad($lat2 - $lat1);
        $dLon = deg2rad($lon2 - $lon1);

        $a = sin($dLat / 2) ** 2
            + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2) ** 2;

        return $earthRadius * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }
}
