<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One outdoor test of a firearm's tracker. See FieldTestReport for how the numbers are measured.
 */
class FieldTest extends Model
{
    protected $primaryKey = 'field_test_id';

    protected $fillable = [
        'equipment_id', 'started_by', 'started_at', 'ended_at',
        'reference_latitude', 'reference_longitude',
    ];

    protected $casts = [
        'started_at'          => 'datetime',
        'ended_at'            => 'datetime',
        'reference_latitude'  => 'float',
        'reference_longitude' => 'float',
    ];

    public function isOpen(): bool
    {
        return $this->ended_at === null;
    }

    public function hasReference(): bool
    {
        return $this->reference_latitude !== null && $this->reference_longitude !== null;
    }

    public function firearm(): BelongsTo
    {
        return $this->belongsTo(FirearmEquipment::class, 'equipment_id', 'equipment_id');
    }

    public function starter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'started_by', 'user_id');
    }

    public function marks(): HasMany
    {
        return $this->hasMany(FieldTestMark::class, 'field_test_id', 'field_test_id')->orderBy('occurred_at')->orderBy('mark_id');
    }
}
