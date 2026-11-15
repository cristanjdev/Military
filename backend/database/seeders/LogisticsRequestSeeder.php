<?php

namespace Database\Seeders;

use App\Models\FirearmEquipment;
use App\Models\LogisticsRequest;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;

/**
 * Sample S4 Officer requests (new firearms and repair budgets) in every status, for trying the
 * Requests page locally. Not part of DatabaseSeeder; run it with:
 *   php artisan db:seed --class=LogisticsRequestSeeder
 */
class LogisticsRequestSeeder extends Seeder
{
    public function run(): void
    {
        if (LogisticsRequest::count() > 0) {
            $this->command?->info('Requests already exist. Skipping.');
            return;
        }

        $s4 = User::where('username', 's4.officer')->first() ?? User::where('role_id', 3)->first();
        $commander = User::where('username', 'cmd.officer')->first() ?? User::where('role_id', 2)->first();

        if (! $s4 || ! $commander) {
            $this->command?->warn('Needs an S4 Officer and a Command Officer. Run UserSeeder first.');
            return;
        }

        $firearms = FirearmEquipment::pluck('equipment_id', 'serial_number');
        /** Repair line for a firearm by serial; skipped when that firearm is not in this database. */
        $item = fn(string $serial, int $cost) => isset($firearms[$serial])
            ? ['equipment_id' => $firearms[$serial], 'serial_number' => $serial, 'cost' => $cost]
            : null;
        $items = fn(array $lines) => array_values(array_filter($lines));

        $requests = [
            [
                'type'     => LogisticsRequest::TYPE_NEW_FIREARM,
                'title'    => 'M4 Carbines for reserve training',
                'details'  => "The reserve company starts its quarterly training in December. We have 2 serviceable M4s for 30 trainees.\nRequesting 10 units so each squad has its own.",
                'quantity' => 10,
                'estimated_cost' => 950_000,
                'status'   => LogisticsRequest::STATUS_PENDING,
                'created'  => Carbon::now()->subHours(3),
            ],
            [
                'type'     => LogisticsRequest::TYPE_REPAIR_BUDGET,
                'title'    => 'Repair budget for firearms needing repair',
                'details'  => 'Both rifles failed function checks during the last inspection. Parts quoted by the 4th Maintenance Unit.',
                'items'    => $items([$item('PA-M16-001', 18_500), $item('PA-MG-001', 42_000)]),
                'status'   => LogisticsRequest::STATUS_PENDING,
                'created'  => Carbon::now()->subDay()->setTime(9, 15),
            ],
            [
                'type'     => LogisticsRequest::TYPE_NEW_FIREARM,
                'title'    => 'Glock 17 pistols for the duty officers',
                'details'  => 'Duty officers currently share one pistol per shift.',
                'quantity' => 4,
                'estimated_cost' => 180_000,
                'status'   => LogisticsRequest::STATUS_APPROVED,
                'created'  => Carbon::now()->subDays(6)->setTime(14, 30),
                'decided'  => Carbon::now()->subDays(4)->setTime(10, 5),
                'note'     => 'Approved. Coordinate delivery with the supply office.',
            ],
            [
                'type'     => LogisticsRequest::TYPE_REPAIR_BUDGET,
                'title'    => 'Barrel and firing pin replacement',
                'details'  => null,
                'items'    => $items([$item('PA-M4-002', 12_000), $item('PA-PI-001', 6_500)]),
                'status'   => LogisticsRequest::STATUS_APPROVED,
                'created'  => Carbon::now()->subDays(12)->setTime(8, 40),
                'decided'  => Carbon::now()->subDays(11)->setTime(16, 20),
                'note'     => null,
            ],
            [
                'type'     => LogisticsRequest::TYPE_NEW_FIREARM,
                'title'    => 'Shotguns for perimeter security',
                'details'  => 'For the gate guards at Camp Evangelista.',
                'quantity' => 6,
                'estimated_cost' => 420_000,
                'status'   => LogisticsRequest::STATUS_REJECTED,
                'created'  => Carbon::now()->subDays(20)->setTime(11, 0),
                'decided'  => Carbon::now()->subDays(18)->setTime(9, 45),
                'note'     => 'Not in this year\'s budget. Submit again in January.',
            ],
            [
                'type'     => LogisticsRequest::TYPE_REPAIR_BUDGET,
                'title'    => 'Shotgun action repair',
                'details'  => 'The pump action sticks after a few cycles.',
                'items'    => $items([$item('PA-SG-001', 9_800)]),
                'status'   => LogisticsRequest::STATUS_REJECTED,
                'created'  => Carbon::now()->subDays(27)->setTime(13, 10),
                'decided'  => Carbon::now()->subDays(26)->setTime(8, 30),
                'note'     => 'The armorer can fix this in-house. No outside repair needed.',
            ],
        ];

        foreach ($requests as $r) {
            $lines = $r['items'] ?? null;
            $req = new LogisticsRequest([
                'type'           => $r['type'],
                'title'          => $r['title'],
                'details'        => $r['details'],
                'quantity'       => $r['quantity'] ?? null,
                // A repair budget is the sum of its firearms' costs, as the controller computes it.
                'estimated_cost' => $lines ? array_sum(array_column($lines, 'cost')) : ($r['estimated_cost'] ?? 0),
                'items'          => $lines ?: null,
                'status'         => $r['status'],
                'requested_by'   => $s4->user_id,
                'decided_by'     => isset($r['decided']) ? $commander->user_id : null,
                'decided_at'     => $r['decided'] ?? null,
                'decision_note'  => $r['note'] ?? null,
            ]);
            $req->created_at = $r['created'];
            $req->updated_at = $r['decided'] ?? $r['created'];
            $req->save();
        }

        $this->command?->info('Seeded ' . count($requests) . ' sample requests.');
    }
}
