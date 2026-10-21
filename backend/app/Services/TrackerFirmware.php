<?php

namespace App\Services;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Firmware updates over Wi-Fi. iot/tools/setup-tracker.ps1 builds the firmware for a tracker that is
 * not on USB and leaves it here (storage/app/firmware/<device>.bin plus <device>.json with its build
 * id, MD5 and size). The tracker's next report (gps/status or gps/ingest) is answered with an
 * "update" offer; the tracker downloads it from gps/firmware/<device> with a signed request,
 * installs it and restarts. Once it reports the new build, the files are removed: the binary holds
 * the Wi-Fi password and the signing secret, so it is not kept longer than needed.
 */
class TrackerFirmware
{
    public static function binPath(string $device): string
    {
        return storage_path('app/firmware/' . self::safe($device) . '.bin');
    }

    /** The waiting update for this device: ['build', 'md5', 'size', ...], or null. */
    public static function pending(string $device): ?array
    {
        $meta = storage_path('app/firmware/' . self::safe($device) . '.json');
        if (! is_file($meta) || ! is_file(self::binPath($device))) {
            return null;
        }
        $data = json_decode((string) file_get_contents($meta), true);

        return is_array($data) && isset($data['build'], $data['md5'], $data['size']) ? $data : null;
    }

    /** Signature the tracker sends to download: HMAC of "firmware:<device>:<build>". */
    public static function expectedSignature(string $device, string $build): string
    {
        return hash_hmac('sha256', "firmware:{$device}:{$build}", (string) config('armory.iot.hmac_secret'));
    }

    /**
     * Called for every tracker report and the API's answer: offers a waiting update in the answer,
     * notes when the tracker runs it, and says when the tracker's firmware cannot take updates.
     */
    public static function handle(Request $request, Response $response): void
    {
        $code = $response->getStatusCode();
        $device = self::safe((string) (is_scalar($request->input('device_id')) ? $request->input('device_id') : ''));
        if ($device === '' || $code === 401 || $code >= 500) {
            return;  // unsigned, or the server could not judge the request
        }
        $update = self::pending($device);
        if (! $update) {
            return;
        }
        $running = $request->input('firmware');

        if (! is_string($running)) {
            // Firmware from before updates over Wi-Fi: it never asks. Said once per waiting update.
            if (empty($update['told_old'])) {
                self::saveMeta($device, $update + ['told_old' => true]);
                TrackerLog::write($device, "[ota] this tracker's firmware cannot update over Wi-Fi: plug it in by USB once and press Save");
            }
            return;
        }
        if ($running === $update['build']) {
            @unlink(self::binPath($device));
            @unlink(storage_path('app/firmware/' . $device . '.json'));
            TrackerLog::write($device, "[ota] the tracker runs the new firmware (build {$update['build']})");
            return;
        }
        if ($response instanceof JsonResponse) {
            $data = $response->getData(true);
            $data['update'] = ['build' => $update['build'], 'md5' => $update['md5'], 'size' => (int) $update['size']];
            $response->setData($data);
            if (empty($update['offered'])) {
                self::saveMeta($device, $update + ['offered' => true]);
                TrackerLog::write($device, "[ota] new firmware offered to the tracker (build {$update['build']})");
            }
        }
    }

    private static function saveMeta(string $device, array $data): void
    {
        @file_put_contents(storage_path('app/firmware/' . $device . '.json'), json_encode($data, JSON_UNESCAPED_SLASHES));
    }

    private static function safe(string $device): string
    {
        return substr(preg_replace('/[^A-Za-z0-9_.-]/', '', $device) ?? '', 0, 64);
    }
}
