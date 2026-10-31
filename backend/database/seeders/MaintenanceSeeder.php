<?php

namespace Database\Seeders;

use App\Models\FirearmEquipment;
use App\Models\MaintenanceRecord;
use App\Models\User;
use Illuminate\Database\Seeder;

class MaintenanceSeeder extends Seeder
{
    public function run(): void
    {
        if (MaintenanceRecord::count() > 0) {
            $this->command?->info('Maintenance records already seeded. Skipping.');
            return;
        }

        $custodian = User::where('username', 'armory.custodian')->first()
            ?? User::where('role_id', 4)->first()
            ?? User::first();

        $s4 = User::where('username', 's4.officer')->first()
            ?? User::where('role_id', 3)->first()
            ?? $custodian;

        if (!$custodian) {
            $this->command?->warn('No users available to assign as maintenance technician.');
            return;
        }

        $firearms = FirearmEquipment::orderBy('equipment_id')->get()->keyBy('serial_number');

        if ($firearms->isEmpty()) {
            $this->command?->warn('No firearms available. Run FirearmSeeder first.');
            return;
        }

        $records = [
            [
                'serial'      => 'PA-M4-001',
                'type'        => 'Inspection',
                'desc'        => 'Semi-annual armory armorer inspection; headspace and bolt carrier group within tolerance.',
                'days_ago'    => 12,
                'next_months' => 3,
                'before'      => 82,
                'after'       => 95,
                'cost'        => 0,
                'parts'       => [],
                'tech'        => $custodian->user_id,
                'remarks'     => 'All components checked against technical manual specs. Operational readiness confirmed.',
            ],
            [
                'serial'      => 'PA-M4-001',
                'type'        => 'Cleaning',
                'desc'        => 'Thorough ultrasonic field strip cleaning, bore decoking, and CLP lubrication after qualification.',
                'days_ago'    => 35,
                'next_months' => 2,
                'before'      => 74,
                'after'       => 90,
                'cost'        => 450,
                'parts'       => ['Cleaning solvents', 'CLP lubricant'],
                'tech'        => $custodian->user_id,
                'remarks'     => 'Carbon buildup removed from gas key and bolt lugs.',
            ],
            [
                'serial'      => 'PA-M4-002',
                'type'        => 'Repair',
                'desc'        => 'Replaced defective extractor spring and worn gas rings on bolt assembly to resolve extraction drag.',
                'days_ago'    => 18,
                'next_months' => 4,
                'before'      => 55,
                'after'       => 90,
                'cost'        => 2450,
                'parts'       => ['Extractor spring', 'Gas ring set', 'Buffer retainer'],
                'tech'        => $custodian->user_id,
                'remarks'     => 'Fired 30 proof rounds post-repair. Zero malfunctions detected.',
            ],
            [
                'serial'      => 'PA-M16-001',
                'type'        => 'Inspection',
                'desc'        => 'Pre-deployment visual and functional inspection of upper and lower receiver assemblies.',
                'days_ago'    => 5,
                'next_months' => 3,
                'before'      => 80,
                'after'       => 88,
                'cost'        => 0,
                'parts'       => [],
                'tech'        => $s4->user_id,
                'remarks'     => 'Barrel rifling sharp, trigger reset clean at 5.5 lbs.',
            ],
            [
                'serial'      => 'PA-M16-002',
                'type'        => 'Calibration',
                'desc'        => 'A2 rear sight aperture elevation/windage calibration and 25m zero alignment on laser arbor.',
                'days_ago'    => 22,
                'next_months' => 6,
                'before'      => 68,
                'after'       => 85,
                'cost'        => 1200,
                'parts'       => ['Sight detent pin'],
                'tech'        => $custodian->user_id,
                'remarks'     => 'Windage drum clicks indexed and secured.',
            ],
            [
                'serial'      => 'PA-SG-001',
                'type'        => 'Inspection',
                'desc'        => 'Magazine tube follower and action slide bar inspection; dual extractors function test passed.',
                'days_ago'    => 15,
                'next_months' => 4,
                'before'      => 78,
                'after'       => 88,
                'cost'        => 0,
                'parts'       => [],
                'tech'        => $s4->user_id,
                'remarks'     => 'Safety switch and disconnector functioning smoothly.',
            ],
            [
                'serial'      => 'PA-MG-001',
                'type'        => 'Repair',
                'desc'        => 'Replaced worn driving spring and operating rod assembly; serviced and adjusted gas cylinder regulator.',
                'days_ago'    => 28,
                'next_months' => 1,
                'before'      => 42,
                'after'       => 86,
                'cost'        => 8900,
                'parts'       => ['Driving spring', 'Operating rod', 'Gas cylinder plug'],
                'tech'        => $custodian->user_id,
                'remarks'     => 'Sustained fire test completed at range. Cyclic rate within 550 RPM.',
            ],
            [
                'serial'      => 'PA-MG-001',
                'type'        => 'Calibration',
                'desc'        => 'Headspace and timing gauge calibration on heavy spare barrel assembly.',
                'days_ago'    => 60,
                'next_months' => 2,
                'before'      => 60,
                'after'       => 82,
                'cost'        => 3500,
                'parts'       => ['Headspace shims'],
                'tech'        => $s4->user_id,
                'remarks'     => 'Barrel collar locked and marked for rapid hot-barrel swaps.',
            ],
        ];

        $count = 0;
        foreach ($records as $item) {
            $firearm = $firearms->get($item['serial']) ?? $firearms->first();
            if (!$firearm) continue;

            $date = now()->subDays($item['days_ago']);

            MaintenanceRecord::create([
                'equipment_id'     => $firearm->equipment_id,
                'performed_by'     => $item['tech'],
                'description'      => $item['desc'],
                'maintenance_date' => $date,
                'next_schedule'    => (clone $date)->addMonths($item['next_months']),
                'maintenance_type' => $item['type'],
                'result_status'    => MaintenanceRecord::RESULT_SERVICEABLE,
                'cost'             => $item['cost'],
                'parts_replaced'   => $item['parts'],
                'remarks'          => $item['remarks'],
            ]);
            $count++;
        }

        $this->command?->info("Seeded {$count} maintenance records.");
    }
}
