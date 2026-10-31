<?php

namespace Database\Seeders;

use App\Models\EquipmentCategory;
use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use Illuminate\Database\Seeder;
use Illuminate\Support\Str;

class FirearmSeeder extends Seeder
{
    public function run(): void
    {
        $firearmCategory = EquipmentCategory::where('category_code', EquipmentCategory::FIREARM)->first();
        $armory          = GpsLocation::where('is_armory', true)->first();

        if (! $firearmCategory) {
            return;
        }

        $firearms = [
            ['serial' => 'PA-M4-001', 'model' => 'M4 Carbine',     'manufacturer' => 'Colt',           'caliber' => '5.56 NATO', 'condition' => FirearmEquipment::CONDITION_EXCELLENT, 'cost' => 65000.00],
            ['serial' => 'PA-M4-002', 'model' => 'M4 Carbine',     'manufacturer' => 'Colt',           'caliber' => '5.56 NATO', 'condition' => FirearmEquipment::CONDITION_GOOD,      'cost' => 65000.00],
            ['serial' => 'PA-M16-001','model' => 'M16A1',          'manufacturer' => 'Elisco',         'caliber' => '5.56 NATO', 'condition' => FirearmEquipment::CONDITION_GOOD,      'cost' => 48000.00],
            ['serial' => 'PA-M16-002','model' => 'M16A2',          'manufacturer' => 'FN Herstal',     'caliber' => '5.56 NATO', 'condition' => FirearmEquipment::CONDITION_FAIR,      'cost' => 52000.00],
            ['serial' => 'PA-SG-001', 'model' => 'Mossberg 500',   'manufacturer' => 'Mossberg',       'caliber' => '12 Gauge',  'condition' => FirearmEquipment::CONDITION_GOOD,      'cost' => 28000.00],
            ['serial' => 'PA-MG-001', 'model' => 'M60 GPMG',       'manufacturer' => 'U.S. Ordnance',  'caliber' => '7.62 NATO', 'condition' => FirearmEquipment::CONDITION_FAIR,      'cost' => 180000.00],
        ];

        foreach ($firearms as $f) {
            FirearmEquipment::updateOrCreate(
                ['serial_number' => $f['serial']],
                [
                    'category_id'         => $firearmCategory->category_id,
                    'qr_code'             => 'ARMORY-' . Str::upper(Str::random(10)) . '-' . $f['serial'],
                    'model'               => $f['model'],
                    'manufacturer'        => $f['manufacturer'],
                    'caliber'             => $f['caliber'],
                    'condition_status'    => $f['condition'],
                    'current_location_id' => optional($armory)->location_id,
                    'availability_status' => FirearmEquipment::STATUS_AVAILABLE,
                    'acquisition_date'    => now()->subYears(random_int(1, 6)),
                    'acquisition_cost'    => $f['cost'],
                    'next_maintenance_due'=> now()->addMonths(random_int(1, 6)),
                ]
            );
        }
    }
}
