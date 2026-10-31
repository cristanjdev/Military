<?php

namespace Database\Seeders;

use App\Models\GpsLocation;
use Illuminate\Database\Seeder;

class GpsLocationSeeder extends Seeder
{
    public function run(): void
    {
        // Camp Evangelista, Cagayan de Oro City — 10RCDG HQ.
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
                'is_camp'          => true,
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
    }
}
