<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A firearm's repair, from the Custodian's report to its return from maintenance:
 * Custodian → S4 Officer → Command Officer (approval) → S4 Officer → Custodian.
 */
class RepairRequest extends Model
{
    protected $primaryKey = 'repair_id';

    public const STATUS_REPORTED  = 'reported';   // Custodian reported it to the S4 Officer
    public const STATUS_FORWARDED = 'forwarded';  // S4 Officer sent it to the Command Officer
    public const STATUS_APPROVED  = 'approved';   // Command Officer approved
    public const STATUS_REJECTED  = 'rejected';   // Command Officer rejected
    public const STATUS_IN_REPAIR = 'in_repair';  // Sent for repair
    public const STATUS_COMPLETED = 'completed';  // Back from maintenance

    /** Statuses in which the firearm is tied up by this repair. */
    public const OPEN_STATUSES = [
        self::STATUS_REPORTED,
        self::STATUS_FORWARDED,
        self::STATUS_APPROVED,
        self::STATUS_IN_REPAIR,
    ];

    public const STATUS_LABELS = [
        self::STATUS_REPORTED  => 'Reported to S4',
        self::STATUS_FORWARDED => 'Waiting for Commander',
        self::STATUS_APPROVED  => 'Approved',
        self::STATUS_REJECTED  => 'Rejected',
        self::STATUS_IN_REPAIR => 'In Repair',
        self::STATUS_COMPLETED => 'Back from Maintenance',
    ];

    protected $fillable = [
        'equipment_id', 'status',
        'problem', 'damaged_at', 'reported_by', 'reported_at',
        'estimated_cost', 's4_notes', 'forwarded_by', 'forwarded_at',
        'decided_by', 'decided_at', 'decision_note',
        'informed_by', 'custodian_informed_at',
        'sent_by', 'sent_at', 'received_by', 'received_by_unit',
        'repaired_at', 'returned_to', 'returned_at', 'result_status', 'cost', 'work_done', 'maintenance_id',
    ];

    protected $casts = [
        'damaged_at'            => 'date:Y-m-d',
        'reported_at'           => 'datetime',
        'forwarded_at'          => 'datetime',
        'decided_at'            => 'datetime',
        'custodian_informed_at' => 'datetime',
        'sent_at'               => 'datetime',
        'repaired_at'           => 'date:Y-m-d',
        'returned_at'           => 'datetime',
        'estimated_cost'        => 'integer',
        'cost'                  => 'integer',
        'result_status'         => 'integer',
    ];

    protected $appends = ['status_label', 'result_label'];

    public function getStatusLabelAttribute(): string
    {
        return self::STATUS_LABELS[$this->status] ?? $this->status;
    }

    public function getResultLabelAttribute(): ?string
    {
        return $this->result_status ? (MaintenanceRecord::RESULT_LABELS[$this->result_status] ?? null) : null;
    }

    public function isOpen(): bool
    {
        return in_array($this->status, self::OPEN_STATUSES, true);
    }

    public function firearm(): BelongsTo
    {
        return $this->belongsTo(FirearmEquipment::class, 'equipment_id', 'equipment_id');
    }

    public function reporter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reported_by', 'user_id')->withTrashed();
    }

    public function forwarder(): BelongsTo
    {
        return $this->belongsTo(User::class, 'forwarded_by', 'user_id')->withTrashed();
    }

    public function decider(): BelongsTo
    {
        return $this->belongsTo(User::class, 'decided_by', 'user_id')->withTrashed();
    }

    public function informer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'informed_by', 'user_id')->withTrashed();
    }

    public function sender(): BelongsTo
    {
        return $this->belongsTo(User::class, 'sent_by', 'user_id')->withTrashed();
    }

    public function returnReceiver(): BelongsTo
    {
        return $this->belongsTo(User::class, 'returned_to', 'user_id')->withTrashed();
    }

    public function gpsLogs(): HasMany
    {
        return $this->hasMany(GpsLog::class, 'repair_id', 'repair_id');
    }

    /** The relations every repair response carries. */
    public static function withPeople(): array
    {
        $person = ':user_id,rank,first_name,last_name,username,deleted_at';
        return [
            'firearm:equipment_id,serial_number,model,availability_status,condition_status',
            "reporter{$person}", "forwarder{$person}", "decider{$person}",
            "informer{$person}", "sender{$person}", "returnReceiver{$person}",
        ];
    }
}
