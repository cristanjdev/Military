<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MaintenanceRecord extends Model
{
    use HasFactory;

    protected $primaryKey = 'maintenance_id';

    /** Whether the firearm is fit for use once the work is done. */
    public const RESULT_SERVICEABLE   = 1;
    public const RESULT_NEEDS_REPAIR  = 2;
    public const RESULT_UNSERVICEABLE = 3;

    public const RESULT_LABELS = [
        self::RESULT_SERVICEABLE   => 'Serviceable',
        self::RESULT_NEEDS_REPAIR  => 'Needs Further Repair',
        self::RESULT_UNSERVICEABLE => 'Unserviceable',
    ];

    protected $fillable = [
        'equipment_id',
        'performed_by',
        'repaired_by',
        'description',
        'maintenance_date',
        'next_schedule',
        'maintenance_type',
        'result_status',
        'cost',
        'parts_replaced',
        'remarks',
    ];

    protected $casts = [
        'maintenance_date' => 'datetime',
        'next_schedule'    => 'datetime',
        'parts_replaced'   => 'array',
        'result_status'    => 'integer',
        'cost'             => 'integer',
    ];

    public function resultLabel(): string
    {
        return self::RESULT_LABELS[$this->result_status] ?? 'Unknown';
    }

    public function firearm(): BelongsTo
    {
        return $this->belongsTo(FirearmEquipment::class, 'equipment_id', 'equipment_id');
    }

    public function technician(): BelongsTo
    {
        return $this->belongsTo(User::class, 'performed_by', 'user_id')->withTrashed();
    }
}
