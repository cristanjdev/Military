<?php

namespace Database\Seeders;

use App\Models\FirearmEquipment;
use App\Models\MaintenanceRecord;
use App\Models\RepairRequest;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;

/**
 * Sample repair requests at every step of the approval flow, and maintenance due dates spread
 * from overdue to next month, for trying the Maintenance page locally.
 * Not part of DatabaseSeeder; run it with:
 *   php artisan db:seed --class=RepairRequestSeeder
 */
class RepairRequestSeeder extends Seeder
{
    public function run(): void
    {
        if (RepairRequest::count() > 0) {
            $this->command?->info('Repair requests already exist. Skipping.');
            return;
        }

        $custodian = User::where('username', 'armory.custodian')->first() ?? User::where('role_id', 4)->first();
        $s4        = User::where('username', 's4.officer')->first() ?? User::where('role_id', 3)->first();
        $commander = User::where('username', 'cmd.officer')->first() ?? User::where('role_id', 2)->first();
        if (! $custodian || ! $s4 || ! $commander) {
            $this->command?->warn('Needs a Custodian, an S4 Officer and a Command Officer. Run UserSeeder first.');
            return;
        }

        $firearm = fn(string $serial) => FirearmEquipment::where('serial_number', $serial)->first();
        $now = Carbon::now();
        $count = 0;

        $add = function (string $serial, array $attrs) use ($firearm, &$count) {
            $f = $firearm($serial);
            if (! $f) {
                return null;
            }
            $count++;
            return RepairRequest::create(['equipment_id' => $f->equipment_id] + $attrs);
        };

        // 1. Just reported: waiting for the S4 Officer.
        $add('PA-M4-002', [
            'status' => RepairRequest::STATUS_REPORTED,
            'problem' => 'Bolt carrier sticks when chambering a round.',
            'damaged_at' => $now->copy()->subDays(2)->toDateString(),
            'reported_by' => $custodian->user_id, 'reported_at' => $now->copy()->subDays(2)->setTime(9, 20),
        ]);

        // 2. Forwarded: waiting for the Command Officer.
        $add('PA-M16-001', [
            'status' => RepairRequest::STATUS_FORWARDED,
            'problem' => 'Front sight post bent after a fall during field training.',
            'damaged_at' => $now->copy()->subDays(5)->toDateString(),
            'reported_by' => $custodian->user_id, 'reported_at' => $now->copy()->subDays(5)->setTime(15, 10),
            'estimated_cost' => 3_500, 's4_notes' => 'Parts available at the 4th Maintenance Unit.',
            'forwarded_by' => $s4->user_id, 'forwarded_at' => $now->copy()->subDays(4)->setTime(8, 45),
        ]);

        // 3. Approved and the Custodian informed: waiting to be sent.
        $add('PA-PI-002', [
            'status' => RepairRequest::STATUS_APPROVED,
            'problem' => 'Weak trigger spring; misfires about once every five rounds.',
            'damaged_at' => $now->copy()->subDays(9)->toDateString(),
            'reported_by' => $custodian->user_id, 'reported_at' => $now->copy()->subDays(9)->setTime(10, 0),
            'estimated_cost' => 1_800, 'forwarded_by' => $s4->user_id, 'forwarded_at' => $now->copy()->subDays(8)->setTime(9, 30),
            'decided_by' => $commander->user_id, 'decided_at' => $now->copy()->subDays(7)->setTime(14, 5),
            'decision_note' => 'Approved. Send it this week.',
            'informed_by' => $s4->user_id, 'custodian_informed_at' => $now->copy()->subDays(7)->setTime(16, 40),
        ]);

        // 4. Rejected and the Custodian informed.
        $add('PA-PI-001', [
            'status' => RepairRequest::STATUS_REJECTED,
            'problem' => 'Grip panel cracked.',
            'damaged_at' => $now->copy()->subDays(14)->toDateString(),
            'reported_by' => $custodian->user_id, 'reported_at' => $now->copy()->subDays(14)->setTime(11, 15),
            'estimated_cost' => 900, 'forwarded_by' => $s4->user_id, 'forwarded_at' => $now->copy()->subDays(13)->setTime(8, 0),
            'decided_by' => $commander->user_id, 'decided_at' => $now->copy()->subDays(12)->setTime(10, 30),
            'decision_note' => 'Cosmetic only. The armorer can replace the panel in-house.',
            'informed_by' => $s4->user_id, 'custodian_informed_at' => $now->copy()->subDays(12)->setTime(13, 0),
        ]);

        // 5. Out for repair: the firearm is in Maintenance, as the send step does.
        $sent = $add('PA-M16-002', [
            'status' => RepairRequest::STATUS_IN_REPAIR,
            'problem' => 'Barrel pitted from corrosion; accuracy off at 100 m.',
            'damaged_at' => $now->copy()->subDays(20)->toDateString(),
            'reported_by' => $custodian->user_id, 'reported_at' => $now->copy()->subDays(20)->setTime(9, 0),
            'estimated_cost' => 12_000, 'forwarded_by' => $s4->user_id, 'forwarded_at' => $now->copy()->subDays(19)->setTime(10, 20),
            'decided_by' => $commander->user_id, 'decided_at' => $now->copy()->subDays(18)->setTime(15, 45),
            'informed_by' => $s4->user_id, 'custodian_informed_at' => $now->copy()->subDays(18)->setTime(17, 0),
            'sent_by' => $custodian->user_id, 'sent_at' => $now->copy()->subDays(16)->setTime(8, 30),
            'received_by' => 'SSG Ramon Villanueva', 'received_by_unit' => '4th Maintenance Unit',
        ]);
        $sent?->firearm?->update(['availability_status' => FirearmEquipment::STATUS_MAINTENANCE]);

        // 6. Back from maintenance.
        $add('PA-MG-001', [
            'status' => RepairRequest::STATUS_COMPLETED,
            'problem' => 'Feed tray cover does not latch.',
            'damaged_at' => $now->copy()->subDays(40)->toDateString(),
            'reported_by' => $custodian->user_id, 'reported_at' => $now->copy()->subDays(40)->setTime(13, 30),
            'estimated_cost' => 6_500, 'forwarded_by' => $s4->user_id, 'forwarded_at' => $now->copy()->subDays(39)->setTime(9, 10),
            'decided_by' => $commander->user_id, 'decided_at' => $now->copy()->subDays(38)->setTime(11, 0),
            'informed_by' => $s4->user_id, 'custodian_informed_at' => $now->copy()->subDays(38)->setTime(14, 20),
            'sent_by' => $custodian->user_id, 'sent_at' => $now->copy()->subDays(36)->setTime(8, 0),
            'received_by' => 'SSG Ramon Villanueva', 'received_by_unit' => '4th Maintenance Unit',
            'repaired_at' => $now->copy()->subDays(30)->toDateString(),
            'returned_to' => $custodian->user_id, 'returned_at' => $now->copy()->subDays(29)->setTime(10, 15),
            'result_status' => MaintenanceRecord::RESULT_SERVICEABLE, 'cost' => 6_200,
            'work_done' => 'Replaced the cover latch spring and pin.',
        ]);

        // Maintenance due dates from overdue to next month, so the Schedule tab shows each state.
        $due = [
            'PA-M4-001' => -6, 'PA-M4-002' => 2, 'PA-M16-001' => 5, 'PA-PI-001' => 12,
            'PA-PI-002' => 20, 'PA-SG-001' => -1, 'PA-MG-001' => 34,
        ];
        foreach ($due as $serial => $days) {
            $firearm($serial)?->update(['next_maintenance_due' => $now->copy()->addDays($days)->toDateString()]);
        }

        $this->command?->info("Seeded {$count} sample repair requests and spread the maintenance due dates.");
    }
}
