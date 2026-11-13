<?php

return [
    'demo_mode' => (bool) env('ARMORY_DEMO_MODE', false),

    'gps' => [
        'interval_seconds'        => (int) env('ARMORY_GPS_INTERVAL_SECONDS', 30),
        'latency_budget_seconds'  => (int) env('ARMORY_GPS_LATENCY_BUDGET_SECONDS', 5),
        'accuracy_meters'         => (int) env('ARMORY_GPS_ACCURACY_METERS', 10),
        'max_age_seconds'         => (int) env('ARMORY_GPS_MAX_AGE_SECONDS', 300),
        'future_tolerance_seconds'=> (int) env('ARMORY_GPS_FUTURE_TOLERANCE_SECONDS', 30),
        // Minutes an issued firearm must stay at its assigned destination.
        'destination_hold_minutes'=> (int) env('ARMORY_DESTINATION_HOLD_MINUTES', 90),
        // Tracker battery levels (%) that raise a "Low Battery" and a "Battery Critical" alert.
        'battery_low_pct'         => (int) env('ARMORY_BATTERY_LOW_PCT', 20),
        'battery_critical_pct'    => (int) env('ARMORY_BATTERY_CRITICAL_PCT', 10),
        // Below this cell voltage (mV) the tracker is not running from its battery (USB power,
        // switch off, no cell): the reading means "no battery", never 0%, and raises no alert.
        'battery_absent_mv'       => (int) env('ARMORY_BATTERY_ABSENT_MV', 2500),
    ],

    'session' => [
        'timeout_minutes' => (int) env('ARMORY_SESSION_TIMEOUT_MINUTES', 15),
    ],

    'rate_limit_per_second' => (int) env('ARMORY_RATE_LIMIT_PER_SECOND', 5),
    'failed_login_threshold'=> (int) env('ARMORY_FAILED_LOGIN_THRESHOLD', 3),
    'lockout_attempts'      => (int) env('ARMORY_LOCKOUT_ATTEMPTS', 5),
    'lockout_minutes'       => (int) env('ARMORY_LOCKOUT_MINUTES', 30),
    'default_overdue_hours' => (int) env('ARMORY_DEFAULT_OVERDUE_HOURS', 24),

    'iot' => [
        'hmac_secret' => env('IOT_HMAC_SECRET', ''),
    ],

    'recaptcha' => [
        // 'v2' = "I'm not a robot" checkbox (pass/fail); 'v3' = invisible score-based check.
        'version'          => env('RECAPTCHA_VERSION', 'v2'),
        'site_key'         => env('RECAPTCHA_SITE_KEY', ''),
        'secret'           => env('RECAPTCHA_SECRET_KEY', ''),
        'min_score'        => (float) env('RECAPTCHA_MIN_SCORE', 0.5),
        'verify_url'       => env('RECAPTCHA_VERIFY_URL', 'https://www.google.com/recaptcha/api/siteverify'),
        'expected_action'  => env('RECAPTCHA_EXPECTED_ACTION', 'login'),
        'expected_hostname'=> env('RECAPTCHA_EXPECTED_HOSTNAME', ''),
    ],

    'biometric' => [
        'bridge_hmac_secret' => env('BIOMETRIC_BRIDGE_HMAC_SECRET', ''),
        'attestation_max_age_seconds' => (int) env('BIOMETRIC_ATTESTATION_MAX_AGE_SECONDS', 60),
    ],

    'totp' => [
        'issuer' => env('TOTP_ISSUER', 'ArmoryDB-10RCDG'),
        'digits' => (int) env('TOTP_DIGITS', 6),
        'period' => (int) env('TOTP_PERIOD', 30),
    ],
];
