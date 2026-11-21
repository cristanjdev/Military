<?php

namespace App\Services;

use App\Models\FieldTest;
use App\Models\FieldTestMark;
use App\Models\GpsLog;
use App\Models\Notification;

/**
 * Turns a field test into measured numbers, from the tracker's own positions and the system's
 * alerts while the test ran, compared with what the testers tapped:
 *
 *   Update latency      time from the GPS fix to the server receiving it (both are stored per position)
 *   Distance error      how far the positions are from the marked spot while the tracker sits on it
 *   Hotspot range       the farthest the tracker got from the phone (on the marked spot) and still sent live
 *   Signal reliability  positions received ÷ positions expected, one per tracker interval
 *   Geofence accuracy   zone crossings the system detected ÷ crossings the testers made (+ false ones)
 *   Alert accuracy      "Signal Lost" / "Signal Restored" alerts that fired ÷ times the tracker really went
 *                       silent and came back (+ false ones), read from when its positions arrived
 *
 * Periods with the hotspot deliberately off, and the range walk, are left out of latency and
 * reliability: the tracker keeps up to 8 positions while it is cut off and sends them late, which
 * says nothing about the normal delay.
 */
class FieldTestReport
{
    /** A position received within this many seconds of being taken was sent live, not from the tracker's backlog. */
    private const LIVE_SECONDS = 15;
    /** Seconds after the hotspot comes back (or the range walk ends) while the tracker rejoins it; not counted. */
    private const RECONNECT_GRACE = 60;
    /** A detected crossing may be up to this long before the tap (the tester tapped late)... */
    private const CROSSING_BEFORE = 60;
    /** ...or this long after it (the next position comes up to one interval later). */
    private const CROSSING_AFTER = 120;
    /** Extra wait for "Signal Lost" past the silent window: the watchdog checks once a minute, plus slack. */
    private const LOST_EXTRA = 240;
    /** Wait for "Signal Restored" after the hotspot is back on. */
    private const RESTORE_WAIT = 180;
    /** Alert rows within this many seconds of each other are one alert (one row is stored per recipient). */
    private const SAME_ALERT = 10;

    public static function build(FieldTest $test): array
    {
        $now      = now()->getTimestamp();
        $start    = $test->started_at->getTimestamp();
        $end      = $test->ended_at ? $test->ended_at->getTimestamp() : $now;
        $interval = max(1, (int) config('armory.gps.interval_seconds', 30));
        $targets  = config('armory.field_test');

        $marks = $test->marks->map(fn(FieldTestMark $m) => ['kind' => $m->kind, 't' => $m->occurred_at->getTimestamp()])->all();

        $spot  = self::windows($marks, FieldTestMark::SPOT_START, FieldTestMark::SPOT_END, $end);
        $range = self::windows($marks, FieldTestMark::RANGE_START, FieldTestMark::RANGE_END, $end);
        $zone  = self::windows($marks, FieldTestMark::ZONE_START, FieldTestMark::ZONE_END, $end);
        $off   = self::windows($marks, FieldTestMark::HOTSPOT_OFF, FieldTestMark::HOTSPOT_ON, $end);

        $ref = $test->hasReference() ? [$test->reference_latitude, $test->reference_longitude] : null;

        $logs = GpsLog::where('equipment_id', $test->equipment_id)
            ->whereNotNull('device_id')
            ->whereBetween('captured_at', [$test->started_at, $test->ended_at ?? now()])
            ->orderBy('captured_at')
            ->limit(20000)
            ->get(['captured_at', 'received_at', 'latitude', 'longitude', 'satellites', 'is_inside_geofence'])
            ->map(function (GpsLog $l) use ($ref) {
                $t = $l->captured_at->getTimestamp();
                $r = $l->received_at ? $l->received_at->getTimestamp() : $t;
                return [
                    't'      => $t,
                    'r'      => $r,
                    'delay'  => max(0, $r - $t),
                    'lat'    => (float) $l->latitude,
                    'lng'    => (float) $l->longitude,
                    'sats'   => $l->satellites,
                    'inside' => $l->is_inside_geofence,
                    'dist'   => $ref ? self::meters($ref[0], $ref[1], (float) $l->latitude, (float) $l->longitude) : null,
                ];
            })
            ->all();

        $cutOff = array_merge($off, $range); // hotspot deliberately unreachable

        // Older tests could run steps at once; the tracker is only still while nothing else runs.
        $still = self::subtract([$start, $end], array_merge($range, $zone));
        $spotStill = [];
        foreach ($spot as [$a, $b]) {
            foreach ($still as [$c, $d]) {
                if (min($b, $d) > max($a, $c)) {
                    $spotStill[] = [max($a, $c), min($b, $d), false];
                }
            }
        }

        $latency     = self::latency($logs, $cutOff, $targets);
        $distance    = self::distance($logs, $spotStill, $ref, $targets);
        $rangeResult = self::range($logs, $range, $ref, $interval, $now, $targets);
        $reliability = self::reliability($logs, $cutOff, $end, $interval, $targets);
        $geofence    = self::geofence($logs, $marks, $zone, $now, $targets);
        $alerts      = self::alerts($test, $logs, $off, $range, $end, $now, $targets);

        $last = $logs ? end($logs) : null;

        return [
            'interval_seconds' => $interval,
            'positions'        => count($logs),
            'last_position'    => $last ? [
                'captured_at' => date(DATE_ATOM, $last['t']),
                'seconds_ago' => max(0, $now - $last['t']),
                'latitude'    => $last['lat'],
                'longitude'   => $last['lng'],
                'satellites'  => $last['sats'],
                'inside_zone' => $last['inside'],
                'distance_m'  => $last['dist'] !== null ? round($last['dist'], 1) : null,
            ] : null,
            'phases' => [
                'spot'        => self::isOpen($spot),
                'range'       => self::isOpen($range),
                'zone'        => self::isOpen($zone),
                'hotspot_off' => self::isOpen($off),
            ],
            'metrics' => [
                'latency'     => $latency,
                'distance'    => $distance,
                'range'       => $rangeResult,
                'reliability' => $reliability,
                'geofence'    => $geofence,
                'alerts'      => $alerts,
            ],
        ];
    }

    private static function latency(array $logs, array $cutOff, array $targets): array
    {
        $limit = (int) config('armory.gps.latency_budget_seconds', 5);
        $delays = [];
        foreach ($logs as $l) {
            if (! self::within($l['t'], $cutOff)) {
                $delays[] = $l['delay'];
            }
        }
        sort($delays);
        $pct = self::share($delays, fn($d) => $d <= $limit);

        return [
            'samples'    => count($delays),
            'limit'      => $limit,
            'target_pct' => (int) $targets['latency_target_pct'],
            'pct'        => $pct,
            'median'     => self::percentile($delays, 0.5),
            'p95'        => self::percentile($delays, 0.95),
            'max'        => $delays ? end($delays) : null,
            'pass'       => $pct === null ? null : $pct >= $targets['latency_target_pct'],
        ];
    }

    private static function distance(array $logs, array $spot, ?array $ref, array $targets): array
    {
        $limit = (int) config('armory.gps.accuracy_meters', 10);
        $errors = [];
        if ($ref) {
            foreach ($logs as $l) {
                if (self::within($l['t'], $spot)) {
                    $errors[] = $l['dist'];
                }
            }
        }
        sort($errors);
        $pct = self::share($errors, fn($d) => $d <= $limit);

        return [
            'samples'       => count($errors),
            'has_reference' => (bool) $ref,
            'limit'         => $limit,
            'target_pct'    => (int) $targets['distance_target_pct'],
            'pct'           => $pct,
            'median'        => self::round1(self::percentile($errors, 0.5)),
            'p90'           => self::round1(self::percentile($errors, 0.9)),
            'max'           => self::round1($errors ? end($errors) : null),
            'pass'          => $pct === null ? null : $pct >= $targets['distance_target_pct'],
        ];
    }

    /**
     * The farthest live position during the range walks. "lost" tells whether the walk actually
     * reached the point where updates stopped; until then the farthest distance is only a lower bound.
     */
    private static function range(array $logs, array $range, ?array $ref, int $interval, int $now, array $targets): array
    {
        $farthest = null;
        $live = 0;
        $lost = false;
        $current = null;

        if ($ref) {
            foreach ($range as [$a, $b]) {
                $prev = $a;
                foreach ($logs as $l) {
                    if ($l['t'] < $a || $l['t'] > $b || $l['delay'] > self::LIVE_SECONDS) {
                        continue;
                    }
                    $live++;
                    $farthest = max($farthest ?? 0, $l['dist']);
                    if ($l['t'] - $prev > 2 * $interval) {
                        $lost = true;
                    }
                    $prev = $l['t'];
                    $current = $l['dist'];
                }
                if (min($b, $now) - $prev > 2 * $interval) {
                    $lost = true;
                }
            }
        }

        $target = (int) $targets['range_target_meters'];

        return [
            'samples'       => $live,
            'has_reference' => (bool) $ref,
            'target_m'      => $target,
            'farthest_m'    => self::round1($farthest),
            'current_m'     => self::isOpen($range) ? self::round1($current) : null,
            'lost'          => $lost,
            'pass'          => $farthest === null ? null : $farthest >= $target,
        ];
    }

    private static function reliability(array $logs, array $cutOff, int $end, int $interval, array $targets): array
    {
        $first = $logs[0]['t'] ?? null;
        if ($first === null) {
            return ['samples' => 0, 'received' => 0, 'missed' => 0, 'pct' => null,
                'target_pct' => (int) $targets['reliability_target_pct'], 'pass' => null];
        }

        // Counted from the first position, so the GPS warming up is not held against it.
        $gaps = array_map(fn($w) => [$w[0], $w[1] + self::RECONNECT_GRACE], $cutOff);
        $segments = self::subtract([$first, $end], $gaps);

        $received = 0;
        $missed = 0;
        foreach ($segments as [$a, $b]) {
            $prev = $a;
            foreach ($logs as $l) {
                if ($l['t'] < $a || $l['t'] > $b) {
                    continue;
                }
                $received++;
                $missed += max(0, (int) round(($l['t'] - $prev) / $interval) - 1);
                $prev = $l['t'];
            }
            $missed += max(0, (int) round(($b - $prev) / $interval) - 1);
        }

        $pct = ($received + $missed) > 0 ? round(100 * $received / ($received + $missed), 1) : null;

        return [
            'samples'    => $received + $missed,
            'received'   => $received,
            'missed'     => $missed,
            'pct'        => $pct,
            'target_pct' => (int) $targets['reliability_target_pct'],
            'pass'       => $pct === null ? null : $pct >= $targets['reliability_target_pct'],
        ];
    }

    private static function geofence(array $logs, array $marks, array $zone, int $now, array $targets): array
    {
        // Crossings the system saw: a position whose inside/outside differs from the one before.
        $detected = [];
        $prev = null;
        foreach ($logs as $l) {
            if ($l['inside'] === null) {
                continue;
            }
            if ($prev !== null && $l['inside'] !== $prev) {
                $detected[] = ['kind' => $l['inside'] ? FieldTestMark::ENTERED : FieldTestMark::LEFT, 't' => $l['t'], 'used' => false];
            }
            $prev = $l['inside'];
        }

        $rows = [];
        foreach ($marks as $m) {
            if (! in_array($m['kind'], [FieldTestMark::ENTERED, FieldTestMark::LEFT], true)) {
                continue;
            }
            $hit = null;
            foreach ($detected as $i => $d) {
                if (! $d['used'] && $d['kind'] === $m['kind']
                    && $d['t'] >= $m['t'] - self::CROSSING_BEFORE && $d['t'] <= $m['t'] + self::CROSSING_AFTER) {
                    $hit = $i;
                    break;
                }
            }
            if ($hit !== null) {
                $detected[$hit]['used'] = true;
                $status = 'ok';
            } else {
                $status = $now < $m['t'] + self::CROSSING_AFTER ? 'waiting' : 'missed';
            }
            $rows[] = [
                'kind'        => $m['kind'],
                'tapped_at'   => date(DATE_ATOM, $m['t']),
                'detected_at' => $hit !== null ? date(DATE_ATOM, $detected[$hit]['t']) : null,
                'delay_s'     => $hit !== null ? $detected[$hit]['t'] - $m['t'] : null,
                'status'      => $status,
            ];
        }

        // Crossings detected during the zone walks that nobody made (GPS drift over the edge).
        $false = [];
        foreach ($detected as $d) {
            if (! $d['used'] && self::within($d['t'], $zone)) {
                $false[] = ['kind' => $d['kind'], 'detected_at' => date(DATE_ATOM, $d['t'])];
            }
        }

        return self::tally($rows, $false, (int) $targets['geofence_target_pct']) + ['crossings' => $rows, 'false' => $false];
    }

    /**
     * Checked against what the tracker really did, not against the hotspot taps: every time no
     * position reached the server for longer than the watchdog's window, "Signal Lost" should
     * follow, and "Signal Restored" when positions arrive again. Any other such alert is false.
     * A tester tapping late, or turning off the wrong phone, cannot change the result.
     */
    private static function alerts(FieldTest $test, array $logs, array $off, array $range, int $end, int $now, array $targets): array
    {
        $silent = TrackerWatchdog::onlineWindow();
        $lostWait = $silent + self::LOST_EXTRA;
        $until = min($end, $now);

        // When positions reached the server, in order (positions kept while offline arrive later).
        $received = array_values(array_filter(array_column($logs, 'r'), fn($r) => $r <= $until));
        sort($received);

        // Silences: no position received for longer than the window. The last one may still be going on.
        $outages = [];
        for ($i = 1; $i < count($received); $i++) {
            if ($received[$i] - $received[$i - 1] > $silent) {
                $outages[] = [$received[$i - 1], $received[$i]];
            }
        }
        if ($received && $until - end($received) > $silent) {
            $outages[] = [end($received), null];
        }

        $events = ['signal_lost' => [], 'signal_restored' => []];
        Notification::where('equipment_id', $test->equipment_id)
            ->whereIn('type', array_keys($events))
            ->whereBetween('created_at', [$test->started_at, ($test->ended_at ?? now())->copy()->addSeconds($lostWait)])
            ->orderBy('created_at')
            ->get(['type', 'created_at'])
            ->each(function ($n) use (&$events) {
                $t = $n->created_at->getTimestamp();
                $list = &$events[$n->type];
                $lastIdx = count($list) - 1;
                if ($lastIdx < 0 || $t - $list[$lastIdx]['t'] > self::SAME_ALERT) {
                    $list[] = ['t' => $t, 'used' => false];
                }
            });

        $take = function (string $type, int $from, int $to) use (&$events): ?int {
            foreach ($events[$type] as $i => $e) {
                if (! $e['used'] && $e['t'] >= $from && $e['t'] <= $to) {
                    $events[$type][$i]['used'] = true;
                    return $e['t'];
                }
            }
            return null;
        };

        $during = function (int $a, int $b) use ($off, $range): ?string {
            foreach (['hotspot_off' => $off, 'range' => $range] as $name => $windows) {
                foreach ($windows as $w) {
                    if (min($b, $w[1]) >= max($a, $w[0])) {
                        return $name;
                    }
                }
            }
            return null;
        };

        $rows = [];
        foreach ($outages as [$quiet, $back]) {
            // The watchdog looks once a minute, so "Signal Lost" is due a little after the window ends.
            $to = $quiet + $lostWait;
            if ($back !== null) {
                $to = min($to, $back + 30);
            }
            $lost = $take('signal_lost', $quiet + $silent - 5, $to);

            if ($lost === null && $back !== null && $back - $quiet < $silent + 60) {
                continue; // back before the watchdog's next look: too short to expect an alert
            }

            $cause = $during($quiet, $back ?? $until);
            $rows[] = ['kind' => 'signal_lost', 'at' => date(DATE_ATOM, $quiet),
                'quiet_s' => ($back ?? $until) - $quiet, 'during' => $cause,
                'alert_at' => $lost !== null ? date(DATE_ATOM, $lost) : null,
                'delay_s' => $lost !== null ? $lost - $quiet : null,
                'status' => $lost !== null ? 'ok' : ($now < $to ? 'waiting' : 'missed')];

            // "Signal Restored" only follows a "Signal Lost", and is sent with the first new position.
            if ($back !== null && $lost !== null) {
                $restored = $take('signal_restored', $back - 10, $back + 60);
                $rows[] = ['kind' => 'signal_restored', 'at' => date(DATE_ATOM, $back),
                    'quiet_s' => $back - $quiet, 'during' => $cause,
                    'alert_at' => $restored !== null ? date(DATE_ATOM, $restored) : null,
                    'delay_s' => $restored !== null ? $restored - $back : null,
                    'status' => $restored !== null ? 'ok' : ($now < $back + 60 ? 'waiting' : 'missed')];
            }
        }

        // Alerts with no silence behind them, counted once the tracker had been heard from.
        $false = [];
        if ($received) {
            foreach ($events as $type => $list) {
                foreach ($list as $e) {
                    if (! $e['used'] && $e['t'] >= $received[0] + $silent - 5 && $e['t'] <= $end) {
                        $false[] = ['kind' => $type, 'alert_at' => date(DATE_ATOM, $e['t'])];
                    }
                }
            }
            usort($false, fn($x, $y) => strcmp($x['alert_at'], $y['alert_at']));
        }

        return self::tally($rows, $false, (int) $targets['alert_target_pct'])
            + ['trials' => $rows, 'false' => $false, 'silent_seconds' => $silent];
    }

    /** Correct ÷ (correct + missed + false); rows still waiting are left out. */
    private static function tally(array $rows, array $false, int $target): array
    {
        $ok = count(array_filter($rows, fn($r) => $r['status'] === 'ok'));
        $missed = count(array_filter($rows, fn($r) => $r['status'] === 'missed'));
        $total = $ok + $missed + count($false);
        $pct = $total > 0 ? round(100 * $ok / $total, 1) : null;

        return [
            'samples'    => $total,
            'correct'    => $ok,
            'missed'     => $missed,
            'false_count'=> count($false),
            'pct'        => $pct,
            'target_pct' => $target,
            'pass'       => $pct === null ? null : $pct >= $target,
        ];
    }

    /** [[start, end, open], ...] from open/close taps; an open period runs to $end. */
    private static function windows(array $marks, string $open, string $close, int $end): array
    {
        $out = [];
        $from = null;
        foreach ($marks as $m) {
            if ($m['kind'] === $open && $from === null) {
                $from = $m['t'];
            } elseif ($m['kind'] === $close && $from !== null) {
                $out[] = [$from, $m['t'], false];
                $from = null;
            }
        }
        if ($from !== null) {
            $out[] = [$from, max($from, $end), true];
        }
        return $out;
    }

    private static function isOpen(array $windows): bool
    {
        return $windows && end($windows)[2];
    }

    private static function within(int $t, array $windows): bool
    {
        foreach ($windows as $w) {
            if ($t >= $w[0] && $t <= $w[1]) {
                return true;
            }
        }
        return false;
    }

    /** [a, b] minus the given periods, as a list of [from, to]. */
    private static function subtract(array $span, array $cuts): array
    {
        usort($cuts, fn($x, $y) => $x[0] <=> $y[0]);
        $out = [];
        $from = $span[0];
        foreach ($cuts as [$a, $b]) {
            if ($b < $from || $a > $span[1]) {
                continue;
            }
            if ($a > $from) {
                $out[] = [$from, $a];
            }
            $from = max($from, $b);
        }
        if ($from < $span[1]) {
            $out[] = [$from, $span[1]];
        }
        return $out;
    }

    private static function share(array $values, callable $ok): ?float
    {
        return $values ? round(100 * count(array_filter($values, $ok)) / count($values), 1) : null;
    }

    /** Nearest-rank percentile of a sorted list. */
    private static function percentile(array $sorted, float $q): int|float|null
    {
        if (! $sorted) {
            return null;
        }
        return $sorted[max(0, (int) ceil($q * count($sorted)) - 1)];
    }

    private static function round1(int|float|null $v): ?float
    {
        return $v === null ? null : round($v, 1);
    }

    private static function meters(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $p1 = deg2rad($lat1);
        $p2 = deg2rad($lat2);
        $a = sin(($p2 - $p1) / 2) ** 2 + cos($p1) * cos($p2) * sin(deg2rad($lng2 - $lng1) / 2) ** 2;
        return 6371000.0 * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }
}
