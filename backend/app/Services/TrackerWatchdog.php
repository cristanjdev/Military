<?php

namespace App\Services;

use App\Models\FirearmEquipment;
use App\Models\GpsLog;
use App\Models\Notification;
use App\Models\Transaction;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Notices when an issued firearm's IoT tracker goes quiet or comes back.
 *
 *   online → silent for longer than the online window  : "Signal Lost: location updates stopped"
 *   silent → reporting again                           : "Signal Restored"
 *   first report for an issuance                        : "IoT Tracker Online"
 *
 * Each device's last known state lives in the cache. The ingest endpoint calls seen() on every
 * report, so a restored signal is announced at once; sweep() finds the silent ones. sweep() runs
 * from the topbar's status poll (throttled) and from the armory:tracker-watch command, so it works
 * whether or not the Laravel scheduler is running.
 *
 * These are in-app notifications only: a tracker drifting in and out of hotspot range would
 * otherwise send a stream of e-mails to every officer.
 */
class TrackerWatchdog
{
    private const SWEEP_EVERY_SECONDS = 15;

    public static function onlineWindow(): int
    {
        return max(60, (int) config('armory.gps.interval_seconds', 30) * 4);
    }

    /** Called for every accepted GPS report. */
    public static function seen(string $deviceId, FirearmEquipment $firearm, Transaction $transaction): void
    {
        $key = self::key($deviceId);
        $state = Cache::get($key);

        if (($state['transaction_id'] ?? null) !== $transaction->transaction_id) {
            self::notify($firearm, $transaction, $deviceId, 'iot_device_online', Notification::SEVERITY_INFO, 'IoT Tracker Online',
                "Tracker {$deviceId} on {$firearm->serial_number} is now sending its location.");
        } elseif (($state['status'] ?? null) === 'offline') {
            self::notify($firearm, $transaction, $deviceId, 'signal_restored', Notification::SEVERITY_INFO, 'Signal Restored',
                "Tracker {$deviceId} on {$firearm->serial_number} is sending location updates again.");
        }

        Cache::forever($key, ['status' => 'online', 'transaction_id' => $transaction->transaction_id]);
    }

    /** Throttled sweep, cheap enough to call from a frequently polled endpoint. */
    public static function maybeSweep(): void
    {
        if (Cache::add('tracker-watchdog:sweep', true, self::SWEEP_EVERY_SECONDS)) {
            try {
                self::sweep();
            } catch (\Throwable $e) {
                Log::warning('Tracker watchdog sweep failed: ' . $e->getMessage());
            }
        }
    }

    /** @return int number of trackers newly reported silent */
    public static function sweep(): int
    {
        $silentSince = now()->subSeconds(self::onlineWindow());
        $lost = 0;

        $transactions = Transaction::with(['firearm', 'user'])
            ->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->where('gps_tracking_enabled', true)
            ->get();

        foreach ($transactions as $tx) {
            $latest = GpsLog::where('transaction_id', $tx->transaction_id)
                ->whereNotNull('device_id')
                ->latest('received_at')
                ->first();
            if (! $latest || ! $tx->firearm) {
                continue; // never reported: nothing was lost
            }

            $key = self::key($latest->device_id);
            $state = Cache::get($key);
            $lastSeen = $latest->received_at ?? $latest->captured_at;
            $silent = ! $lastSeen || $lastSeen->lt($silentSince);

            if (! $state) {
                // First look at this tracker (new install, or the cache was cleared): record what it
                // is doing now. A tracker that went quiet before anyone watched is not news.
                Cache::forever($key, ['status' => $silent ? 'offline' : 'online', 'transaction_id' => $tx->transaction_id]);
                continue;
            }

            if ($silent && ($state['status'] ?? null) === 'online') {
                // Mark it first, so an overlapping sweep cannot announce the same loss twice.
                Cache::forever($key, ['status' => 'offline', 'transaction_id' => $tx->transaction_id]);
                $lost++;
                self::notify($tx->firearm, $tx, $latest->device_id, 'signal_lost', Notification::SEVERITY_WARNING, 'Signal Lost: Location Updates Stopped',
                    sprintf(
                        'Tracker %s on %s stopped sending location updates. Last position %.5f, %.5f, %s.%s',
                        $latest->device_id,
                        $tx->firearm->serial_number,
                        $latest->latitude,
                        $latest->longitude,
                        $lastSeen ? $lastSeen->diffForHumans() : 'time unknown',
                        // A flat battery is the likeliest cause when the last reading was already low.
                        $latest->battery_pct !== null ? " Last battery reading {$latest->battery_pct}%." : '',
                    ),
                    ['lat' => $latest->latitude, 'lon' => $latest->longitude, 'last_seen_at' => $lastSeen?->toIso8601String()]);
            }
        }

        return $lost;
    }

    private static function notify(
        FirearmEquipment $firearm,
        Transaction $transaction,
        string $deviceId,
        string $type,
        string $severity,
        string $title,
        string $message,
        array $extra = [],
    ): void {
        $holder = optional($transaction->user)->fullName();
        try {
            Notification::notifyRoles([
                'equipment_id' => $firearm->equipment_id,
                'type'         => $type,
                'severity'     => $severity,
                'title'        => $title,
                'message'      => $message . ($holder ? " Issued to {$holder}." : ''),
                'payload'      => ['device_id' => $deviceId, 'transaction_id' => $transaction->transaction_id] + $extra,
            ], alsoUserIds: [$transaction->authorized_by]);
        } catch (\Throwable $e) {
            Log::warning("Tracker notification '{$type}' failed: " . $e->getMessage());
        }
    }

    private static function key(string $deviceId): string
    {
        return 'tracker-state:' . $deviceId;
    }
}
