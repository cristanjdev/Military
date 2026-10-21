<?php

use App\Http\Controllers\AuditLogController;
use App\Http\Controllers\Auth\AuthController;
use App\Http\Controllers\BiometricStepUpController;
use App\Http\Controllers\DashboardController;
use App\Http\Controllers\FirearmController;
use App\Http\Controllers\GpsController;
use App\Http\Controllers\GpsLocationController;
use App\Http\Controllers\LogisticsRequestController;
use App\Http\Controllers\MaintenanceController;
use App\Http\Controllers\NotificationController;
use App\Http\Controllers\ReportController;
use App\Http\Controllers\SettingsController;
use App\Http\Controllers\TransactionController;
use App\Http\Controllers\UserController;
use App\Http\Middleware\RecordTrackerTraffic;
use Illuminate\Support\Facades\Route;

/*
|------------------------------------------------------------------------------
| ArmoryDB · REST API · /api/v1
|------------------------------------------------------------------------------
|  User endpoints are protected by the strict 5-req/s rate limit.
|  IoT ingestion uses a dedicated 60-req/s bucket.
*/

// IoT GPS ingest has its own higher bucket and is not nested under the user API limiter.
// RecordTrackerTraffic notes each request and answer in storage/logs/trackers.log (the setup
// tool shows it live); it comes first so it also sees the rate limiter's own answers.
Route::prefix('v1')->group(function () {
    Route::post('gps/ingest', [GpsController::class, 'ingest'])
        ->middleware([RecordTrackerTraffic::class, 'rate.strict:60']);
    Route::post('gps/status', [GpsController::class, 'status'])
        ->middleware([RecordTrackerTraffic::class, 'rate.strict:60']);
    // Firmware update over Wi-Fi, after a report was answered with an offer (TrackerFirmware).
    Route::get('gps/firmware/{device}', [GpsController::class, 'firmware'])
        ->where('device', '[A-Za-z0-9_.-]{1,64}')
        ->middleware('rate.strict:5');
});

Route::middleware('rate.strict')->prefix('v1')->group(function () {

    // ----- Public auth flow (challenge → totp → biometric → sanctum) -----
    Route::prefix('auth')->group(function () {
        Route::get('requirements',        [AuthController::class, 'requirements']);
        Route::post('login',             [AuthController::class, 'login']);
        Route::post('forgot-password',   [AuthController::class, 'forgotPassword']);
        Route::post('verify-reset-code', [AuthController::class, 'verifyResetCode']);
        Route::post('reset-password',    [AuthController::class, 'resetPassword']);
        Route::post('totp/setup',        [AuthController::class, 'totpSetup']);
        Route::post('totp/verify',       [AuthController::class, 'totpVerify']);
        Route::post('biometric/verify',  [AuthController::class, 'biometricVerify']);
    });

    // ----- Authenticated routes -----
    Route::middleware('auth:sanctum')->group(function () {

        Route::get('auth/me',      [AuthController::class, 'me']);
        Route::post('auth/logout', [AuthController::class, 'logout']);
        Route::post('auth/change-password', [AuthController::class, 'changePassword']);
        Route::post('auth/verify-password', [AuthController::class, 'verifyPassword']);
        Route::post('auth/reset-totp',      [AuthController::class, 'resetTotp']);
        Route::post('auth/reset-biometric', [AuthController::class, 'resetBiometric']);
        Route::post('auth/enable-totp',     [AuthController::class, 'enableTotp']);
        Route::post('auth/enable-biometric',[AuthController::class, 'enableBiometric']);

        // Global search
        Route::get('search', [DashboardController::class, 'search'])
            ->middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian,Personnel');

        // Dashboard / notifications — accessible to known authenticated roles
        Route::get('dashboard/summary', [DashboardController::class, 'summary'])
            ->middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian,Personnel');

        // Sensitive location data — operational staff only
        Route::middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian')->group(function () {
            Route::get('gps/live', [GpsController::class, 'liveMap']);
            Route::get('gps/history/{equipmentId}', [GpsController::class, 'history']);
            Route::get('locations', [GpsLocationController::class, 'index']);
        });

        Route::get('notifications',                  [NotificationController::class, 'index']);
        Route::get('notifications/unread',           [NotificationController::class, 'unread']);
        Route::patch('notifications/{id}/read',      [NotificationController::class, 'markRead']);
        Route::post('notifications/mark-all-read',   [NotificationController::class, 'markAllRead']);

        // Equipment categories
        Route::get('categories', [FirearmController::class, 'categories'])
            ->middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian,Personnel');

        // Firearm reads default-deny unknown roles; Personnel are ownership-scoped in the controller.
        Route::middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian,Personnel')->group(function () {
            Route::get('firearms',         [FirearmController::class, 'index']);
            Route::get('firearms/{id}',    [FirearmController::class, 'show']);
            Route::get('firearms/{id}/qr', [FirearmController::class, 'qrCode']);
            Route::post('firearms/lookup', [FirearmController::class, 'lookup']);
        });

        // Inventory and maintenance records. The Command Officer oversees the whole system.
        Route::middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian')->group(function () {
            Route::post('firearms',                  [FirearmController::class, 'store']);
            Route::patch('firearms/{id}',            [FirearmController::class, 'update']);
            Route::delete('firearms/{id}',           [FirearmController::class, 'destroy']);
            Route::post('maintenance',               [MaintenanceController::class, 'store']);
        });

        // Releasing and receiving firearms: the Armory Custodian's job (Administrator as system account).
        Route::middleware('role:Administrator,Armory Custodian')->group(function () {
            // Fingerprint re-scan required before issuing/returning (when biometrics are enabled)
            Route::post('auth/biometric/step-up/challenge', [BiometricStepUpController::class, 'challenge']);
            Route::post('auth/biometric/step-up/verify',    [BiometricStepUpController::class, 'verify']);
            Route::get('transactions/personnel',     [TransactionController::class, 'personnel']);
            Route::post('transactions/issue',        [TransactionController::class, 'issue']);
            Route::patch('transactions/{id}/return', [TransactionController::class, 'returnFirearm']);
            Route::post('transactions/sweep-overdue',[TransactionController::class, 'sweepOverdue']);
        });

        Route::middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian,Personnel')->group(function () {
            Route::get('transactions',      [TransactionController::class, 'index']);
            Route::get('transactions/{id}', [TransactionController::class, 'show']);
        });

        Route::get('maintenance', [MaintenanceController::class, 'index'])
            ->middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian');

        // S4 Officer requests (new firearms, repair budget); only the Command Officer decides.
        Route::middleware('role:Administrator,Command Officer,S4 Officer')->group(function () {
            Route::get('requests',                [LogisticsRequestController::class, 'index']);
            Route::get('requests/repair-summary', [LogisticsRequestController::class, 'repairSummary']);
        });
        Route::post('requests', [LogisticsRequestController::class, 'store'])
            ->middleware('role:Administrator,S4 Officer');
        Route::patch('requests/{id}/decide', [LogisticsRequestController::class, 'decide'])
            ->middleware('role:Command Officer');

        // Geofence/location writes
        Route::middleware('role:Administrator,Command Officer,S4 Officer')->group(function () {
            Route::post('locations',           [GpsLocationController::class, 'store']);
            Route::patch('locations/{id}',     [GpsLocationController::class, 'update']);
            Route::delete('locations/{id}',    [GpsLocationController::class, 'destroy']);
        });

        // User management — Administrator and Command Officer. UserController keeps
        // Administrator accounts out of a Command Officer's reach.
        Route::middleware('role:Administrator,Command Officer')->group(function () {
            Route::get('users',                [UserController::class, 'index']);
            Route::get('users/roles',          [UserController::class, 'roles']);
            Route::post('users',               [UserController::class, 'store']);
            Route::get('users/{id}',           [UserController::class, 'show']);
            Route::patch('users/{id}',         [UserController::class, 'update']);
            Route::delete('users/{id}',        [UserController::class, 'destroy']);
            Route::post('users/{id}/reset-mfa',[UserController::class, 'resetMfa']);
        });

        Route::middleware('role:Administrator')->group(function () {
            // System settings
            Route::get('settings',             [SettingsController::class, 'index']);
            Route::patch('settings',           [SettingsController::class, 'update']);
        });

        // Audit logs — operational staff with Secret-or-higher clearance
        Route::middleware([
            'role:Administrator,Command Officer,S4 Officer,Armory Custodian',
            'clearance:2',
        ])->group(function () {
            Route::get('audit-logs',           [AuditLogController::class, 'index']);
            Route::get('audit-logs/actions',   [AuditLogController::class, 'actions']);
            Route::get('audit-logs/verify',    [AuditLogController::class, 'verify']);
        });

        // Reports — operational staff only; security-sensitive reports also require Secret clearance
        Route::prefix('reports')
            ->middleware('role:Administrator,Command Officer,S4 Officer,Armory Custodian')
            ->group(function () {
                Route::get('inventory',                  [ReportController::class, 'inventory']);
                Route::get('transactions',               [ReportController::class, 'transactions']);
                Route::get('maintenance',                [ReportController::class, 'maintenance']);
                Route::get('personnel-assignment',       [ReportController::class, 'personnelAssignment']);
                Route::get('gps/{equipmentId}',          [ReportController::class, 'gpsHistory']);

                Route::middleware('clearance:2')->group(function () {
                    Route::get('audit',                  [ReportController::class, 'audit']);
                    Route::get('security-incidents',     [ReportController::class, 'securityIncidents']);
                });
            });
    });
});

// ----- High-frequency real-time endpoints, outside the default strict limiter -----
// These are tight idempotent reads polled by the topbar at sub-second cadence.
// They get their own 30 req/s bucket so they don't compete with normal user
// actions on the strict 5 req/s default.
Route::prefix('v1')->group(function () {
    // SSE stream — long-lived connection, no per-request rate limit.
    Route::get('gps/iot-stream', [GpsController::class, 'iotStream'])
        ->middleware(['auth.sanctum.query', 'role:Administrator,Command Officer,S4 Officer,Armory Custodian']);

    // Polling fallback — fits comfortably under a 30 req/s bucket.
    Route::get('gps/iot-status', [GpsController::class, 'iotStatus'])
        ->middleware(['auth:sanctum', 'role:Administrator,Command Officer,S4 Officer,Armory Custodian', 'rate.strict:30']);
});

Route::get('/health', fn () => response()->json([
    'status'  => 'ok',
    'service' => 'ArmoryDB API',
    'version' => '1.0.0',
    'time'    => now()->toIso8601String(),
]));
