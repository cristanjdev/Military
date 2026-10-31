<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class GpsLocation extends Model
{
    use HasFactory;

    protected $primaryKey = 'location_id';
    protected $fillable = [
        'location_name',
        'description',
        'security_level',
        'center_latitude',
        'center_longitude',
        'radius_meters',
        'polygon',
        'is_armory',
        'is_camp',
    ];

    protected $casts = [
        'center_latitude'  => 'decimal:7',
        'center_longitude' => 'decimal:7',
        'radius_meters'    => 'decimal:2',
        'polygon'          => 'array',
        'is_armory'        => 'boolean',
        'is_camp'          => 'boolean',
        'security_level'   => 'integer',
    ];

    public const SECURITY_STANDARD   = 1;
    public const SECURITY_RESTRICTED = 2;

    public function firearms(): HasMany
    {
        return $this->hasMany(FirearmEquipment::class, 'current_location_id', 'location_id');
    }

    /**
     * Distance (meters) using Haversine formula.
     */
    public function distanceTo(float $lat, float $lon): ?float
    {
        if ($this->center_latitude === null || $this->center_longitude === null) {
            return null;
        }
        $earth = 6371000.0;
        $lat1 = deg2rad((float) $this->center_latitude);
        $lat2 = deg2rad($lat);
        $dLat = $lat2 - $lat1;
        $dLon = deg2rad($lon - (float) $this->center_longitude);
        $a = sin($dLat / 2) ** 2 + cos($lat1) * cos($lat2) * sin($dLon / 2) ** 2;
        $c = 2 * atan2(sqrt($a), sqrt(1 - $a));
        return $earth * $c;
    }

    /** The camp a firearm leaves from and returns to: zones marked as camp, and the armory zones in it. */
    public function isCamp(): bool
    {
        return $this->is_camp || $this->is_armory;
    }

    public function contains(float $lat, float $lon): bool
    {
        $distance = $this->distanceTo($lat, $lon);
        return $distance !== null
            && $this->radius_meters !== null
            && $distance <= (float) $this->radius_meters;
    }
}
