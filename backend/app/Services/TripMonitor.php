<?php

namespace App\Services;

use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use App\Models\GpsLog;
use App\Models\Notification;
use App\Models\Transaction;
use Illuminate\Support\Collection;

/**
 * Follows an issued firearm from the camp to its assigned destination and back.
 *
 *   at_camp      --leaves camp-->            outbound      "Left Camp"                (info)
 *   outbound     --enters destination-->     on_site       "Arrived at Destination"   (info)
 *   on_site      --leaves after the hold-->  returning     "Left Destination"         (info)
 *   on_site      --leaves before the hold--> returning     "Premature Departure"      (critical)
 *   returning    --enters camp-->            back_at_camp  "Returned to Camp"         (info)
 *   back_at_camp --leaves camp-->            back_at_camp  "Left Camp After Return"   (critical)
 *   any stage    --enters another zone-->                  "Off-Route"                (critical)
 *   returning    --re-enters destination after the hold--> "Off-Route"                (critical)
 *
 * The hold is armory.gps.destination_hold_minutes (90). The firearm may only leave the camp again
 * after it has been officially returned and issued anew, which starts a new transaction.
 *
 * A move counts once two reports in a row agree on where the firearm is, so a single jittery fix
 * at a zone's edge does not raise an alert. Transactions without a destination (issued before
 * this feature) keep the plain "left all zones" geofence alert in GpsController.
 */
class TripMonitor
{
    public const PLACE_CAMP        = 'camp';
    public const PLACE_DESTINATION = 'destination';
    public const PLACE_AWAY        = 'away';

    /** Called for every accepted GPS report of a transaction that has a destination. */
    public static function track(Transaction $tx, FirearmEquipment $firearm, GpsLog $log, Collection $zones): void
    {
        $destination = $zones->firstWhere('location_id', $tx->destination_location_id);
        if (! $destination) {
            return; // the destination zone was deleted: nothing to measure against
        }

        $previous = GpsLog::where('transaction_id', $tx->transaction_id)
            ->where('gps_log_id', '!=', $log->gps_log_id)
            ->latest('captured_at')
            ->first();
        if (! $previous) {
            return; // the first report confirms nothing yet
        }

        $place = self::placeOf((float) $log->latitude, (float) $log->longitude, $destination, $zones);
        if ($place !== self::placeOf((float) $previous->latitude, (float) $previous->longitude, $destination, $zones)) {
            return; // not confirmed by two reports in a row
        }

        $from = $tx->trip_place ?? self::PLACE_CAMP;
        if ($place === $from) {
            return;
        }

        $stage = $tx->trip_stage ?? Transaction::TRIP_AT_CAMP;
        // The move happened at the first of the two agreeing reports.
        $movedAt = $previous->captured_at;
        $updates = ['trip_place' => $place];
        $notify = fn(string $type, string $severity, string $title, string $message) =>
            self::notify($tx, $firearm, $log, $destination, $zones, $type, $severity, $title, $message);
        $holder = optional($tx->user)->fullName() ?? 'unknown personnel';
        $who = "{$firearm->serial_number} ({$holder})";

        // Leaving the place it was supposed to be.
        if ($from === self::PLACE_CAMP && $stage === Transaction::TRIP_AT_CAMP) {
            $stage = Transaction::TRIP_OUTBOUND;
            $notify('trip_left_camp', Notification::SEVERITY_INFO, 'Left Camp',
                "{$who} left the camp, heading to {$destination->location_name}.");
        } elseif ($from === self::PLACE_CAMP && $stage === Transaction::TRIP_BACK_AT_CAMP) {
            $notify('camp_exit_after_return', Notification::SEVERITY_CRITICAL, 'Left Camp After Return',
                "{$who} left the camp again after returning from {$destination->location_name}. "
                . 'It may not leave until it is returned to the armory and issued again.');
        } elseif ($from === self::PLACE_DESTINATION && $stage === Transaction::TRIP_ON_SITE) {
            $stage = Transaction::TRIP_RETURNING;
            $hold = self::holdMinutes();
            $stayed = self::minutesStayed($tx, $movedAt);
            if ($stayed < $hold) {
                $notify('premature_departure', Notification::SEVERITY_CRITICAL, 'Premature Departure',
                    "{$who} left {$destination->location_name} after {$stayed} min; it must stay {$hold} min.");
            } else {
                $notify('trip_left_destination', Notification::SEVERITY_INFO, 'Left Destination',
                    "{$who} left {$destination->location_name} after {$stayed} min and must go straight back to the camp.");
            }
        }

        // Arriving somewhere.
        if ($place === self::PLACE_DESTINATION) {
            if ($stage === Transaction::TRIP_OUTBOUND) {
                $stage = Transaction::TRIP_ON_SITE;
                $updates['destination_arrived_at'] = $movedAt;
                $notify('trip_arrived', Notification::SEVERITY_INFO, 'Arrived at Destination',
                    "{$who} arrived at {$destination->location_name}.");
            } elseif ($stage === Transaction::TRIP_RETURNING && self::holdServed($tx, $movedAt)) {
                // The stay is over, so the only place left to go is the camp.
                $notify('off_route', Notification::SEVERITY_CRITICAL, 'Off-Route',
                    "{$who} went back to {$destination->location_name} after its stay ended. It must go straight back to the camp.");
            } elseif ($stage === Transaction::TRIP_RETURNING) {
                // Back before the stay is over: the hold keeps counting from the first arrival.
                $stage = Transaction::TRIP_ON_SITE;
                $notify('trip_arrived', Notification::SEVERITY_INFO, 'Back at Destination',
                    "{$who} is back at {$destination->location_name}.");
            }
        } elseif ($place === self::PLACE_CAMP) {
            if ($stage === Transaction::TRIP_OUTBOUND) {
                $stage = Transaction::TRIP_AT_CAMP;
                $notify('trip_returned', Notification::SEVERITY_INFO, 'Back at Camp',
                    "{$who} came back to the camp before reaching {$destination->location_name}.");
            } elseif ($stage === Transaction::TRIP_RETURNING) {
                $stage = Transaction::TRIP_BACK_AT_CAMP;
                $notify('trip_returned', Notification::SEVERITY_INFO, 'Returned to Camp',
                    "{$who} is back at the camp from {$destination->location_name}.");
            } elseif ($stage === Transaction::TRIP_BACK_AT_CAMP) {
                $notify('trip_returned', Notification::SEVERITY_INFO, 'Back Inside Camp',
                    "{$who} is back inside the camp.");
            }
        } elseif (str_starts_with($place, 'other:')) {
            $names = self::zonesAt($place, $zones)->pluck('location_name')->implode(', ');
            $notify('off_route', Notification::SEVERITY_CRITICAL, 'Off-Route',
                "{$who} entered {$names}, which is not its destination ({$destination->location_name}).");
        }

        $tx->update($updates + ['trip_stage' => $stage]);
    }

    private static function minutesStayed(Transaction $tx, $until): int
    {
        return (int) floor(($tx->destination_arrived_at ?? $until)->diffInSeconds($until, true) / 60);
    }

    private static function holdServed(Transaction $tx, $until): bool
    {
        return self::minutesStayed($tx, $until) >= self::holdMinutes();
    }

    public static function holdMinutes(): int
    {
        return max(1, (int) config('armory.gps.destination_hold_minutes', 90));
    }

    /** camp | destination | away (outside every zone) | other:<ids> (inside zones that are neither). */
    public static function placeOf(float $lat, float $lon, GpsLocation $destination, Collection $zones): string
    {
        if ($destination->contains($lat, $lon)) {
            return self::PLACE_DESTINATION;
        }
        $inside = $zones->filter(fn(GpsLocation $z) => $z->contains($lat, $lon));
        if ($inside->contains(fn(GpsLocation $z) => $z->isCamp())) {
            return self::PLACE_CAMP;
        }
        if ($inside->isEmpty()) {
            return self::PLACE_AWAY;
        }
        return 'other:' . $inside->pluck('location_id')->sort()->implode(',');
    }

    private static function zonesAt(string $place, Collection $zones): Collection
    {
        $ids = array_map('intval', explode(',', substr($place, strlen('other:'))));
        return $zones->filter(fn(GpsLocation $z) => in_array((int) $z->location_id, $ids, true));
    }

    private static function notify(
        Transaction $tx,
        FirearmEquipment $firearm,
        GpsLog $log,
        GpsLocation $destination,
        Collection $zones,
        string $type,
        string $severity,
        string $title,
        string $message,
    ): void {
        $critical = $severity === Notification::SEVERITY_CRITICAL;
        Notification::notifyRoles([
            'equipment_id' => $firearm->equipment_id,
            'type'         => $type,
            'severity'     => $severity,
            'title'        => $title,
            'message'      => $message,
            'payload'      => [
                'lat'            => $log->latitude,
                'lon'            => $log->longitude,
                'transaction_id' => $tx->transaction_id,
                'destination'    => $destination->location_name,
                'zones'          => $zones
                    ->filter(fn(GpsLocation $z) => $z->contains((float) $log->latitude, (float) $log->longitude))
                    ->pluck('location_name')->values()->all(),
            ],
        ], alsoUserIds: [$tx->authorized_by], emailUserIds: $critical ? [$tx->authorized_by] : []);
    }
}
