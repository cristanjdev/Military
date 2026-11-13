<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class FirearmEquipment extends Model
{
    use HasFactory, SoftDeletes;

    protected $table = 'firearm_equipment';
    protected $primaryKey = 'equipment_id';

    public const CONDITION_EXCELLENT = 1;
    public const CONDITION_GOOD      = 2;
    public const CONDITION_FAIR      = 3;
    public const CONDITION_POOR      = 4;

    public const STATUS_AVAILABLE   = 1;
    public const STATUS_CHECKED_OUT = 2;
    public const STATUS_MAINTENANCE = 3;
    public const STATUS_OVERDUE     = 4;

    protected $fillable = [
        'category_id',
        'qr_code',
        'serial_number',
        'model',
        'manufacturer',
        'caliber',
        'condition_status',
        'current_location_id',
        'availability_status',
        'acquisition_date',
        'acquisition_cost',
        'next_maintenance_due',
        'remarks',
    ];

    protected $casts = [
        'acquisition_date'      => 'date',
        'next_maintenance_due'  => 'date',
        'acquisition_cost'      => 'decimal:2',
        'condition_status'      => 'integer',
        'availability_status'   => 'integer',
        'tracker_battery_pct'   => 'integer',
        'tracker_battery_mv'    => 'integer',
        'tracker_battery_at'    => 'datetime',
    ];

    protected $appends = ['condition_label', 'availability_label'];

    public function category(): BelongsTo
    {
        return $this->belongsTo(EquipmentCategory::class, 'category_id', 'category_id');
    }

    public function currentLocation(): BelongsTo
    {
        return $this->belongsTo(GpsLocation::class, 'current_location_id', 'location_id');
    }

    public function transactions(): HasMany
    {
        return $this->hasMany(Transaction::class, 'equipment_id', 'equipment_id');
    }

    public function activeTransaction()
    {
        return $this->transactions()
            ->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->latest('checkout_at')
            ->first();
    }

    public function repairs(): HasMany
    {
        return $this->hasMany(RepairRequest::class, 'equipment_id', 'equipment_id');
    }

    public function maintenanceRecords(): HasMany
    {
        return $this->hasMany(MaintenanceRecord::class, 'equipment_id', 'equipment_id');
    }

    public function gpsLogs(): HasMany
    {
        return $this->hasMany(GpsLog::class, 'equipment_id', 'equipment_id');
    }

    public function latestGps()
    {
        return $this->gpsLogs()->latest('captured_at')->first();
    }

    public function getConditionLabelAttribute(): string
    {
        return match ((int) $this->condition_status) {
            self::CONDITION_EXCELLENT => 'Excellent',
            self::CONDITION_GOOD      => 'Good',
            self::CONDITION_FAIR      => 'Fair',
            self::CONDITION_POOR      => 'Poor',
            default                   => 'Unknown',
        };
    }

    public function getAvailabilityLabelAttribute(): string
    {
        return match ((int) $this->availability_status) {
            self::STATUS_AVAILABLE   => 'Available',
            self::STATUS_CHECKED_OUT => 'Checked Out',
            self::STATUS_MAINTENANCE => 'Maintenance',
            self::STATUS_OVERDUE     => 'Overdue',
            default                  => 'Unknown',
        };
    }

    public function qrPayload(): array
    {
        return [
            'equipment_id'   => $this->equipment_id,
            'serial_number'  => $this->serial_number,
            'category_code'  => optional($this->category)->category_code,
            'qr_code'        => $this->qr_code,
            'status'         => $this->availability_label,
        ];
    }
}
