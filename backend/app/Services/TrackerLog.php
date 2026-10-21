<?php

namespace App\Services;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Plain-text trail of what each GPS tracker reported and what the API answered, one line per
 * request, in storage/logs/trackers.log:
 *
 *   2026-10-19 21:10:05  ESP32-001  [gps] no fix yet (satellites in view=15, used=3)
 *   2026-10-19 21:31:40  ESP32-001  [post] HTTP 200  8.454210, 124.631900  sats=9
 *
 * The lines read like the tracker's own USB output, so iot/tools/setup-tracker.ps1 can show a
 * tracker running on a hotspot live, without a USB cable. Nothing here touches the database:
 * it keeps working while MySQL is down, which is one of the things it has to reveal.
 */
class TrackerLog
{
    /** Past this size the file moves to trackers.log.1 (the previous one is dropped). */
    private const MAX_BYTES = 1_048_576;

    public static function path(): string
    {
        return storage_path('logs/trackers.log');
    }

    /** One line for a request to gps/status or gps/ingest and the answer it got. */
    public static function request(Request $request, Response $response): void
    {
        $code = $response->getStatusCode();
        $answer = json_decode((string) $response->getContent(), true);
        $message = is_array($answer) ? self::text($answer['message'] ?? '') : '';

        if ($request->is('api/v1/gps/status')) {
            // A signed status report carries the tracker's own status line.
            $text = $code < 300 ? self::text($request->input('line')) : "[status] HTTP {$code}  {$message}";
        } else {
            $lat = self::coordinate($request->input('latitude'));
            $lon = self::coordinate($request->input('longitude'));
            $sats = self::text($request->input('satellites'));
            $text = implode('  ', array_filter([
                "[post] HTTP {$code}",
                $lat !== '' && $lon !== '' ? "{$lat}, {$lon}" : '',
                $sats !== '' ? "sats={$sats}" : '',
                $message,
            ]));
        }

        self::write(self::text($request->input('device_id')), $text);
    }

    public static function write(string $deviceId, string $text): void
    {
        $device = substr(preg_replace('/[^A-Za-z0-9_.-]/', '', $deviceId) ?: 'unknown', 0, 64);
        $path = self::path();
        if (@filesize($path) > self::MAX_BYTES) {
            @rename($path, $path . '.1');
        }
        $line = sprintf("%s  %s  %s\n", now()->format('Y-m-d H:i:s'), $device, mb_substr(trim($text), 0, 300));
        @file_put_contents($path, $line, FILE_APPEND | LOCK_EX);
    }

    /** Six decimals (about 0.1 m), like the tracker's own output. */
    private static function coordinate(mixed $value): string
    {
        return is_numeric($value) ? number_format((float) $value, 6, '.', '') : self::text($value);
    }

    /** Any request value as one line of text: a tracker cannot break the format with arrays or line breaks. */
    private static function text(mixed $value): string
    {
        if (! is_scalar($value)) {
            return '';
        }

        return trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) $value) ?? '');
    }
}
