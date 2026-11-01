<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Transaction extends Model
{
    use HasFactory;

    protected $primaryKey = 'transaction_id';

    public const STATUS_ACTIVE    = 'Active';
    public const STATUS_RETURNED  = 'Returned';
    public const STATUS_OVERDUE   = 'Overdue';
    public const STATUS_CANCELLED = 'Cancelled';

    public const PURPOSE_TRAINING    = 1;
    public const PURPOSE_OPERATION   = 2;   // no longer issued; kept for older records
    public const PURPOSE_MAINTENANCE = 3;
    public const PURPOSE_INSPECTION  = 4;
    public const PURPOSE_FUNERAL     = 5;

    /** Trip from camp to the assigned destination and back (TripMonitor). */
    public const TRIP_AT_CAMP      = 'at_camp';
    public const TRIP_OUTBOUND     = 'outbound';
    public const TRIP_ON_SITE      = 'on_site';
    public const TRIP_RETURNING    = 'returning';
    public const TRIP_BACK_AT_CAMP = 'back_at_camp';

    protected $fillable = [
        'equipment_id',
        'user_id',
        'authorized_by',
        'checkout_at',
        'expected_return_at',
        'actual_return_at',
        'purpose',
        'status',
        'condition_on_issue',
        'condition_on_return',
        'notes',
        'gps_tracking_enabled',
        'destination_location_id',
        'trip_stage',
        'trip_place',
        'destination_arrived_at',
    ];

    protected $casts = [
        'checkout_at'          => 'datetime',
        'expected_return_at'   => 'datetime',
        'actual_return_at'     => 'datetime',
        'gps_tracking_enabled' => 'boolean',
        'purpose'              => 'integer',
        'destination_arrived_at' => 'datetime',
    ];

    public function firearm(): BelongsTo
    {
        return $this->belongsTo(FirearmEquipment::class, 'equipment_id', 'equipment_id');
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id', 'user_id');
    }

    public function authorizer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'authorized_by', 'user_id');
    }

    public function destination(): BelongsTo
    {
        return $this->belongsTo(GpsLocation::class, 'destination_location_id', 'location_id');
    }

    public function gpsLogs(): HasMany
    {
        return $this->hasMany(GpsLog::class, 'transaction_id', 'transaction_id');
    }

    public function isOverdue(): bool
    {
        return $this->status === self::STATUS_ACTIVE
            && $this->expected_return_at
            && now()->gt($this->expected_return_at);
    }

    public function purposeLabel(): string
    {
        return match ((int) $this->purpose) {
            self::PURPOSE_TRAINING    => 'Training',
            self::PURPOSE_OPERATION   => 'Operation',
            self::PURPOSE_MAINTENANCE => 'Maintenance',
            self::PURPOSE_INSPECTION  => 'Inspection',
            self::PURPOSE_FUNERAL     => 'Funeral',
            default                  => 'Other',
        };
    }
}
