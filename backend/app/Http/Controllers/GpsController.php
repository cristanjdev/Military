<?php

namespace App\Http\Controllers;

use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use App\Models\GpsLog;
use App\Models\Notification;
use App\Models\Transaction;
use App\Services\AuditLogger;
use App\Services\TrackerFirmware;
use App\Services\TrackerLog;
use App\Services\TrackerWatchdog;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Http\Response;

class GpsController extends Controller
{
    /**
     * IoT INGEST — called by ESP32. Authenticated by HMAC-SHA256 over the raw body using IOT_HMAC_SECRET.
     * No Sanctum token required; rate limit middleware still applies.
     */
    public function ingest(Request $request): JsonResponse
    {
        $secret = (string) config('armory.iot.hmac_secret');
        if ($secret === '') {
            return response()->json(['message' => 'IoT secret not configured.'], 503);
        }

        $signatureHeader = $request->header('X-Armory-Signature', '');
        $body = $request->getContent();
        $expected = hash_hmac('sha256', $body, $secret);

        if (! hash_equals($expected, $signatureHeader)) {
            AuditLogger::log(
                action: 'gps_signature_invalid',
                description: 'Rejected GPS payload — bad HMAC signature',
                request: $request,
                metadata: ['device_id' => $request->input('device_id')],
            );
            return response()->json(['message' => 'Invalid signature.'], 401);
        }

        $data = $request->validate([
            'equipment_id'    => ['required', 'integer', 'exists:firearm_equipment,equipment_id'],
            'transaction_id'  => ['nullable', 'integer', 'exists:transactions,transaction_id'],
            'device_id'       => ['required', 'string', 'max:64'],
            'captured_at'     => ['required', 'date'],
            'latitude'        => ['required', 'numeric', 'between:-90,90'],
            'longitude'       => ['required', 'numeric', 'between:-180,180'],
            'accuracy_meters' => ['nullable', 'numeric', 'min:0'],
            'speed_mps'       => ['nullable', 'numeric', 'min:0'],
            'heading_deg'     => ['nullable', 'numeric', 'between:0,360'],
            'altitude_meters' => ['nullable', 'numeric'],
            'satellites'      => ['nullable', 'integer', 'min:0', 'max:64'],
            'battery_pct'     => ['nullable', 'integer', 'between:0,100'],
        ]);

        /*
         * Normalise to the application timezone before comparing or storing.
         * Devices report UTC ("...Z"), but `captured_at` is read back through a
         * datetime cast that applies the app timezone. Without this conversion the
         * stored wall-clock time is reinterpreted in another zone, which shifts the
         * instant and silently defeats the replay/ordering check below.
         */
        $capturedAt = CarbonImmutable::parse($data['captured_at'])
            ->setTimezone(config('app.timezone'));
        $now = CarbonImmutable::now();
        $maxAgeSeconds = max(1, (int) config('armory.gps.max_age_seconds', 300));
        $futureToleranceSeconds = max(0, (int) config('armory.gps.future_tolerance_seconds', 30));

        if ($capturedAt->lt($now->subSeconds($maxAgeSeconds))) {
            return response()->json(['message' => 'GPS update is too old.'], 422);
        }
        if ($capturedAt->gt($now->addSeconds($futureToleranceSeconds))) {
            return response()->json(['message' => 'GPS update timestamp is in the future.'], 422);
        }

        $insideAny = false;
        $insideArmory = false;
        $zoneNames = [];
        foreach (GpsLocation::all() as $location) {
            if ($location->contains((float) $data['latitude'], (float) $data['longitude'])) {
                $insideAny = true;
                $zoneNames[] = $location->location_name;
                if ($location->is_armory) {
                    $insideArmory = true;
                }
            }
        }

        try {
            return DB::transaction(function () use (
                $data,
                $capturedAt,
                $insideAny,
                $insideArmory,
                $zoneNames,
                $signatureHeader,
                $request
            ) {
                $firearm = FirearmEquipment::lockForUpdate()->findOrFail($data['equipment_id']);
                $activeTransaction = $firearm->transactions()
                    ->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
                    ->latest('checkout_at')
                    ->lockForUpdate()
                    ->first();

                if (! $activeTransaction) {
                    return response()->json(['message' => 'No active firearm transaction accepts GPS updates.'], 409);
                }
                if (! $activeTransaction->gps_tracking_enabled) {
                    return response()->json(['message' => 'GPS tracking is disabled for this transaction.'], 409);
                }
                if (! in_array($firearm->availability_status, [
                    FirearmEquipment::STATUS_CHECKED_OUT,
                    FirearmEquipment::STATUS_OVERDUE,
                ], true)) {
                    return response()->json(['message' => 'Firearm status does not permit GPS updates.'], 409);
                }
                if (isset($data['transaction_id'])
                    && (int) $data['transaction_id'] !== (int) $activeTransaction->transaction_id) {
                    return response()->json(['message' => 'Transaction does not match the active firearm assignment.'], 409);
                }

                $latestDeviceLog = GpsLog::where('device_id', $data['device_id'])
                    ->latest('captured_at')
                    ->lockForUpdate()
                    ->first();
                if ($latestDeviceLog && $capturedAt->lte($latestDeviceLog->captured_at)) {
                    return response()->json(['message' => 'Duplicate or out-of-order GPS update.'], 409);
                }

                $previousEquipmentLog = GpsLog::where('equipment_id', $firearm->equipment_id)
                    ->latest('captured_at')
                    ->lockForUpdate()
                    ->first();

                $log = GpsLog::create([
                    'transaction_id'     => $activeTransaction->transaction_id,
                    'equipment_id'       => $firearm->equipment_id,
                    'captured_at'        => $capturedAt,
                    'received_at'        => now(),
                    'latitude'           => $data['latitude'],
                    'longitude'          => $data['longitude'],
                    'accuracy_meters'    => $data['accuracy_meters'] ?? null,
                    'speed_mps'          => $data['speed_mps'] ?? null,
                    'heading_deg'        => $data['heading_deg'] ?? null,
                    'altitude_meters'    => $data['altitude_meters'] ?? null,
                    'satellites'         => $data['satellites'] ?? null,
                    'battery_pct'        => $data['battery_pct'] ?? null,
                    'is_inside_geofence' => $insideAny,
                    'device_id'          => $data['device_id'],
                    'signature'          => substr($signatureHeader, 0, 128),
                ]);

                TrackerWatchdog::seen($data['device_id'], $firearm, $activeTransaction);

                $enteredUnsafeState = ! $insideAny
                    && (! $previousEquipmentLog || $previousEquipmentLog->is_inside_geofence === true);
                $cameBackInside = $insideAny
                    && $previousEquipmentLog && $previousEquipmentLog->is_inside_geofence === false;

                $holder = optional($activeTransaction->user)->fullName() ?? 'unknown personnel';
                $payload = [
                    'lat'            => $data['latitude'],
                    'lon'            => $data['longitude'],
                    'transaction_id' => $activeTransaction->transaction_id,
                    'zones'          => $zoneNames,
                ];

                // Everyone who oversees the armory is alerted, not only the issuing custodian.
                if ($enteredUnsafeState) {
                    $nearest = GpsLocation::all()
                        ->map(function ($z) use ($data) {
                            $d = $z->distanceTo((float) $data['latitude'], (float) $data['longitude']);
                            // Distance past the zone's edge, not to its centre.
                            return ['name' => $z->location_name, 'm' => $d === null ? null : max(0, $d - (float) $z->radius_meters)];
                        })
                        ->filter(fn($z) => $z['m'] !== null)
                        ->sortBy('m')
                        ->first();
                    $where = $nearest ? sprintf(' (about %d m outside %s)', round($nearest['m']), $nearest['name']) : '';

                    Notification::notifyRoles([
                        'equipment_id' => $firearm->equipment_id,
                        'type'         => 'geofence_violation',
                        'severity'     => Notification::SEVERITY_CRITICAL,
                        'title'        => 'Geofence Violation',
                        'message'      => "{$firearm->serial_number} ({$holder}) left all authorized zones{$where}.",
                        'payload'      => $payload,
                    ], alsoUserIds: [$activeTransaction->authorized_by], emailUserIds: [$activeTransaction->authorized_by]);
                } elseif ($cameBackInside) {
                    Notification::notifyRoles([
                        'equipment_id' => $firearm->equipment_id,
                        'type'         => 'geofence_return',
                        'severity'     => Notification::SEVERITY_INFO,
                        'title'        => 'Back Inside Zone',
                        'message'      => "{$firearm->serial_number} ({$holder}) is back inside " . implode(', ', $zoneNames) . '.',
                        'payload'      => $payload,
                    ], alsoUserIds: [$activeTransaction->authorized_by]);
                }

                return response()->json([
                    'ok'              => true,
                    'gps_log_id'      => $log->gps_log_id,
                    'inside_geofence' => $insideAny,
                    'zones'           => $zoneNames,
                    'inside_armory'   => $insideArmory,
                ]);
            });
        } catch (QueryException $exception) {
            $sqlState = (string) ($exception->errorInfo[0] ?? $exception->getCode());
            if (in_array($sqlState, ['23000', '23505'], true)) {
                return response()->json(['message' => 'Duplicate or conflicting GPS update.'], 409);
            }

            throw $exception;
        }
    }

    /**
     * IoT STATUS — called by the ESP32 while it has no position to send (no fix yet, GPS wiring
     * fault). The body carries the status line it prints on USB, e.g. "[gps] no fix yet
     * (satellites in view=15, used=3)". Signed like ingest. Nothing is stored in the database:
     * RecordTrackerTraffic writes the line to storage/logs/trackers.log, where the setup tool
     * shows it, so a tracker on a hotspot can be checked without a USB cable.
     */
    public function status(Request $request): JsonResponse
    {
        $secret = (string) config('armory.iot.hmac_secret');
        if ($secret === '') {
            return response()->json(['message' => 'IoT secret not configured.'], 503);
        }
        $expected = hash_hmac('sha256', $request->getContent(), $secret);
        if (! hash_equals($expected, (string) $request->header('X-Armory-Signature', ''))) {
            return response()->json(['message' => 'Invalid signature.'], 401);
        }

        $request->validate([
            'device_id'          => ['required', 'string', 'max:64'],
            'line'               => ['required', 'string', 'max:300'],
            'satellites_in_view' => ['nullable', 'integer', 'min:0', 'max:255'],
            'satellites_used'    => ['nullable', 'integer', 'min:0', 'max:64'],
            'rssi'               => ['nullable', 'integer', 'between:-127,0'],
        ]);

        return response()->json(['ok' => true]);
    }

    /**
     * IoT FIRMWARE — the update waiting for this tracker (TrackerFirmware), downloaded after its
     * report was answered with an "update" offer. The request is signed: X-Armory-Signature is the
     * HMAC of "firmware:<device>:<build>", since the binary holds the Wi-Fi password and the secret.
     */
    public function firmware(Request $request, string $device): JsonResponse|Response
    {
        $update = TrackerFirmware::pending($device);
        if (! $update) {
            return response()->json(['message' => 'No firmware update is waiting for this tracker.'], 404);
        }
        $expected = TrackerFirmware::expectedSignature($device, (string) $update['build']);
        if (! hash_equals($expected, (string) $request->header('X-Armory-Signature', ''))) {
            return response()->json(['message' => 'Invalid signature.'], 401);
        }
        TrackerLog::write($device, sprintf('[ota] the tracker is downloading the new firmware (%d KB)', $update['size'] / 1024));

        // A plain response (not a file download): the rate limiter adds headers through Laravel's response API.
        // The tracker checks the length before installing; php artisan serve does not send it by itself.
        $binary = (string) file_get_contents(TrackerFirmware::binPath($device));

        return response($binary, 200, [
            'Content-Type'   => 'application/octet-stream',
            'Content-Length' => (string) strlen($binary),
        ]);
    }

    /**
     * Latest GPS position for every active firearm. Used by the live map.
     */
    public function liveMap(Request $request): JsonResponse
    {
        $intervalSec = (int) config('armory.gps.interval_seconds');
        $onlineWindow = max(60, $intervalSec * 4);
        $freshAfter = now()->subSeconds($onlineWindow);

        $zones = GpsLocation::all();

        $items = FirearmEquipment::with(['currentLocation', 'category'])
            ->whereIn('availability_status', [
                FirearmEquipment::STATUS_CHECKED_OUT,
                FirearmEquipment::STATUS_OVERDUE,
            ])
            ->get()
            ->map(function (FirearmEquipment $f) use ($freshAfter, $zones) {
                $latest = $f->latestGps();
                $tx     = $f->activeTransaction();
                $location = $f->currentLocation;

                $lastReceived = $latest?->received_at ?? $latest?->captured_at;
                $hasLiveIot = $latest
                    && $latest->device_id
                    && $lastReceived
                    && $lastReceived->gte($freshAfter);

                if ($latest) {
                    $lat = $latest->latitude;
                    $lon = $latest->longitude;
                    $telemetrySource = $hasLiveIot ? 'iot' : 'stale';
                    $locationNote = $hasLiveIot
                        ? 'Live IoT telemetry from ESP32 tracker.'
                        : 'Last known GPS point; tracker is not currently reporting.';
                } elseif ($location) {
                    $lat = $location->center_latitude;
                    $lon = $location->center_longitude;
                    $telemetrySource = 'placeholder';
                    $locationNote = "Placeholder from assigned location: {$location->location_name}.";
                } else {
                    $lat = null;
                    $lon = null;
                    $telemetrySource = 'missing';
                    $locationNote = 'No GPS fix or assigned location available.';
                }

                return [
                    'equipment_id'   => $f->equipment_id,
                    'serial_number'  => $f->serial_number,
                    'model'          => $f->model,
                    'status'         => $f->availability_label,
                    'condition'      => $f->condition_label,
                    'assigned_to'    => $tx ? optional($tx->user)->fullName() : null,
                    'transaction_id' => optional($tx)->transaction_id,
                    'expected_return'=> optional($tx)->expected_return_at,
                    'lat'            => $lat,
                    'lon'            => $lon,
                    'captured_at'    => $latest?->captured_at,
                    'received_at'    => $latest?->received_at,
                    'inside_geofence'=> $latest?->is_inside_geofence,
                    // Zones the shown position falls in; empty means outside all of them.
                    'zones'          => $lat === null ? [] : $zones
                        ->filter(fn($z) => $z->contains((float) $lat, (float) $lon))
                        ->pluck('location_name')
                        ->values(),
                    'battery_pct'    => $latest?->battery_pct,
                    'device_id'      => $latest?->device_id,
                    'iot_online'     => $hasLiveIot,
                    'telemetry_source' => $telemetrySource,
                    'is_placeholder' => $telemetrySource === 'placeholder',
                    'is_stale'       => $telemetrySource === 'stale',
                    'location_note'  => $locationNote,
                ];
            })->filter(fn($i) => $i['lat'] !== null && $i['lon'] !== null)->values();

        return response()->json([
            'items'         => $items,
            'geofences'     => $zones,
            'updated_at'    => now(),
            'poll_interval' => $intervalSec,
            'online_window_sec' => $onlineWindow,
        ]);
    }

    /**
     * History for a single firearm or transaction. Limited to 1 000 latest points.
     */
    public function history(Request $request, int $equipmentId): JsonResponse
    {
        $request->validate([
            'transaction_id' => ['nullable', 'integer'],
            'from'           => ['nullable', 'date'],
            'to'             => ['nullable', 'date'],
            'limit'          => ['nullable', 'integer', 'between:1,5000'],
        ]);

        $logs = GpsLog::where('equipment_id', $equipmentId)
            ->when($request->filled('transaction_id'), fn($q) => $q->where('transaction_id', $request->integer('transaction_id')))
            ->when($request->filled('from'), fn($q) => $q->where('captured_at', '>=', $request->date('from')))
            ->when($request->filled('to'), fn($q) => $q->where('captured_at', '<=', $request->date('to')))
            ->latest('captured_at')
            ->limit($request->integer('limit', 1000))
            ->get();

        return response()->json($logs);
    }

    /**
     * Real-time IoT status stream (Server-Sent Events).
     *
     * Pushes an event the moment IoT state changes — new heartbeat, device
     * coming online, device aging out, or transaction count changing — so
     * the UI updates instantly without polling.
     *
     * Production deployment requires a non-blocking web server (php-fpm + nginx,
     * Apache prefork+, or Laravel Octane). `php artisan serve` is single-threaded
     * and will block other requests while a stream is open.
     */
    public function iotStream(Request $request): \Symfony\Component\HttpFoundation\StreamedResponse
    {
        $intervalSec  = (int) config('armory.gps.interval_seconds', 30);
        $onlineWindow = max(60, $intervalSec * 4);

        // Loop tuning
        $checkIntervalUs = 500_000;   // 0.5 s — server-side state check cadence
        $heartbeatEvery  = 15;        // emit a comment heartbeat every 15 s to keep the connection alive
        $maxRuntime      = 25 * 60;   // hard ceiling: clients reconnect every 25 min

        $userId = optional($request->user())->user_id;

        $response = new \Symfony\Component\HttpFoundation\StreamedResponse(function () use (
            $intervalSec, $onlineWindow, $checkIntervalUs, $heartbeatEvery, $maxRuntime, $userId
        ) {
            // PHP runtime tuning for long-lived streams.
            @set_time_limit(0);
            @ignore_user_abort(false);
            while (ob_get_level() > 0) { @ob_end_flush(); }

            $started     = time();
            $lastSig     = null;
            $lastBeat    = 0;

            // First payload immediately so the client paints the pill without delay.
            $payload     = $this->computeIotStatus($intervalSec, $onlineWindow);
            $lastSig     = $this->signaturizeStatus($payload);
            $this->sseSend('status', $payload);
            $lastBeat    = time();

            while (! connection_aborted()) {
                if (time() - $started > $maxRuntime) break;

                TrackerWatchdog::maybeSweep();

                $payload = $this->computeIotStatus($intervalSec, $onlineWindow);
                $sig     = $this->signaturizeStatus($payload);

                if ($sig !== $lastSig) {
                    $lastSig = $sig;
                    $this->sseSend('status', $payload);
                    $lastBeat = time();
                } elseif (time() - $lastBeat >= $heartbeatEvery) {
                    // Comment-only line keeps the connection warm through proxies.
                    echo ": keepalive\n\n";
                    @flush();
                    $lastBeat = time();
                }

                usleep($checkIntervalUs);
            }
        });

        $response->headers->set('Content-Type', 'text/event-stream');
        $response->headers->set('Cache-Control', 'no-cache, no-transform');
        $response->headers->set('X-Accel-Buffering', 'no');     // disable nginx response buffering
        $response->headers->set('Connection', 'keep-alive');
        return $response;
    }

    /**
     * Compute the same status payload returned by /gps/iot-status.
     * Extracted so the SSE loop and the polling endpoint share one source of truth.
     */
    private function computeIotStatus(int $intervalSec, int $onlineWindow): array
    {
        $threshold = now()->subSeconds($onlineWindow);

        $recent = GpsLog::whereNotNull('device_id')
            ->where('received_at', '>=', $threshold)
            ->selectRaw('COUNT(DISTINCT device_id) AS online_count, MAX(received_at) AS last_received, MAX(captured_at) AS last_captured')
            ->first();

        $onlineDevices = (int) ($recent->online_count ?? 0);
        $lastReceived  = $recent?->last_received ? \Illuminate\Support\Carbon::parse($recent->last_received) : null;
        $lastCaptured  = $recent?->last_captured ? \Illuminate\Support\Carbon::parse($recent->last_captured) : null;

        $totalDevices    = (int) GpsLog::whereNotNull('device_id')->distinct('device_id')->count('device_id');
        $expectedDevices = (int) FirearmEquipment::whereIn('availability_status', [
            FirearmEquipment::STATUS_CHECKED_OUT,
            FirearmEquipment::STATUS_OVERDUE,
        ])->count();

        if ($onlineDevices > 0) {
            $state = $onlineDevices >= max(1, $expectedDevices) ? 'online' : 'partial';
        } elseif ($totalDevices === 0) {
            $state = 'unprovisioned';
        } else {
            $state = 'offline';
        }

        return [
            'state'              => $state,
            'online_devices'     => $onlineDevices,
            'expected_devices'   => $expectedDevices,
            'total_devices'      => $totalDevices,
            'last_heartbeat_at'  => optional($lastReceived)->toIso8601String(),
            'last_capture_at'    => optional($lastCaptured)->toIso8601String(),
            'online_window_sec'  => $onlineWindow,
            'poll_interval_sec'  => $intervalSec,
            'server_time'        => now()->toIso8601String(),
        ];
    }

    /**
     * Build a stable signature of the parts that should trigger a re-render.
     * Excludes server_time so we don't emit on every loop iteration.
     */
    private function signaturizeStatus(array $payload): string
    {
        return implode('|', [
            $payload['state'],
            $payload['online_devices'],
            $payload['expected_devices'],
            $payload['total_devices'],
            $payload['last_heartbeat_at'] ?? '-',
        ]);
    }

    /** Send a single named SSE event with a JSON payload. */
    private function sseSend(string $event, array $payload): void
    {
        echo "event: {$event}\n";
        echo 'data: ' . json_encode($payload, JSON_UNESCAPED_SLASHES) . "\n\n";
        @flush();
    }

    /**
     * IoT connectivity status — used by the topbar's real-time indicator.
     * Reports the most recent device heartbeat regardless of issuance status,
     * so the UI can distinguish between "no devices online" and "all idle".
     *
     * Optimised for high-frequency polling (3 s): one aggregate scan over the
     * recent window and one fleet-wide count, so the topbar can run live without
     * loading the database.
     */
    public function iotStatus(Request $request): JsonResponse
    {
        $intervalSec  = (int) config('armory.gps.interval_seconds', 30);
        $onlineWindow = max(60, $intervalSec * 4);

        // The topbar polls this every few seconds, which makes it a reliable place to notice
        // a tracker that has gone quiet even when the Laravel scheduler is not running.
        TrackerWatchdog::maybeSweep();

        return response()->json($this->computeIotStatus($intervalSec, $onlineWindow));
    }
}
