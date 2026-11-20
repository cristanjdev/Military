<?php

namespace Tests\Feature;

use App\Models\SystemSetting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();

        User::where('username', 'admin')->update([
            'password' => Hash::make('Admin@10RCDG!2025'),
        ]);
        SystemSetting::setValue('totp_required', '1');
        SystemSetting::setValue('biometric_required', '0');
        config([
            'armory.demo_mode' => false,
            'armory.failed_login_threshold' => 3,
        ]);
    }

    public function test_login_with_valid_credentials_returns_challenge_token(): void
    {
        $response = $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
        ]);

        $response->assertOk()
            ->assertJsonStructure(['challenge_token', 'next', 'totp_enabled', 'biometric_enrolled']);
    }

    public function test_login_with_invalid_credentials_returns_401(): void
    {
        $response = $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'wrong-password',
        ]);

        $response->assertStatus(401)
            ->assertJson(['message' => 'Invalid credentials.']);
    }

    public function test_login_with_unknown_user_returns_401(): void
    {
        $response = $this->postJson('/api/v1/auth/login', [
            'username' => 'nonexistent',
            'password' => 'whatever',
        ]);

        $response->assertStatus(401);
    }

    public function test_recaptcha_required_after_threshold_failures(): void
    {
        for ($i = 0; $i < 3; $i++) {
            $this->postJson('/api/v1/auth/login', [
                'username' => 'admin',
                'password' => 'wrong',
            ]);
        }

        $response = $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'wrong',
        ]);

        $response->assertStatus(429)
            ->assertJson(['recaptcha_required' => true]);
    }

    public function test_account_locks_after_max_failures(): void
    {
        config(['armory.lockout_attempts' => 3]);

        for ($i = 0; $i < 3; $i++) {
            $this->postJson('/api/v1/auth/login', [
                'username' => 'admin',
                'password' => 'wrong',
                'recaptcha_token' => 'bypass',
            ]);
        }

        $user = User::where('username', 'admin')->first();
        $this->assertNotNull($user->locked_until);
        $this->assertTrue($user->isLocked());
    }

    public function test_locked_account_cannot_login(): void
    {
        $user = User::where('username', 'admin')->first();
        $user->update(['locked_until' => now()->addMinutes(30)]);

        $response = $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
        ]);

        $response->assertStatus(423)
            ->assertJson(['locked' => true])
            ->assertJsonStructure(['message', 'locked_until', 'retry_after']);
    }

    public function test_the_attempt_that_locks_the_account_says_it_is_locked(): void
    {
        config(['armory.lockout_attempts' => 2]);
        $this->postJson('/api/v1/auth/login', ['username' => 'admin', 'password' => 'wrong'])->assertStatus(401);

        $this->postJson('/api/v1/auth/login', ['username' => 'admin', 'password' => 'wrong'])
            ->assertStatus(423)
            ->assertJson(['locked' => true]);
    }

    public function test_wrong_password_while_locked_neither_extends_the_lock_nor_reveals_the_password(): void
    {
        $user = User::where('username', 'admin')->first();
        $lockedUntil = now()->addMinutes(10)->startOfSecond();
        $user->forceFill(['failed_login_attempts' => 5, 'locked_until' => $lockedUntil])->save();

        $wrong = $this->postJson('/api/v1/auth/login', ['username' => 'admin', 'password' => 'wrong']);
        $right = $this->postJson('/api/v1/auth/login', ['username' => 'admin', 'password' => 'Admin@10RCDG!2025']);

        $wrong->assertStatus(423);
        $right->assertStatus(423);
        $this->assertSame($wrong->json('message'), $right->json('message'));

        $user->refresh();
        $this->assertSame(5, (int) $user->failed_login_attempts);
        $this->assertTrue($user->locked_until->equalTo($lockedUntil));
    }

    public function test_an_expired_lock_gives_a_fresh_set_of_tries(): void
    {
        $user = User::where('username', 'admin')->first();
        $user->forceFill(['failed_login_attempts' => 10, 'locked_until' => now()->subMinute()])->save();

        $this->postJson('/api/v1/auth/login', ['username' => 'admin', 'password' => 'wrong'])
            ->assertStatus(401);

        $user->refresh();
        $this->assertSame(1, (int) $user->failed_login_attempts);
        $this->assertNull($user->locked_until);
        $this->assertFalse($user->isLocked());
    }

    public function test_inactive_account_cannot_login(): void
    {
        $user = User::where('username', 'admin')->first();
        $user->update(['status' => User::STATUS_INACTIVE]);

        $response = $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
        ]);

        $response->assertStatus(403);
    }

    public function test_login_returns_token_only_when_mfa_is_disabled(): void
    {
        SystemSetting::setValue('totp_required', '0');
        SystemSetting::setValue('biometric_required', '0');

        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
        ])->assertOk()
            ->assertJsonStructure(['token', 'user'])
            ->assertJsonMissing(['challenge_token']);
    }

    public function test_biometric_cannot_skip_required_totp_step(): void
    {
        SystemSetting::setValue('biometric_required', '1');

        $login = $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
        ])->assertOk();

        $this->postJson('/api/v1/auth/biometric/verify', [
            'challenge_token' => $login->json('challenge_token'),
            'fingerprint' => str_repeat('a', 32),
            'source' => 'futronic_bridge',
        ])->assertStatus(403)
            ->assertJson(['message' => 'Complete TOTP verification first.']);
    }

    public function test_recaptcha_accepts_only_matching_action_score_and_hostname(): void
    {
        config([
            'armory.failed_login_threshold' => 1,
            'armory.recaptcha.version' => 'v3',
            'armory.recaptcha.secret' => 'test-secret',
            'armory.recaptcha.verify_url' => 'https://recaptcha.test/verify',
            'armory.recaptcha.expected_action' => 'armory_login',
            'armory.recaptcha.expected_hostname' => 'armory.test',
            'armory.recaptcha.min_score' => 0.7,
        ]);
        Http::fake([
            'https://recaptcha.test/verify' => Http::response([
                'success' => true,
                'action' => 'armory_login',
                'score' => 0.9,
                'hostname' => 'armory.test',
            ]),
        ]);

        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'wrong',
        ])->assertUnauthorized();

        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
            'recaptcha_token' => 'valid-token',
        ])->assertOk()->assertJsonStructure(['challenge_token']);

        Http::assertSentCount(1);
    }

    public function test_recaptcha_v2_checkbox_accepts_a_verified_token_without_score_or_action(): void
    {
        config([
            'armory.failed_login_threshold' => 1,
            'armory.recaptcha.version' => 'v2',
            'armory.recaptcha.secret' => 'test-secret',
            'armory.recaptcha.verify_url' => 'https://recaptcha.test/verify',
            'armory.recaptcha.expected_hostname' => 'armory.test',
        ]);
        Http::fake([
            'https://recaptcha.test/verify' => Http::response([
                'success' => true,
                'hostname' => 'armory.test',
            ]),
        ]);

        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'wrong',
        ])->assertUnauthorized();

        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
            'recaptcha_token' => 'ticked-checkbox-token',
        ])->assertOk()->assertJsonStructure(['challenge_token']);
    }

    public function test_recaptcha_v2_rejects_failed_or_wrong_hostname_verification(): void
    {
        config([
            'armory.failed_login_threshold' => 1,
            'armory.recaptcha.version' => 'v2',
            'armory.recaptcha.secret' => 'test-secret',
            'armory.recaptcha.verify_url' => 'https://recaptcha.test/verify',
            'armory.recaptcha.expected_hostname' => 'armory.test',
        ]);
        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'wrong',
        ])->assertUnauthorized();

        foreach ([
            ['success' => false, 'error-codes' => ['invalid-input-response']],
            ['success' => true, 'hostname' => 'evil.example'],
        ] as $googleReply) {
            Http::fake(['https://recaptcha.test/verify' => Http::response($googleReply)]);

            $this->postJson('/api/v1/auth/login', [
                'username' => 'admin',
                'password' => 'Admin@10RCDG!2025',
                'recaptcha_token' => 'token',
            ])->assertStatus(429)->assertJson(['recaptcha_required' => true]);
        }
    }

    public function test_recaptcha_fails_closed_for_mismatched_or_unavailable_verification(): void
    {
        config([
            'armory.failed_login_threshold' => 1,
            'armory.recaptcha.version' => 'v3',
            'armory.recaptcha.secret' => 'test-secret',
            'armory.recaptcha.verify_url' => 'https://recaptcha.test/verify',
            'armory.recaptcha.expected_action' => 'login',
        ]);
        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'wrong',
        ])->assertUnauthorized();

        Http::fake([
            'https://recaptcha.test/verify' => Http::response([
                'success' => true,
                'action' => 'other_action',
                'score' => 1.0,
            ]),
        ]);
        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
            'recaptcha_token' => 'mismatched-token',
        ])->assertStatus(429)->assertJson(['recaptcha_required' => true]);

        Http::fake([
            'https://recaptcha.test/verify' => Http::response([], 503),
        ]);
        $this->postJson('/api/v1/auth/login', [
            'username' => 'admin',
            'password' => 'Admin@10RCDG!2025',
            'recaptcha_token' => 'unavailable-token',
        ])->assertStatus(429)->assertJson(['recaptcha_required' => true]);
    }

    public function test_live_biometric_capture_requires_valid_challenge_bound_attestation(): void
    {
        $user = User::where('username', 'admin')->firstOrFail();
        $challenge = str_repeat('c', 64);
        $fingerprint = str_repeat('f', 32);
        $capturedAt = now()->toIso8601String();
        $secret = 'bridge-test-secret';
        config(['armory.biometric.bridge_hmac_secret' => $secret]);
        Cache::put("login-challenge:{$challenge}", [
            'user_id' => $user->user_id,
            'password_ok' => true,
            'totp_required' => true,
            'biometric_required' => true,
            'totp_ok' => true,
            'biometric_ok' => false,
            'expires_at' => now()->addMinutes(5)->timestamp,
        ], now()->addMinutes(5));

        $basePayload = [
            'challenge_token' => $challenge,
            'fingerprint' => $fingerprint,
            'source' => 'futronic_bridge',
            'captured_at' => $capturedAt,
        ];
        $this->postJson('/api/v1/auth/biometric/verify', $basePayload + [
            'capture_signature' => str_repeat('0', 64),
        ])->assertUnauthorized();

        $signaturePayload = implode('|', [
            $challenge,
            $user->username,
            $capturedAt,
            hash('sha256', $fingerprint),
        ]);
        $this->postJson('/api/v1/auth/biometric/verify', $basePayload + [
            'capture_signature' => hash_hmac('sha256', $signaturePayload, $secret),
        ])->assertOk()->assertJsonStructure(['token', 'user']);
    }

    public function test_forgot_password_dispatches_successfully(): void
    {
        config(['mail.default' => 'log']);
        $response = $this->postJson('/api/v1/auth/forgot-password', [
            'identifier' => 'admin',
        ]);

        $response->assertOk()
            ->assertJsonStructure(['message', 'reset_token', 'masked_email']);
    }

    public function test_forgot_password_resend_api_dispatch(): void
    {
        putenv('RESEND_API_KEY=re_test_key_123');
        Http::fake([
            'https://api.resend.com/emails' => Http::response(['id' => 'res_123'], 200),
        ]);

        $response = $this->postJson('/api/v1/auth/forgot-password', [
            'identifier' => 'admin',
        ]);

        $response->assertOk()
            ->assertJsonStructure(['message', 'reset_token', 'masked_email']);

        putenv('RESEND_API_KEY');
    }

    public function test_forgot_password_resend_sandbox_mode_gracefully(): void
    {
        putenv('RESEND_API_KEY');

        $response = $this->postJson('/api/v1/auth/forgot-password', [
            'identifier' => 'admin',
        ]);

        $response->assertOk()
            ->assertJsonStructure(['message', 'reset_token', 'masked_email', 'dev_code', 'sandbox_mode'])
            ->assertJson(['sandbox_mode' => true]);

        $devCode = $response->json('dev_code');
        $resetToken = $response->json('reset_token');
        $this->assertNotEmpty($devCode);
        $this->assertEquals(6, strlen($devCode));

        // The session must still be active and verifiable
        $verifyRes = $this->postJson('/api/v1/auth/verify-reset-code', [
            'reset_token' => $resetToken,
            'code'        => $devCode,
        ]);
        $verifyRes->assertOk()->assertJson(['verified' => true]);

        // Complete password reset
        $resetRes = $this->postJson('/api/v1/auth/reset-password', [
            'reset_token'               => $resetToken,
            'code'                      => $devCode,
            'new_password'              => 'NewSecretPassword!2026',
            'new_password_confirmation' => 'NewSecretPassword!2026',
        ]);
        $resetRes->assertOk();
    }
}
