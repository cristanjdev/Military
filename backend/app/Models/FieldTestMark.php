<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Something the testers did during a field test, tapped on the page when they did it.
 */
class FieldTestMark extends Model
{
    protected $primaryKey = 'mark_id';
    public $timestamps = false;

    // Tracker placed on the marked spot / picked up again (distance error).
    public const SPOT_START = 'spot_start';
    public const SPOT_END   = 'spot_end';
    // Tracker carried away from the phone on the marked spot / walk over (hotspot range).
    public const RANGE_START = 'range_start';
    public const RANGE_END   = 'range_end';
    // Zone edge walks (geofence accuracy).
    public const ZONE_START = 'zone_start';
    public const ZONE_END   = 'zone_end';
    public const ENTERED    = 'entered';
    public const LEFT       = 'left';
    // Hotspot switched off / on (alert trigger accuracy).
    public const HOTSPOT_OFF = 'hotspot_off';
    public const HOTSPOT_ON  = 'hotspot_on';

    public const KINDS = [
        self::SPOT_START, self::SPOT_END,
        self::RANGE_START, self::RANGE_END,
        self::ZONE_START, self::ZONE_END, self::ENTERED, self::LEFT,
        self::HOTSPOT_OFF, self::HOTSPOT_ON,
    ];

    protected $fillable = ['field_test_id', 'kind', 'occurred_at', 'created_by'];

    protected $casts = ['occurred_at' => 'datetime'];
}
