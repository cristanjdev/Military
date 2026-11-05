<?php

namespace App\Services;

use App\Models\FirearmEquipment;
use App\Models\Notification;
use App\Models\Transaction;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Warns when an issued firearm's tracker battery runs low: "Low Battery" at armory.gps.battery_low_pct
 * (20 %) and "Battery Critical" at armory.gps.battery_critical_pct (10 %), each once per discharge.
 *
 * The battery level arrives with every position (ingest) and with the status reports a tracker sends
 * while it has no GPS fix, so a tracker kept indoors still warns before it dies. A recharged or
 * swapped battery re-arms the alerts once it reads 5 points above the threshold, so a reading that
 * wobbles around 20 % does not repeat them. In-app only, like the tracker's signal alerts.
 */
class TrackerBattery
{
    private const REARM_MARGIN = 5;

    /**
     * Keeps the latest reading on the firearm, so the GPS page shows it even while the tracker
     * has no fix. A plain query: it must not change the firearm's updated_at or audit trail.
     */
    public static function record(int $equipmentId, ?int $pct): void
    {
        if ($pct === null) {
            return;
        }
        DB::table('firearm_equipment')->where('equipment_id', $equipmentId)->update([
            'tracker_battery_pct' => $pct,
            'tracker_battery_at'  => now(),
        ]);
    }

    public static function check(Transaction $tx, FirearmEquipment $firearm, ?int $pct, string $deviceId): void
    {
        if ($pct === null) {
            return;
        }
        $low = (int) config('armory.gps.battery_low_pct', 20);
        $critical = (int) config('armory.gps.battery_critical_pct', 10);

        $key = 'tracker-battery:' . $tx->transaction_id;
        $alerted = (int) Cache::get($key, 0); // 0 none, 1 low, 2 critical
        if ($pct > $low + self::REARM_MARGIN) {
            $alerted = 0;
        } elseif ($pct > $critical + self::REARM_MARGIN) {
            $alerted = min($alerted, 1);
        }

        $level = $pct <= $critical ? 2 : ($pct <= $low ? 1 : 0);
        if ($level > $alerted) {
            $alerted = $level;
            $holder = optional($tx->user)->fullName();
            $message = $level === 2
                ? "Tracker {$deviceId} on {$firearm->serial_number} is at {$pct}% battery and will shut off soon. Recharge or replace the battery."
                : "Tracker {$deviceId} on {$firearm->serial_number} is at {$pct}% battery. Plan to recharge it.";
            try {
                Notification::notifyRoles([
                    'equipment_id' => $firearm->equipment_id,
                    'type'         => $level === 2 ? 'battery_critical' : 'battery_low',
                    'severity'     => $level === 2 ? Notification::SEVERITY_CRITICAL : Notification::SEVERITY_WARNING,
                    'title'        => $level === 2 ? 'Battery Critical' : 'Low Battery',
                    'message'      => $message . ($holder ? " Issued to {$holder}." : ''),
                    'payload'      => ['device_id' => $deviceId, 'transaction_id' => $tx->transaction_id, 'battery_pct' => $pct],
                ], alsoUserIds: [$tx->authorized_by]);
            } catch (\Throwable $e) {
                Log::warning('Tracker battery notification failed: ' . $e->getMessage());
            }
        }

        Cache::put($key, $alerted, now()->addDays(7));
    }
}
