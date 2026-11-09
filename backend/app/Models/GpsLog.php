<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class GpsLog extends Model
{
    use HasFactory;

    public $timestamps = false;
    protected $primaryKey = 'gps_log_id';

    protected $fillable = [
        'transaction_id',
        'repair_id',
        'equipment_id',
        'captured_at',
        'received_at',
        'latitude',
        'longitude',
        'accuracy_meters',
        'speed_mps',
        'heading_deg',
        'altitude_meters',
        'satellites',
        'battery_pct',
        'is_inside_geofence',
        'device_id',
        'signature',
    ];

    protected $casts = [
        'captured_at'         => 'datetime',
        'received_at'         => 'datetime',
        'latitude'            => 'decimal:7',
        'longitude'           => 'decimal:7',
        'accuracy_meters'     => 'decimal:2',
        'speed_mps'           => 'decimal:2',
        'heading_deg'         => 'decimal:2',
        'altitude_meters'     => 'decimal:2',
        'is_inside_geofence'  => 'boolean',
    ];

    /**
     * GPS coordinates are protected via:
     * 1. HMAC-SHA256 signed payloads in transit (ESP32 → API)
     * 2. HTTPS/TLS 1.3 encrypted channel
     * 3. Database-level encryption at rest (MariaDB InnoDB tablespace encryption)
     * 4. Application-level access restricted to authenticated users only
     *
     * For production deployment, enable MariaDB's innodb_encrypt_tables=ON
     * and innodb_encryption_threads=4 in my.cnf for transparent data-at-rest encryption.
     */

    public function firearm(): BelongsTo
    {
        return $this->belongsTo(FirearmEquipment::class, 'equipment_id', 'equipment_id');
    }

    public function transaction(): BelongsTo
    {
        return $this->belongsTo(Transaction::class, 'transaction_id', 'transaction_id');
    }
}
