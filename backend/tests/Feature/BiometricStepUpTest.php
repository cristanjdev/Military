<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\FirearmEquipment;
use App\Models\SystemSetting;
use App\Models\Transaction;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Fingerprint re-scan before issuing/returning a firearm.
 */
class BiometricStepUpTest extends TestCase
{
    use RefreshDatabase;

    private const SECRET = 'bridge-test-secret';
    private const TOKEN = 'dp1-enrollment-token-for-the-custodian-0001';

    private User $custodian;
    private User $personnel;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();

        config([
            'armory.demo_mode' => false,
            'armory.biometric.bridge_hmac_secret' => self::SECRET,
            // A scripted test fires many requests per second; the 5/s limit is for real traffic.
            'armory.rate_limit_per_second' => 100,
        ]);
        SystemSetting::setValue('biometric_required', '1');

        $this->custodian = User::where('username', 'armory.custodian')->firstOrFail();
        $this->custodian->update([
            'biometric_data'     => hash('sha256', self::TOKEN),
            'biometric_enrolled' => true,
        ]);
        $this->personnel = User::where('username', 'pvt.dela.cruz')->firstOrFail();

        Sanctum::actingAs($this->custodian, ['Armory Custodian']);
    }

    /** Signs a capture the way the local bridge does. */
    private function proof(string $challenge, string $token = self::TOKEN, ?string $secret = null): array
    {
        $capturedAt = now()->toIso8601String();
        $payload = implode('|', [$challenge, $this->custodian->username, $capturedAt, hash('sha256', $token)]);

        return [
            'challenge'         => $challenge,
            'fingerprint'       => $token,
            'source'            => 'digitalpersona_bridge',
            'captured_at'       => $capturedAt,
            'capture_signature' => hash_hmac('sha256', $payload, $secret ?? self::SECRET),
        ];
    }

    /** Runs the full scan flow and returns the one-time grant. */
    private function grantFor(string $action, string $target): string
    {
        $challenge = $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => $action,
            'target' => $target,
        ])->assertOk()->json('challenge');

        return $this->postJson('/api/v1/auth/biometric/step-up/verify', $this->proof($challenge))
            ->assertOk()
            ->json('grant');
    }

    private function availableFirearm(): FirearmEquipment
    {
        return FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->firstOrFail();
    }

    private function issuePayload(FirearmEquipment $firearm, array $extra = []): array
    {
        return $extra + [
            'equipment_id'       => $firearm->equipment_id,
            'user_id'            => $this->personnel->user_id,
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => 1,
            'condition_on_issue' => 2,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ];
    }

    public function test_issuing_requires_a_fingerprint_confirmation(): void
    {
        $firearm = $this->availableFirearm();

        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearm))
            ->assertStatus(428)
            ->assertJson(['biometric_required' => true]);

        $this->assertSame(FirearmEquipment::STATUS_AVAILABLE, $firearm->fresh()->availability_status);
    }

    public function test_issuing_works_with_a_valid_grant_and_the_grant_is_single_use(): void
    {
        $firearm = $this->availableFirearm();
        $grant = $this->grantFor('issue', 'equipment:' . $firearm->equipment_id);

        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearm, ['biometric_grant' => $grant]))
            ->assertCreated();

        // The same grant must not authorise a second issuance.
        $other = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->firstOrFail();
        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($other, ['biometric_grant' => $grant]))
            ->assertForbidden();
    }

    public function test_a_grant_is_bound_to_one_firearm(): void
    {
        $firearms = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->take(2)->get();
        $grant = $this->grantFor('issue', 'equipment:' . $firearms[0]->equipment_id);

        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearms[1], ['biometric_grant' => $grant]))
            ->assertForbidden();
    }

    public function test_a_return_grant_cannot_be_used_to_issue(): void
    {
        $firearm = $this->availableFirearm();
        $grant = $this->grantFor('return', 'transaction:' . $firearm->equipment_id);

        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearm, ['biometric_grant' => $grant]))
            ->assertForbidden();
    }

    public function test_returning_requires_and_accepts_a_confirmation(): void
    {
        $firearm = $this->availableFirearm();
        $issueGrant = $this->grantFor('issue', 'equipment:' . $firearm->equipment_id);
        $txId = $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearm, ['biometric_grant' => $issueGrant]))
            ->assertCreated()
            ->json('transaction_id');

        $body = ['condition_on_return' => 1, 'notes' => 'ok'];

        $this->patchJson("/api/v1/transactions/{$txId}/return", $body)->assertStatus(428);
        $this->assertSame(Transaction::STATUS_ACTIVE, Transaction::findOrFail($txId)->status);

        $grant = $this->grantFor('return', 'transaction:' . $txId);
        $this->patchJson("/api/v1/transactions/{$txId}/return", $body + ['biometric_grant' => $grant])->assertOk();
        $this->assertSame(Transaction::STATUS_RETURNED, Transaction::findOrFail($txId)->status);
    }

    public function test_a_validation_error_does_not_use_up_the_grant(): void
    {
        $firearm = $this->availableFirearm();
        $grant = $this->grantFor('issue', 'equipment:' . $firearm->equipment_id);

        $this->postJson('/api/v1/transactions/issue', ['biometric_grant' => $grant, 'equipment_id' => $firearm->equipment_id])
            ->assertUnprocessable();

        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearm, ['biometric_grant' => $grant]))
            ->assertCreated();
    }

    public function test_the_wrong_finger_is_rejected_and_audited(): void
    {
        $challenge = $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => 'issue',
            'target' => 'equipment:1',
        ])->json('challenge');

        $this->postJson('/api/v1/auth/biometric/step-up/verify', $this->proof($challenge, 'dp1-some-other-persons-token-000000000'))
            ->assertUnauthorized();

        $this->assertTrue(AuditLog::where('action', 'biometric_stepup_failed')->exists());
    }

    public function test_a_forged_bridge_signature_is_rejected(): void
    {
        $challenge = $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => 'issue',
            'target' => 'equipment:1',
        ])->json('challenge');

        $this->postJson('/api/v1/auth/biometric/step-up/verify', $this->proof($challenge, self::TOKEN, 'not-the-real-secret'))
            ->assertUnauthorized();
    }

    public function test_a_challenge_stops_working_after_three_failures(): void
    {
        $challenge = $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => 'issue',
            'target' => 'equipment:1',
        ])->json('challenge');

        $wrong = $this->proof($challenge, 'dp1-some-other-persons-token-000000000');
        for ($i = 0; $i < 3; $i++) {
            $this->postJson('/api/v1/auth/biometric/step-up/verify', $wrong)->assertUnauthorized();
        }

        // Even the right finger is refused once the challenge is burned.
        $this->postJson('/api/v1/auth/biometric/step-up/verify', $this->proof($challenge))->assertStatus(419);
    }

    public function test_a_challenge_cannot_be_used_by_another_user(): void
    {
        $challenge = $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => 'issue',
            'target' => 'equipment:1',
        ])->json('challenge');

        $admin = User::where('username', 'admin')->firstOrFail();
        Sanctum::actingAs($admin, ['Administrator']);

        $this->postJson('/api/v1/auth/biometric/step-up/verify', $this->proof($challenge))->assertStatus(419);
    }

    public function test_an_unenrolled_user_is_told_to_enroll(): void
    {
        $this->custodian->update(['biometric_data' => null, 'biometric_enrolled' => false]);

        $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => 'issue',
            'target' => 'equipment:1',
        ])->assertStatus(409);
    }

    public function test_nothing_extra_is_needed_when_biometrics_are_switched_off(): void
    {
        SystemSetting::setValue('biometric_required', '0');
        $firearm = $this->availableFirearm();

        $this->postJson('/api/v1/auth/biometric/step-up/challenge', [
            'action' => 'issue',
            'target' => 'equipment:' . $firearm->equipment_id,
        ])->assertOk()->assertJson(['required' => false]);

        $this->postJson('/api/v1/transactions/issue', $this->issuePayload($firearm))->assertCreated();
    }
}
