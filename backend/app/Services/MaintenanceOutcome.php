<?php

namespace App\Services;

use App\Models\FirearmEquipment;
use App\Models\MaintenanceRecord;

/**
 * What a maintenance result does to the firearm: its condition, and whether it can be issued again.
 */
class MaintenanceOutcome
{
    public static function apply(FirearmEquipment $firearm, int $resultStatus, ?string $nextSchedule = null): void
    {
        $update = ['next_maintenance_due' => $nextSchedule];

        $update['condition_status'] = match ($resultStatus) {
            MaintenanceRecord::RESULT_SERVICEABLE  => min($firearm->condition_status ?: FirearmEquipment::CONDITION_GOOD, FirearmEquipment::CONDITION_GOOD),
            MaintenanceRecord::RESULT_NEEDS_REPAIR => FirearmEquipment::CONDITION_FAIR,
            default                                => FirearmEquipment::CONDITION_POOR,
        };

        // A firearm that is still out with someone keeps its checked-out/overdue status.
        $isOut = in_array((int) $firearm->availability_status, [FirearmEquipment::STATUS_CHECKED_OUT, FirearmEquipment::STATUS_OVERDUE], true);
        if (! $isOut) {
            $update['availability_status'] = $resultStatus === MaintenanceRecord::RESULT_SERVICEABLE
                ? FirearmEquipment::STATUS_AVAILABLE
                : FirearmEquipment::STATUS_MAINTENANCE;
        }

        $firearm->update($update);
    }
}
