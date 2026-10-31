<?php

use App\Models\EquipmentCategory;
use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use App\Models\Role;
use App\Models\User;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

return new class extends Migration
{
    public function up(): void
    {
        // 1. Ensure Roles Exist
        $roles = [
            ['role_name' => Role::ADMIN,            'description' => 'Full system control: users, settings, audits.'],
            ['role_name' => Role::COMMAND_OFFICER,  'description' => 'View-all dashboards, reports, situational awareness.'],
            ['role_name' => Role::S4_OFFICER,       'description' => 'Logistics: approve/record issuance, returns, stocks.'],
            ['role_name' => Role::ARMORY_CUSTODIAN, 'description' => 'Day-to-day firearm tag/issue/return; QR scanning.'],
            ['role_name' => Role::PERSONNEL,        'description' => 'Authenticate, view assigned firearm, return.'],
        ];

        foreach ($roles as $row) {
            Role::updateOrCreate(['role_name' => $row['role_name']], $row);
        }

        $rolesMap = Role::all()->keyBy('role_name');

        // 2. Ensure Equipment Categories Exist
        $categories = [
            ['category_code' => EquipmentCategory::FIREARM,    'category_name' => 'Firearm',       'description' => 'Service rifles, pistols, shotguns, and crew-served weapons.'],
            ['category_code' => EquipmentCategory::AMMUNITION, 'category_name' => 'Ammunition',    'description' => 'Rounds, cartridges, magazines, and pyrotechnics.'],
            ['category_code' => EquipmentCategory::GEAR,       'category_name' => 'Tactical Gear', 'description' => 'Body armor, communications, optics, and load-bearing equipment.'],
        ];

        foreach ($categories as $row) {
            EquipmentCategory::updateOrCreate(['category_code' => $row['category_code']], $row);
        }

        // 3. Ensure Default Locations Exist
        $locations = [
            [
                'location_name'    => '10RCDG Main Armory',
                'description'      => 'Primary armory vault inside Camp Evangelista.',
                'security_level'   => GpsLocation::SECURITY_RESTRICTED,
                'center_latitude'  => 8.484460,
                'center_longitude' => 124.657010,
                'radius_meters'    => 75,
                'is_armory'        => true,
            ],
            [
                'location_name'    => 'Camp Evangelista Perimeter',
                'description'      => 'Authorized geofence covering the camp.',
                'security_level'   => GpsLocation::SECURITY_RESTRICTED,
                'center_latitude'  => 8.485000,
                'center_longitude' => 124.658000,
                'radius_meters'    => 1500,
                'is_armory'        => false,
            ],
            [
                'location_name'    => 'Northern Mindanao Training Range',
                'description'      => 'Live-fire and training maneuver area.',
                'security_level'   => GpsLocation::SECURITY_STANDARD,
                'center_latitude'  => 8.452000,
                'center_longitude' => 124.633000,
                'radius_meters'    => 3000,
                'is_armory'        => false,
            ],
            [
                'location_name'    => 'Issuance Counter',
                'description'      => 'Firearm issuance and return room.',
                'security_level'   => GpsLocation::SECURITY_RESTRICTED,
                'center_latitude'  => 8.484520,
                'center_longitude' => 124.657110,
                'radius_meters'    => 25,
                'is_armory'        => true,
            ],
        ];

        foreach ($locations as $row) {
            GpsLocation::updateOrCreate(['location_name' => $row['location_name']], $row);
        }

        // 4. Ensure Baseline Users & Passwords Match credentials.txt
        $users = [
            [
                'username'           => 'admin',
                'email'              => 'admin@10rcdg.mil.ph',
                'password'           => env('SEED_ADMIN_PASSWORD', 'Admin@10RCDG!2025'),
                'first_name'         => 'System',
                'last_name'          => 'Administrator',
                'rank'               => 'CIV',
                'phone'              => '09171000001',
                'role'               => Role::ADMIN,
                'security_clearance' => User::CLEARANCE_TOP_SECRET,
            ],
            [
                'username'           => 'cmd.officer',
                'email'              => 'cmd.officer@10rcdg.mil.ph',
                'password'           => env('SEED_CMD_PASSWORD', 'Command@2025!'),
                'first_name'         => 'Mateo',
                'last_name'          => 'Bautista',
                'rank'               => 'COL',
                'phone'              => '09171000002',
                'role'               => Role::COMMAND_OFFICER,
                'security_clearance' => User::CLEARANCE_TOP_SECRET,
            ],
            [
                'username'           => 's4.officer',
                'email'              => 's4@10rcdg.mil.ph',
                'password'           => env('SEED_S4_PASSWORD', 'S4Logistics@2025!'),
                'first_name'         => 'Joana',
                'last_name'          => 'Reyes',
                'rank'               => 'CPT',
                'phone'              => '09171000003',
                'role'               => Role::S4_OFFICER,
                'security_clearance' => User::CLEARANCE_SECRET,
            ],
            [
                'username'           => 'armory.custodian',
                'email'              => 'armory@10rcdg.mil.ph',
                'password'           => env('SEED_CUSTODIAN_PASSWORD', 'Custodian@2025!'),
                'first_name'         => 'Rafael',
                'last_name'          => 'Salazar',
                'rank'               => 'SSG',
                'phone'              => '09171000004',
                'role'               => Role::ARMORY_CUSTODIAN,
                'security_clearance' => User::CLEARANCE_SECRET,
            ],
            [
                'username'           => 'pvt.dela.cruz',
                'email'              => 'dela.cruz@10rcdg.mil.ph',
                'password'           => env('SEED_PERSONNEL_PASSWORD', 'Personnel@2025!'),
                'first_name'         => 'Juan',
                'last_name'          => 'Dela Cruz',
                'rank'               => 'PVT',
                'phone'              => '09171000005',
                'role'               => Role::PERSONNEL,
                'security_clearance' => User::CLEARANCE_CONFIDENTIAL,
            ],
            [
                'username'           => 'cpl.santos',
                'email'              => 'santos@10rcdg.mil.ph',
                'password'           => env('SEED_PERSONNEL_PASSWORD', 'Personnel@2025!'),
                'first_name'         => 'Miguel',
                'last_name'          => 'Santos',
                'rank'               => 'CPL',
                'phone'              => '09171000006',
                'role'               => Role::PERSONNEL,
                'security_clearance' => User::CLEARANCE_CONFIDENTIAL,
            ],
            [
                'username'           => 'cristanjade',
                'email'              => 'cristanjade14@gmail.com',
                'password'           => 'dededgwapo14',
                'first_name'         => 'Cristan',
                'last_name'          => 'Menase',
                'rank'               => 'PVT',
                'phone'              => '09171000007',
                'role'               => Role::ADMIN,
                'security_clearance' => User::CLEARANCE_TOP_SECRET,
            ],
        ];

        foreach ($users as $row) {
            $role = $rolesMap[$row['role']] ?? null;
            if (! $role) {
                continue;
            }

            $user = User::withTrashed()
                ->where('username', $row['username'])
                ->orWhere('email', $row['email'])
                ->first();

            $data = [
                'role_id'               => $role->role_id,
                'username'              => $row['username'],
                'email'                 => $row['email'],
                'password'              => Hash::make($row['password']),
                'first_name'            => $row['first_name'],
                'last_name'             => $row['last_name'],
                'rank'                  => $row['rank'],
                'phone'                 => $row['phone'] ?? null,
                'security_clearance'    => $row['security_clearance'],
                'status'                => User::STATUS_ACTIVE,
                'failed_login_attempts' => 0,
                'locked_until'          => null,
                'deleted_at'            => null,
            ];

            if ($user) {
                $user->update($data);
            } else {
                User::create($data);
            }

            // Clear login failure throttles
            Cache::forget("login-fail:{$row['username']}");
            Cache::forget("login-fail:{$row['email']}");
        }

        try {
            Cache::flush();
            if (\Illuminate\Support\Facades\Schema::hasTable('cache')) {
                \Illuminate\Support\Facades\DB::table('cache')->truncate();
            }
        } catch (\Throwable) {
            // Ignore if cache driver does not support truncate
        }

        // 5. Ensure Firearms Exist if empty
        if (FirearmEquipment::count() === 0) {
            $firearmCategory = EquipmentCategory::where('category_code', EquipmentCategory::FIREARM)->first();
            $armory = GpsLocation::where('is_armory', true)->first();

            if ($firearmCategory) {
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
                            'acquisition_date'    => now()->subYears(2),
                            'acquisition_cost'    => $f['cost'],
                            'next_maintenance_due'=> now()->addMonths(6),
                        ]
                    );
                }
            }
        }
    }

    public function down(): void
    {
        // Non-destructive: no rollback for baseline seed sync
    }
};
