<?php

namespace App\Http\Middleware;

use App\Services\TrackerFirmware;
use App\Services\TrackerLog;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Writes every tracker request and the API's answer to storage/logs/trackers.log (TrackerLog).
 * It sits outside the rate limiter, so answers given before the controller runs (rate limit,
 * database down) and answers rendered from an exception (validation, server error) are noted too.
 * A firmware update waiting for the tracker (TrackerFirmware) is offered in the answer.
 */
class RecordTrackerTraffic
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        try {
            TrackerLog::request($request, $response);
            TrackerFirmware::handle($request, $response);  // offers a waiting update in the answer
        } catch (\Throwable) {
            // A log line must never cost the tracker its answer.
        }

        return $response;
    }
}
