<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class UserUnlockTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
    }

    private function lockedUser(): User
    {
        $user = User::where('username', 'pvt.dela.cruz')->first();
        $user->forceFill(['failed_login_attempts' => 5, 'locked_until' => now()->addMinutes(30)])->save();

        return $user;
    }

    public function test_administrator_can_unlock_a_locked_account(): void
    {
        Sanctum::actingAs(User::where('username', 'admin')->first(), ['Administrator']);
        $user = $this->lockedUser();

        $this->postJson("/api/v1/users/{$user->user_id}/unlock")->assertOk();

        $user->refresh();
        $this->assertFalse($user->isLocked());
        $this->assertNull($user->locked_until);
        $this->assertSame(0, (int) $user->failed_login_attempts);
        $this->assertDatabaseHas('audit_logs', ['action' => 'account_unlock']);
    }

    public function test_other_roles_cannot_unlock(): void
    {
        Sanctum::actingAs(User::where('username', 'cmd.officer')->first(), ['Command Officer']);
        $user = $this->lockedUser();

        $this->postJson("/api/v1/users/{$user->user_id}/unlock")->assertForbidden();
        $this->assertTrue($user->fresh()->isLocked());
    }

    public function test_unlocking_an_account_that_is_not_locked_is_refused(): void
    {
        Sanctum::actingAs(User::where('username', 'admin')->first(), ['Administrator']);
        $user = User::where('username', 'pvt.dela.cruz')->first();

        $this->postJson("/api/v1/users/{$user->user_id}/unlock")->assertStatus(422);
    }
}
