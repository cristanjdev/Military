<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\GpsLog;
use App\Models\Notification;
use App\Models\SystemSetting;
use App\Models\Transaction;
use App\Models\User;
use App\Services\TrackerWatchdog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Client revision #8: notifications for failed and new sign-ins, account changes,
 * and IoT trackers that stop or resume sending location updates.
 */
class SecurityNotificationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
        config(['armory.rate_limit_per_second' => 100]);
    }

    private function user(string $username): User
    {
        return User::where('username', $username)->firstOrFail();
    }

    public function test_failed_sign_in_notifies_the_owner_every_time_and_oversight_once(): void
    {
        $owner = $this->user('cpl.santos');

        foreach ([1, 2] as $_) {
            $this->postJson('/api/v1/auth/login', ['username' => 'cpl.santos', 'password' => 'wrong-password'])->assertStatus(401);
        }

        $this->assertSame(2, Notification::where('user_id', $owner->user_id)->where('type', 'failed_login')->count());

        $officer = $this->user('cmd.officer');
        $toOfficer = Notification::where('user_id', $officer->user_id)->where('type', 'failed_login')->get();
        $this->assertCount(1, $toOfficer, 'A burst of failures is one oversight alert.');
        $this->assertStringContainsString('cpl.santos', $toOfficer->first()->message);
    }

    public function test_failed_sign_in_emails_only_the_owner(): void
    {
        Http::fake();
        config(['services.resend.key' => 'test-resend-key']);

        $this->postJson('/api/v1/auth/login', ['username' => 'cpl.santos', 'password' => 'wrong-password'])->assertStatus(401);

        // Oversight copies are in-app only; the owner's warning is the one e-mail.
        $this->assertGreaterThan(1, Notification::where('type', 'failed_login')->count());
        Http::assertSentCount(1);
        Http::assertSent(fn($request) => str_contains(json_encode($request->data()), $this->user('cpl.santos')->email));
    }

    public function test_an_oversight_owner_does_not_get_the_same_failed_sign_in_twice(): void
    {
        $officer = $this->user('cmd.officer');
        $this->postJson('/api/v1/auth/login', ['username' => 'cmd.officer', 'password' => 'wrong-password'])->assertStatus(401);

        $this->assertSame(1, Notification::where('user_id', $officer->user_id)->where('type', 'failed_login')->count());
    }

    public function test_failed_sign_in_for_an_unknown_username_alerts_oversight(): void
    {
        $this->postJson('/api/v1/auth/login', ['username' => 'intruder', 'password' => 'x'])->assertStatus(401);

        $admin = $this->user('admin');
        $this->assertDatabaseHas('notifications', ['user_id' => $admin->user_id, 'type' => 'failed_login']);
    }

    public function test_a_successful_sign_in_is_announced_to_the_user(): void
    {
        SystemSetting::setValue('totp_required', '0');
        SystemSetting::setValue('biometric_required', '0');
        $user = $this->user('cpl.santos');
        $user->forceFill(['password' => Hash::make('Correct-Horse-Battery-9')])->save();

        $this->postJson('/api/v1/auth/login', ['username' => 'cpl.santos', 'password' => 'Correct-Horse-Battery-9'])->assertOk();

        $note = Notification::where('user_id', $user->user_id)->where('type', 'new_login')->firstOrFail();
        $this->assertStringContainsString('You signed in', $note->message);
    }

    public function test_account_changes_by_an_officer_are_announced_to_the_account_owner(): void
    {
        Sanctum::actingAs($this->user('admin'));
        $target = $this->user('cpl.santos');

        $this->patchJson("/api/v1/users/{$target->user_id}", ['email' => 'new.santos@10rcdg.mil.ph', 'rank' => 'SGT'])->assertOk();

        $note = Notification::where('user_id', $target->user_id)->where('type', 'account_change')->firstOrFail();
        $this->assertStringContainsString('email', $note->message);
        $this->assertStringContainsString('rank', $note->message);
        $this->assertStringContainsString('by ', $note->message);
    }

    public function test_a_tracker_already_silent_when_first_watched_is_not_announced(): void
    {
        $tx = Transaction::with('firearm')->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->where('gps_tracking_enabled', true)->firstOrFail();
        GpsLog::where('transaction_id', $tx->transaction_id)->delete();
        GpsLog::create([
            'transaction_id' => $tx->transaction_id,
            'equipment_id'   => $tx->equipment_id,
            'captured_at'    => now()->subDays(3),
            'received_at'    => now()->subDays(3),
            'latitude'       => 8.4845,
            'longitude'      => 124.657,
            'device_id'      => 'OLD-TRACKER',
        ]);

        // E.g. right after installing this update: old history is not a fresh signal loss.
        TrackerWatchdog::sweep();
        TrackerWatchdog::sweep();
        $this->assertDatabaseMissing('notifications', ['type' => 'signal_lost', 'equipment_id' => $tx->equipment_id]);
    }

    public function test_tracker_going_silent_and_coming_back_is_announced(): void
    {
        $tx = Transaction::with('firearm')->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->where('gps_tracking_enabled', true)->firstOrFail();
        $device = 'TEST-TRACKER-01';
        GpsLog::where('transaction_id', $tx->transaction_id)->delete(); // only this test's report counts

        GpsLog::create([
            'transaction_id' => $tx->transaction_id,
            'equipment_id'   => $tx->equipment_id,
            'captured_at'    => now()->subMinutes(10),
            'received_at'    => now()->subMinutes(10),
            'latitude'       => 8.4845,
            'longitude'      => 124.657,
            'device_id'      => $device,
        ]);
        TrackerWatchdog::seen($device, $tx->firearm, $tx);
        $this->assertDatabaseHas('notifications', ['type' => 'iot_device_online', 'equipment_id' => $tx->equipment_id]);

        // Ten minutes of silence is past the online window.
        $this->assertGreaterThanOrEqual(1, TrackerWatchdog::sweep());
        $this->assertSame(0, TrackerWatchdog::sweep(), 'Lost once, announced once.');
        $lost = Notification::where('type', 'signal_lost')->where('equipment_id', $tx->equipment_id)->get();
        $this->assertStringContainsString($device, $lost->first()?->message ?? '');
        $this->assertNotEmpty($lost);
        $this->assertContains(User::where('username', 'cmd.officer')->value('user_id'), $lost->pluck('user_id'));

        TrackerWatchdog::seen($device, $tx->firearm, $tx);
        $this->assertDatabaseHas('notifications', ['type' => 'signal_restored', 'equipment_id' => $tx->equipment_id]);
    }
}
