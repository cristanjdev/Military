<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\Notification;
use App\Models\SystemSetting;
use App\Models\User;
use App\Services\AccountNotifier;
use App\Services\AuditLogger;
use App\Services\BiometricProof;
use App\Services\EmailDeliveryService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use PragmaRX\Google2FA\Google2FA;

class AuthController extends Controller
{
    public function __construct(private Google2FA $google2fa) {}

    /**
     * Public login-flow metadata used by the sign-in page.
     */
    public function requirements(): JsonResponse
    {
        $totpRequired = SystemSetting::isTotpRequired();
        $biometricRequired = SystemSetting::isBiometricRequired();

        return response()->json([
            'totp_required'      => $totpRequired,
            'biometric_required' => $biometricRequired,
            'mfa_required'       => $totpRequired || $biometricRequired,
            'recaptcha_action'   => (string) config('armory.recaptcha.expected_action', 'login'),
        ]);
    }

    /**
     * STEP 1 — Username + password.
     * Returns a short-lived "challenge" token that must accompany TOTP & fingerprint steps.
     */
    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username'        => ['required', 'string', 'max:100'],
            'password'        => ['required', 'string', 'max:200'],
            'recaptcha_token' => ['nullable', 'string', 'max:4096'],
        ]);

        $ip = $request->ip();
        $input = trim($data['username']);

        $user = User::with('role')
            ->whereRaw('LOWER(username) = ?', [strtolower($input)])
            ->orWhereRaw('LOWER(email) = ?', [strtolower($input)])
            ->first();

        $accountKey = $user ? $user->username : $input;
        $failKey = "login-fail:{$accountKey}:{$ip}";
        $lockoutAttempts = (int) config('armory.lockout_attempts', 5);

        if ($user) {
            // While locked, refuse every attempt before the password is checked: a wrong password must
            // not restart the lock, and the reply must not hint whether the password was right.
            if ($user->isLocked()) {
                AuditLogger::log('login_while_locked', "Sign-in attempt while {$accountKey} is locked", $user, request: $request);

                return $this->lockedResponse($user);
            }

            // A lock that has run out gives the account a fresh set of tries.
            if ($user->locked_until !== null || $user->failed_login_attempts >= $lockoutAttempts) {
                $user->forceFill(['failed_login_attempts' => 0, 'locked_until' => null])->save();
                Cache::forget($failKey);
            }
        }

        $fails = (int) Cache::get($failKey, 0);
        $threshold = (int) config('armory.failed_login_threshold', 3);

        if ($fails >= $threshold) {
            $recaptchaToken = (string) ($data['recaptcha_token'] ?? '');
            if ($recaptchaToken === '' || ! $this->verifyRecaptcha($recaptchaToken, $ip)) {
                AuditLogger::log(
                    'recaptcha_failed',
                    "reCAPTCHA verification failed for {$accountKey}",
                    request: $request,
                );

                return response()->json([
                    'message'            => 'Additional verification is required before retrying.',
                    'recaptcha_required' => true,
                    'attempts'           => $fails,
                ], 429);
            }
        }

        if (! $user || ! Hash::check($data['password'], $user->password)) {
            Cache::put($failKey, $fails + 1, now()->addMinutes(15));

            if ($user) {
                $user->increment('failed_login_attempts');

                AuditLogger::log('failed_login', "Failed password for {$accountKey}", $user, request: $request);
                AccountNotifier::failedLogin($user, $request, 'password');

                if ($user->failed_login_attempts >= $lockoutAttempts) {
                    $lockoutMinutes = (int) config('armory.lockout_minutes', 30);
                    $user->update(['locked_until' => now()->addMinutes($lockoutMinutes)]);

                    Notification::create([
                        'user_id'      => $user->user_id,
                        'type'         => 'account_locked',
                        'severity'     => Notification::SEVERITY_CRITICAL,
                        'title'        => 'Account Locked',
                        'message'      => "Account {$user->username} locked after {$lockoutAttempts} failed attempts. Unlocks in {$lockoutMinutes} min.",
                        'payload'      => ['ip' => $ip, 'attempts' => $user->failed_login_attempts],
                    ]);

                    AuditLogger::log('account_locked', "Account {$user->username} locked for {$lockoutMinutes} minutes after {$lockoutAttempts} failures", $user, request: $request);

                    // Say so on the attempt that locked it, instead of a plain "Invalid credentials".
                    return $this->lockedResponse($user);
                }
            } else {
                AuditLogger::log('failed_login', "Unknown username or email {$input}", request: $request);
                AccountNotifier::failedLogin(null, $request, 'username or password', $input);
            }

            return response()->json(['message' => 'Invalid credentials.'], 401);
        }

        if ((int) $user->status !== User::STATUS_ACTIVE) {
            return response()->json(['message' => 'Account is inactive.'], 403);
        }

        $challenge = bin2hex(random_bytes(32));
        $needsTotp = SystemSetting::isTotpRequired();
        $needsBiometric = SystemSetting::isBiometricRequired();
        $expiresAt = now()->addMinutes(5);

        Cache::put("login-challenge:{$challenge}", [
            'user_id'            => $user->user_id,
            'password_ok'        => true,
            'totp_required'      => $needsTotp,
            'biometric_required' => $needsBiometric,
            'totp_ok'            => ! $needsTotp,
            'biometric_ok'       => ! $needsBiometric,
            'started_at'         => now()->timestamp,
            'expires_at'         => $expiresAt->timestamp,
        ], $expiresAt);

        AuditLogger::log('login_step1', "Password verified for {$user->username}", $user, request: $request);

        if (! $needsTotp && ! $needsBiometric) {
            return $this->finalizeLogin($user, $request, $challenge);
        }

        $next = $needsTotp
            ? ($user->totp_secret ? 'totp' : 'totp_setup')
            : ($user->biometric_data ? 'biometric' : 'biometric_enroll');

        return response()->json([
            'message'             => 'Password verified — proceed to MFA.',
            'challenge_token'     => $challenge,
            // Seconds the unfinished sign-in stays valid; the UI shows a countdown from this.
            'challenge_expires_in' => max(0, $expiresAt->timestamp - now()->timestamp),
            'next'                => $next,
            'username'            => $user->username,
            'totp_enabled'        => (bool) $user->totp_enabled,
            'biometric_enrolled'  => (bool) $user->biometric_enrolled,
        ]);
    }

    /**
     * Request a password reset verification code using username or email.
     */
    public function forgotPassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'identifier' => ['required', 'string', 'max:100'],
        ]);

        $identifier = trim($data['identifier']);

        $user = User::whereRaw('LOWER(username) = ?', [strtolower($identifier)])
            ->orWhereRaw('LOWER(email) = ?', [strtolower($identifier)])
            ->first();

        if (! $user) {
            return response()->json([
                'message' => 'No active user account found matching that username or email address.',
            ], 404);
        }

        if ((int) $user->status !== User::STATUS_ACTIVE) {
            return response()->json([
                'message' => 'This account is currently inactive. Please contact an Armory Administrator.',
            ], 403);
        }

        $throttleKey = "forgot-password-throttle:{$user->user_id}";
        if (Cache::has($throttleKey)) {
            return response()->json([
                'message' => 'A password reset request was recently submitted. Please wait 60 seconds before requesting another code.',
            ], 429);
        }
        Cache::put($throttleKey, true, now()->addSeconds(60));

        $code = (string) random_int(100000, 999999);
        $resetToken = bin2hex(random_bytes(24));
        $cacheKey = "password-reset:{$resetToken}";

        Cache::put($cacheKey, [
            'user_id'    => $user->user_id,
            'code'       => $code,
            'email'      => $user->email,
            'username'   => $user->username,
            'created_at' => now()->timestamp,
        ], now()->addMinutes(15));

        $delivery = EmailDeliveryService::sendPasswordReset($user, $code, $request->ip(), 15);
        $maskedEmail = $this->maskEmail($user->email);

        if (! $delivery['sent']) {
            if ($delivery['sandbox_mode']) {
                AuditLogger::log(
                    'forgot_password_requested',
                    "Password reset code generated for {$user->username} (Resend sandbox mode)",
                    $user,
                    request: $request
                );

                return response()->json([
                    'message'      => "Verification code generated for local development: {$code}.",
                    'reset_token'  => $resetToken,
                    'masked_email' => $maskedEmail,
                    'dev_code'     => $code,
                    'sandbox_mode' => true,
                ]);
            }

            Cache::forget($throttleKey);
            Cache::forget($cacheKey);

            $detail = $delivery['error'] ? ": {$delivery['error']}" : '';
            return response()->json([
                'message' => "Unable to dispatch verification email{$detail}. Please verify your RESEND_API_KEY in Railway.",
            ], 503);
        }

        AuditLogger::log(
            'forgot_password_requested',
            "Password reset code requested for {$user->username} via Resend",
            $user,
            request: $request
        );

        return response()->json([
            'message'      => "A 6-digit verification code has been dispatched to {$maskedEmail}.",
            'reset_token'  => $resetToken,
            'masked_email' => $maskedEmail,
        ]);
    }

    /**
     * Confirm a password reset 6-digit verification code.
     */
    public function verifyResetCode(Request $request): JsonResponse
    {
        $data = $request->validate([
            'reset_token' => ['required', 'string'],
            'code'        => ['required', 'string', 'size:6'],
        ]);

        $cacheKey = "password-reset:{$data['reset_token']}";
        $resetData = Cache::get($cacheKey);

        if (! $resetData || ! hash_equals((string) $resetData['code'], trim($data['code']))) {
            return response()->json([
                'message' => 'Invalid or expired verification code.',
            ], 422);
        }

        $resetData['verified'] = true;
        Cache::put($cacheKey, $resetData, now()->addMinutes(15));

        return response()->json([
            'message'  => 'Verification code confirmed. You may now set your new password.',
            'verified' => true,
            'username' => $resetData['username'] ?? null,
        ]);
    }

    /**
     * Complete password reset using verification code or pre-verified reset token.
     */
    public function resetPassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'reset_token'           => ['required', 'string'],
            'code'                  => ['nullable', 'string', 'size:6'],
            'new_password'          => ['required', 'string', 'min:10', 'max:200', 'confirmed'],
        ]);

        $cacheKey = "password-reset:{$data['reset_token']}";
        $resetData = Cache::get($cacheKey);

        if (! $resetData) {
            return response()->json([
                'message' => 'Reset session has expired. Please request a new verification code.',
            ], 422);
        }

        $isVerified = ($resetData['verified'] ?? false) === true;
        $codeMatches = ! empty($data['code']) && hash_equals((string) $resetData['code'], trim($data['code']));

        if (! $isVerified && ! $codeMatches) {
            return response()->json([
                'message' => 'Invalid or unverified authorization code. Please confirm your code first.',
            ], 422);
        }

        $user = User::find($resetData['user_id']);
        if (! $user) {
            return response()->json([
                'message' => 'User account not found.',
            ], 404);
        }

        $user->update([
            'password'              => Hash::make($data['new_password']),
            'failed_login_attempts' => 0,
            'locked_until'          => null,
        ]);

        Cache::forget($cacheKey);
        Cache::forget("login-fail:{$user->username}:{$request->ip()}");

        AuditLogger::log(
            'password_reset_completed',
            "Password reset completed for {$user->username}",
            $user,
            request: $request
        );

        try {
            Notification::create([
                'user_id'  => $user->user_id,
                'type'     => 'password_reset',
                'severity' => Notification::SEVERITY_WARNING,
                'title'    => 'Password Reset Successful',
                'message'  => "Your ArmoryDB account password was reset successfully.",
                'payload'  => ['ip' => $request->ip(), 'time' => now()->toIso8601String()],
            ]);
        } catch (\Throwable $e) {
            Log::warning("Failed to create password reset notification: " . $e->getMessage());
        }

        return response()->json([
            'message'  => 'Password reset successfully. You can now sign in with your new password.',
            'username' => $user->username,
        ]);
    }

    private function maskEmail(string $email): string
    {
        $parts = explode('@', $email);
        if (count($parts) !== 2) {
            return $email;
        }
        $name = $parts[0];
        $domain = $parts[1];
        $len = strlen($name);
        if ($len <= 2) {
            $masked = substr($name, 0, 1) . '***';
        } else {
            $masked = substr($name, 0, 2) . str_repeat('*', max(3, $len - 3)) . substr($name, -1);
        }
        return $masked . '@' . $domain;
    }

    /**
     * STEP 2a — TOTP setup (first-time enrollment).
     */
    public function totpSetup(Request $request): JsonResponse
    {
        $data = $request->validate([
            'challenge_token' => ['required', 'string'],
        ]);

        $state = $this->loadChallenge($data['challenge_token']);
        if (! $state) {
            return response()->json(['message' => 'Invalid or expired challenge.'], 419);
        }
        if (! ($state['password_ok'] ?? false) || ! ($state['totp_required'] ?? false)) {
            return response()->json(['message' => 'TOTP setup is not permitted for this challenge.'], 403);
        }

        $user = User::findOrFail($state['user_id']);
        $secret = $this->google2fa->generateSecretKey();

        $user->update(['totp_secret' => $secret]);

        $issuer = config('armory.totp.issuer');
        $otpauth = $this->google2fa->getQRCodeUrl($issuer, $user->email, $secret);

        return response()->json([
            'secret'  => $secret,
            'otpauth' => $otpauth,
            'issuer'  => $issuer,
            'message' => 'Scan QR in Google Authenticator, then verify code.',
        ]);
    }

    /**
     * STEP 2b — TOTP verify (also enables totp_enabled on first success).
     */
    public function totpVerify(Request $request): JsonResponse
    {
        $data = $request->validate([
            'challenge_token' => ['required', 'string'],
            'code'            => ['required', 'string', 'size:6'],
        ]);

        $state = $this->loadChallenge($data['challenge_token']);
        if (! $state) {
            return response()->json(['message' => 'Invalid or expired challenge.'], 419);
        }
        if (! ($state['password_ok'] ?? false) || ! ($state['totp_required'] ?? false)) {
            return response()->json(['message' => 'TOTP verification is not permitted for this challenge.'], 403);
        }

        $user = User::findOrFail($state['user_id']);

        if (! $user->totp_secret) {
            return response()->json(['message' => 'TOTP not initialised.'], 400);
        }

        if (! $this->google2fa->verifyKey($user->totp_secret, $data['code'], 1)) {
            AuditLogger::log('failed_login', 'Invalid TOTP', $user, request: $request);
            AccountNotifier::failedLogin($user, $request, 'authenticator (TOTP) code');
            return response()->json(['message' => 'Invalid TOTP code.'], 401);
        }

        if (! $user->totp_enabled) {
            $user->update(['totp_enabled' => true]);
        }

        $state['totp_ok'] = true;
        $this->storeChallenge($data['challenge_token'], $state);

        AuditLogger::log('login_step2', "TOTP verified for {$user->username}", $user, request: $request);

        if ($state['biometric_ok'] ?? false) {
            return $this->finalizeLogin($user, $request, $data['challenge_token']);
        }

        return response()->json([
            'message' => 'TOTP verified.',
            'next'    => $user->biometric_data ? 'biometric' : 'biometric_enroll',
        ]);
    }

    /**
     * STEP 3 — Biometric (fingerprint) verify.
     *
     * Live readers go through the local biometric bridge (biometric-bridge/). The bridge
     * performs the 1:1 fingerprint match with the reader SDK and only then releases the
     * user's enrollment token as "fingerprint", signed with BIOMETRIC_BRIDGE_HMAC_SECRET.
     * Raw captures differ on every touch, so the backend compares the token's SHA-256
     * against the stored hash rather than comparing fingerprint data directly.
     */
    public function biometricVerify(Request $request): JsonResponse
    {
        $data = $request->validate([
            'challenge_token'  => ['required', 'string'],
            'fingerprint'      => ['required', 'string', 'min:32'],
            'source'           => ['required', 'string', 'in:digitalpersona_bridge,futronic_bridge,demo_placeholder'],
            'capture_signature'=> ['nullable', 'string', 'size:64'],
            'captured_at'      => ['nullable', 'date'],
        ]);

        $state = $this->loadChallenge($data['challenge_token']);
        if (! $state) {
            return response()->json(['message' => 'Invalid or expired challenge.'], 419);
        }
        if (! ($state['password_ok'] ?? false) || ! ($state['biometric_required'] ?? false)) {
            return response()->json(['message' => 'Biometric verification is not permitted for this challenge.'], 403);
        }
        if (! ($state['totp_ok'] ?? false)) {
            return response()->json(['message' => 'Complete TOTP verification first.'], 403);
        }
        $user = User::findOrFail($state['user_id']);

        if ($error = BiometricProof::check($data, $user, $data['challenge_token'], $request)) {
            return $error;
        }

        $hash = BiometricProof::hash($data['fingerprint']);

        if ($user->biometric_enrolled && $user->biometric_data) {
            if (! hash_equals($user->biometric_data, $hash)) {
                AuditLogger::log('failed_login', 'Biometric mismatch', $user, request: $request);
                AccountNotifier::failedLogin($user, $request, 'fingerprint');
                return response()->json(['message' => 'Fingerprint does not match.'], 401);
            }
        } else {
            $user->update([
                'biometric_data'     => $hash,
                'biometric_enrolled' => true,
            ]);

            AuditLogger::log(
                'biometric_enroll',
                "Fingerprint enrolled for {$user->username}",
                $user,
                request: $request,
                metadata: ['source' => $data['source']],
            );
        }

        $state['biometric_ok'] = true;
        $this->storeChallenge($data['challenge_token'], $state);

        AuditLogger::log(
            'login_step3',
            "Biometric verified for {$user->username}",
            $user,
            request: $request,
            metadata: ['source' => $data['source']],
        );

        return $this->finalizeLogin($user, $request, $data['challenge_token']);
    }

    /**
     * Finalize: clear failures, reset attempts, issue Sanctum token.
     */
    protected function finalizeLogin(User $user, Request $request, string $token): JsonResponse
    {
        $lock = Cache::lock("login-finalize:{$token}", 10);
        if (! $lock->get()) {
            return response()->json(['message' => 'Login finalization is already in progress.'], 409);
        }

        try {
            $state = $this->loadChallenge($token);
            $complete = $state
                && (int) ($state['user_id'] ?? 0) === (int) $user->user_id
                && ($state['password_ok'] ?? false)
                && (! ($state['totp_required'] ?? false) || ($state['totp_ok'] ?? false))
                && (! ($state['biometric_required'] ?? false) || ($state['biometric_ok'] ?? false));

            if (! $complete) {
                return response()->json(['message' => 'Authentication challenge is incomplete or expired.'], 403);
            }

            Cache::forget("login-challenge:{$token}");

            $user->update([
                'failed_login_attempts' => 0,
                'last_login_at'         => now(),
                'last_login_ip'         => $request->ip(),
                'locked_until'          => null,
            ]);

            // Clear obsolete lockout notifications for this user upon successful authentication
            Notification::where('user_id', $user->user_id)
                ->where('type', 'account_locked')
                ->where('status', Notification::STATUS_UNREAD)
                ->update([
                    'status'  => Notification::STATUS_READ,
                    'read_at' => now(),
                ]);

            Cache::forget("login-fail:{$user->username}:{$request->ip()}");

            $tokenString = $user->createToken(
                name: 'armorydb-' . substr(md5($request->userAgent() ?? ''), 0, 8),
                abilities: [optional($user->role)->role_name ?? 'personnel'],
                expiresAt: SystemSetting::isSessionExpiryEnabled()
                    ? now()->addMinutes((int) config('armory.session.timeout_minutes'))
                    : null
            )->plainTextToken;

            AuditLogger::log('login', "Successful login by {$user->username}", $user, request: $request);
            AccountNotifier::newLogin($user, $request);

            $user->load('role');
            $expiresIn = SystemSetting::isSessionExpiryEnabled()
                ? (int) config('armory.session.timeout_minutes') * 60
                : null;

            return response()->json([
                'message'    => 'Login successful.',
                'token'      => $tokenString,
                'token_type' => 'Bearer',
                'expires_in' => $expiresIn,
                'user'       => [
                    'user_id'            => $user->user_id,
                    'username'           => $user->username,
                    'full_name'          => $user->fullName(),
                    'email'              => $user->email,
                    'rank'               => $user->rank,
                    'role'               => optional($user->role)->role_name,
                    'security_clearance' => $user->security_clearance,
                    'totp_enabled'       => (bool) $user->totp_enabled,
                    'biometric_enrolled' => (bool) $user->biometric_enrolled,
                ],
            ]);
        } finally {
            $lock->release();
        }
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user()->load('role');
        return response()->json([
            'user_id'            => $user->user_id,
            'username'           => $user->username,
            'full_name'          => $user->fullName(),
            'email'              => $user->email,
            'rank'               => $user->rank,
            'role'               => optional($user->role)->role_name,
            'security_clearance' => $user->security_clearance,
            'totp_enabled'       => (bool) $user->totp_enabled,
            'biometric_enrolled' => (bool) $user->biometric_enrolled,
            'last_login_at'      => $user->last_login_at,
        ]);
    }

    public function logout(Request $request): JsonResponse
    {
        $user = $request->user();
        $request->user()->currentAccessToken()->delete();
        AuditLogger::log('logout', "User {$user->username} logged out", $user, request: $request);
        return response()->json(['message' => 'Logged out.']);
    }

    /**
     * Self-service password change for authenticated users.
     */
    public function changePassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'current_password' => ['required', 'string'],
            'new_password'     => ['required', 'string', 'min:10', 'max:200', 'confirmed'],
        ]);

        $user = $request->user();

        if (!Hash::check($data['current_password'], $user->password)) {
            return response()->json(['message' => 'Current password is incorrect.'], 422);
        }

        $user->update(['password' => Hash::make($data['new_password'])]);

        AuditLogger::log('password_change', "Password changed for {$user->username}", $user, request: $request);
        AccountNotifier::accountChanged($user, $user, ['password'], $request);

        return response()->json(['message' => 'Password updated successfully.']);
    }

    /**
     * Verify current password (used before showing new-password fields).
     */
    public function verifyPassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'current_password' => ['required', 'string'],
        ]);

        $user = $request->user();

        if (!Hash::check($data['current_password'], $user->password)) {
            return response()->json(['message' => 'Incorrect password.'], 422);
        }

        return response()->json(['message' => 'Password verified.']);
    }

    /**
     * Self-service: reset own TOTP so it re-enrolls on next login.
     */
    public function resetTotp(Request $request): JsonResponse
    {
        $user = $request->user();

        $user->update([
            'totp_secret'  => null,
            'totp_enabled' => false,
        ]);

        AuditLogger::log('totp_reset', "TOTP self-reset by {$user->username}", $user, request: $request);
        AccountNotifier::accountChanged($user, $user, ['authenticator (TOTP) reset'], $request);

        return response()->json([
            'message'      => 'TOTP has been reset. You will re-enroll on next login.',
            'totp_enabled' => false,
        ]);
    }

    /**
     * Self-service: reset own biometric so it re-enrolls on next login.
     */
    public function resetBiometric(Request $request): JsonResponse
    {
        $user = $request->user();

        $user->update([
            'biometric_data'     => null,
            'biometric_enrolled' => false,
        ]);

        AuditLogger::log('biometric_reset', "Biometric self-reset by {$user->username}", $user, request: $request);
        AccountNotifier::accountChanged($user, $user, ['fingerprint reset'], $request);

        return response()->json([
            'message'            => 'Biometric data has been reset. You will re-enroll on next login.',
            'biometric_enrolled' => false,
        ]);
    }

    /**
     * Self-service: re-enable TOTP (admin-only).
     */
    public function enableTotp(Request $request): JsonResponse
    {
        $user = $request->user();

        if (optional($user->role)->role_name !== 'Administrator') {
            return response()->json([
                'message' => 'TOTP is available for Administrators only.',
            ], 403);
        }

        $user->update(['totp_enabled' => true]);

        AuditLogger::log('totp_enable', "TOTP re-enabled by {$user->username}", $user, request: $request);

        return response()->json([
            'message'      => 'TOTP enabled. You will set up Google Authenticator on your next login.',
            'totp_enabled' => true,
        ]);
    }

    /**
     * Self-service: re-enable biometric (will require enrollment on next login).
     */
    public function enableBiometric(Request $request): JsonResponse
    {
        $user = $request->user();

        $user->update(['biometric_enrolled' => true]);

        AuditLogger::log('biometric_enable', "Biometric re-enabled by {$user->username}", $user, request: $request);

        return response()->json([
            'message'            => 'Biometric enabled. You will enroll your fingerprint on your next login.',
            'biometric_enrolled' => true,
        ]);
    }

    protected function loadChallenge(string $token): ?array
    {
        $state = Cache::get("login-challenge:{$token}");
        if (! is_array($state)) {
            return null;
        }

        if ((int) ($state['expires_at'] ?? 0) <= now()->timestamp) {
            Cache::forget("login-challenge:{$token}");
            return null;
        }

        return $state;
    }

    protected function storeChallenge(string $token, array $state): void
    {
        $expiresAt = (int) ($state['expires_at'] ?? 0);
        if ($expiresAt <= now()->timestamp) {
            Cache::forget("login-challenge:{$token}");
            return;
        }

        Cache::put("login-challenge:{$token}", $state, now()->setTimestamp($expiresAt));
    }

    /** 423 with how long the lock has left, so the sign-in page can say when to try again. */
    protected function lockedResponse(User $user): JsonResponse
    {
        $seconds = max(1, (int) ceil(now()->diffInSeconds($user->locked_until, false)));
        $minutes = (int) ceil($seconds / 60);
        $wait = $minutes <= 1 ? 'about a minute' : "{$minutes} minutes";

        return response()->json([
            'message'       => "This account is locked after too many wrong passwords. Try again in {$wait}, or reset your password.",
            'locked'        => true,
            'locked_until'  => $user->locked_until->toIso8601String(),
            'retry_after'   => $seconds,
        ], 423);
    }

    protected function verifyRecaptcha(string $token, string $ip): bool
    {
        if ($this->demoModeAllowed() && hash_equals('demo-recaptcha-bypass', $token)) {
            return true;
        }

        $secret = (string) config('armory.recaptcha.secret');
        if ($secret === '') {
            return false;
        }

        try {
            $response = Http::asForm()
                ->timeout(5)
                ->post((string) config('armory.recaptcha.verify_url'), [
                    'secret'   => $secret,
                    'response' => $token,
                    'remoteip' => $ip,
                ]);
        } catch (\Throwable) {
            return false;
        }

        if (! $response->successful()) {
            return false;
        }

        $result = $response->json();
        $expectedHostname = (string) config('armory.recaptcha.expected_hostname');

        if (! is_array($result)
            || ($result['success'] ?? false) !== true
            || ($expectedHostname !== '' && ($result['hostname'] ?? null) !== $expectedHostname)) {
            return false;
        }

        // v2 is pass/fail: Google reports no score or action, so a verified token is enough.
        if (config('armory.recaptcha.version', 'v2') === 'v2') {
            return true;
        }

        return ($result['action'] ?? null) === config('armory.recaptcha.expected_action')
            && (float) ($result['score'] ?? 0) >= (float) config('armory.recaptcha.min_score');
    }

    protected function demoModeAllowed(): bool
    {
        return BiometricProof::demoModeAllowed();
    }
}
