<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One power-on of a tracker, as it reported with its first position: milliseconds from
 * power-on until it joined the hotspot, saw its first satellite and had a GPS fix.
 */
class TrackerStartup extends Model
{
    public const UPDATED_AT = null;

    protected $primaryKey = 'startup_id';

    protected $fillable = [
        'equipment_id', 'device_id', 'reason', 'booted_at', 'wifi_ms', 'sats_ms', 'fix_ms', 'first_received_at',
    ];

    protected $casts = [
        'booted_at'         => 'datetime',
        'first_received_at' => 'datetime',
        'wifi_ms'           => 'integer',
        'sats_ms'           => 'integer',
        'fix_ms'            => 'integer',
    ];
}
