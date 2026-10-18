<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\MaintenanceRecord;
use App\Models\Role;
use App\Models\Transaction;
use App\Models\AuditLog;
use App\Models\GpsLocation;
use App\Models\User;
use App\Services\AuditChain;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Client revisions of 2026-10-15: issuance purposes, maintenance result status,
 * report totals, and Command Officer access.
 */
class ClientRevisionTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
        config(['armory.rate_limit_per_second' => 100]);
    }

    private function actAs(string $username): User
    {
        $user = User::where('username', $username)->firstOrFail();
        Sanctum::actingAs($user);
        return $user;
    }

    private function availableFirearm(): FirearmEquipment
    {
        return FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->firstOrFail();
    }

    public function test_issuance_accepts_only_training_or_operation(): void
    {
        $this->actAs('armory.custodian');
        $personnel = User::where('username', 'pvt.dela.cruz')->first();

        foreach ([Transaction::PURPOSE_MAINTENANCE, Transaction::PURPOSE_INSPECTION] as $purpose) {
            $this->postJson('/api/v1/transactions/issue', [
                'equipment_id'       => $this->availableFirearm()->equipment_id,
                'user_id'            => $personnel->user_id,
                'expected_return_at' => now()->addHours(8)->toIso8601String(),
                'purpose'            => $purpose,
                'condition_on_issue' => 2,
            ])->assertStatus(422)->assertJsonValidationErrors('purpose');
        }
    }

    public function test_maintenance_result_decides_firearm_availability(): void
    {
        $this->actAs('armory.custodian');
        $firearm = $this->availableFirearm();

        $this->postJson('/api/v1/maintenance', [
            'equipment_id'     => $firearm->equipment_id,
            'maintenance_type' => 'Repair',
            'result_status'    => MaintenanceRecord::RESULT_NEEDS_REPAIR,
            'maintenance_date' => now()->toDateString(),
            'description'      => 'Extractor worn, part on order.',
            'cost'             => 1500,
        ])->assertCreated()->assertJsonFragment(['result_status' => MaintenanceRecord::RESULT_NEEDS_REPAIR, 'cost' => 1500]);

        $firearm->refresh();
        $this->assertSame(FirearmEquipment::STATUS_MAINTENANCE, (int) $firearm->availability_status);
        $this->assertSame(FirearmEquipment::CONDITION_FAIR, (int) $firearm->condition_status);

        $this->postJson('/api/v1/maintenance', [
            'equipment_id'     => $firearm->equipment_id,
            'maintenance_type' => 'Repair',
            'result_status'    => MaintenanceRecord::RESULT_SERVICEABLE,
            'maintenance_date' => now()->toDateString(),
            'description'      => 'Extractor replaced, function check passed.',
        ])->assertCreated();

        $firearm->refresh();
        $this->assertSame(FirearmEquipment::STATUS_AVAILABLE, (int) $firearm->availability_status);
        $this->assertSame(FirearmEquipment::CONDITION_GOOD, (int) $firearm->condition_status);
    }

    public function test_maintenance_cost_is_whole_pesos_and_result_is_required(): void
    {
        $this->actAs('armory.custodian');
        $base = [
            'equipment_id'     => $this->availableFirearm()->equipment_id,
            'maintenance_type' => 'Cleaning',
            'maintenance_date' => now()->toDateString(),
            'description'      => 'Routine cleaning.',
        ];

        $this->postJson('/api/v1/maintenance', $base + ['result_status' => 1, 'cost' => 12.5])
            ->assertStatus(422)->assertJsonValidationErrors('cost');
        $this->postJson('/api/v1/maintenance', $base)
            ->assertStatus(422)->assertJsonValidationErrors('result_status');
    }

    public function test_maintenance_on_a_checked_out_firearm_keeps_it_checked_out(): void
    {
        $this->actAs('armory.custodian');
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_CHECKED_OUT)->firstOrFail();

        $this->postJson('/api/v1/maintenance', [
            'equipment_id'     => $firearm->equipment_id,
            'maintenance_type' => 'Inspection',
            'result_status'    => MaintenanceRecord::RESULT_SERVICEABLE,
            'maintenance_date' => now()->toDateString(),
            'description'      => 'Field inspection.',
        ])->assertCreated();

        $this->assertSame(FirearmEquipment::STATUS_CHECKED_OUT, (int) $firearm->fresh()->availability_status);
    }

    public function test_inventory_pdf_renders_with_total_and_signature_block(): void
    {
        $this->actAs('admin');
        $response = $this->get('/api/v1/reports/inventory?format=pdf');
        $response->assertOk();
        $this->assertStringStartsWith('%PDF', $response->getContent());

        // The template itself: total row, logo and received-by line.
        $html = view('reports.generic', [
            'title'       => 'Inventory Report',
            'columns'     => ['serial_number', 'cost_php'],
            'rows'        => collect([['serial_number' => 'A', 'cost_php' => 1000.4], ['serial_number' => 'B', 'cost_php' => 2500]]),
            'money'       => ['cost_php'],
            'totals'      => ['cost_php' => 3500],
            'logo'        => 'data:image/png;base64,AAAA',
            'preparedBy'  => 'CIV System Administrator',
            'generatedAt' => now()->format('Y-m-d H:i:s'),
        ])->render();

        $this->assertStringContainsString('PHP 3,500', $html);
        $this->assertStringContainsString('TOTAL COST', $html);
        $this->assertStringContainsString('Received by:', $html);
        $this->assertStringContainsString('data:image/png;base64,AAAA', $html);
        $this->assertStringNotContainsString('1000.40', $html);
    }

    public function test_command_officer_reaches_user_management_inventory_and_geofences(): void
    {
        $this->actAs('cmd.officer');

        $this->getJson('/api/v1/users')->assertOk();
        $this->getJson('/api/v1/maintenance')->assertOk();
        $this->postJson('/api/v1/locations', [])->assertStatus(422); // reached validation, not 403
        $this->postJson('/api/v1/firearms', [])->assertStatus(422);
    }

    public function test_command_officer_cannot_touch_administrator_accounts(): void
    {
        $this->actAs('cmd.officer');
        $admin     = User::where('username', 'admin')->first();
        $adminRole = Role::where('role_name', Role::ADMIN)->first();
        $personnel = User::where('username', 'pvt.dela.cruz')->first();

        $this->patchJson("/api/v1/users/{$admin->user_id}", ['first_name' => 'X'])->assertForbidden();
        $this->deleteJson("/api/v1/users/{$admin->user_id}")->assertForbidden();
        $this->postJson("/api/v1/users/{$admin->user_id}/reset-mfa")->assertForbidden();
        $this->patchJson("/api/v1/users/{$personnel->user_id}", [
            'role_id' => $adminRole->role_id, 'security_clearance' => 3,
        ])->assertForbidden();

        // Everyone else is fair game.
        $this->patchJson("/api/v1/users/{$personnel->user_id}", ['phone' => '09170000000'])->assertOk();
    }

    public function test_command_officer_still_cannot_change_system_settings(): void
    {
        $this->actAs('cmd.officer');
        $this->getJson('/api/v1/settings')->assertForbidden();
    }
    public function test_transactions_can_be_searched_by_name_serial_or_id(): void
    {
        $this->actAs('armory.custodian');
        $tx = Transaction::with(['user', 'firearm'])->firstOrFail();

        $byName = $this->getJson('/api/v1/transactions?search=' . urlencode($tx->user->first_name . ' ' . $tx->user->last_name))->assertOk();
        $this->assertContains($tx->transaction_id, array_column($byName->json('data'), 'transaction_id'));
        foreach ($byName->json('data') as $row) {
            $this->assertSame($tx->user_id, $row['user_id']);
        }

        $bySerial = $this->getJson('/api/v1/transactions?search=' . urlencode($tx->firearm->serial_number))->assertOk();
        foreach ($bySerial->json('data') as $row) {
            $this->assertSame($tx->equipment_id, $row['equipment_id']);
        }

        $byId = $this->getJson("/api/v1/transactions?search=%23{$tx->transaction_id}")->assertOk();
        $this->assertContains($tx->transaction_id, array_column($byId->json('data'), 'transaction_id'));

        $this->getJson('/api/v1/transactions?search=zzz-no-such-thing')->assertOk()->assertJsonPath('total', 0);
    }

    public function test_transactions_can_be_sorted_by_each_column(): void
    {
        $this->actAs('armory.custodian');
        $all = Transaction::with(['user', 'firearm'])->get();
        $this->assertGreaterThan(1, $all->count());

        $ids = fn(string $query) => array_column(
            $this->getJson("/api/v1/transactions?per_page=100&{$query}")->assertOk()->json('data'),
            'transaction_id'
        );

        $this->assertSame($all->sortBy('transaction_id')->pluck('transaction_id')->values()->all(), $ids('sort=transaction&dir=asc'));
        $this->assertSame($all->sortByDesc('transaction_id')->pluck('transaction_id')->values()->all(), $ids('sort=transaction&dir=desc'));

        $byDate = fn(string $column, string $dir) => array_map(
            fn($id) => (string) $all->firstWhere('transaction_id', $id)->{$column},
            $ids("sort=" . ($column === 'checkout_at' ? 'checkout' : 'expected_return') . "&dir={$dir}")
        );
        foreach (['checkout_at', 'expected_return_at'] as $column) {
            $asc = $byDate($column, 'asc');
            $sorted = $asc;
            sort($sorted);
            $this->assertSame($sorted, $asc, "{$column} ascending");
            $desc = $byDate($column, 'desc');
            rsort($sorted);
            $this->assertSame($sorted, $desc, "{$column} descending");
        }

        $serials = array_map(
            fn($id) => $all->firstWhere('transaction_id', $id)->firearm->serial_number,
            $ids('sort=firearm&dir=asc')
        );
        $sorted = $serials;
        sort($sorted, SORT_STRING | SORT_FLAG_CASE);
        $this->assertSame($sorted, $serials);

        // Unknown sort keys fall back to newest checkout first instead of erroring.
        $this->getJson('/api/v1/transactions?sort=password&dir=sideways')->assertOk();
    }

    public function test_personnel_search_stays_limited_to_their_own_transactions(): void
    {
        $me = $this->actAs('pvt.dela.cruz');
        $other = Transaction::with('user')->where('user_id', '!=', $me->user_id)->firstOrFail();

        $res = $this->getJson('/api/v1/transactions?search=' . urlencode($other->user->last_name))->assertOk();
        foreach ($res->json('data') as $row) {
            $this->assertSame($me->user_id, $row['user_id']);
        }
    }

    public function test_an_overdue_firearm_cannot_be_deleted(): void
    {
        $officer = $this->actAs('cmd.officer');
        $password = $this->withPassword($officer);
        $firearm = $this->availableFirearm();
        $firearm->update(['availability_status' => FirearmEquipment::STATUS_OVERDUE]);

        $this->deleteJson("/api/v1/firearms/{$firearm->equipment_id}", ['password' => $password])->assertStatus(422);
        $this->assertNotSoftDeleted('firearm_equipment', ['equipment_id' => $firearm->equipment_id]);
    }

    public function test_the_change_log_ignores_values_that_only_look_different(): void
    {
        $this->assertSame([], \App\Services\AuditLogger::diff(
            ['due' => '2026-11-01 00:00:00', 'lat' => '8.4844600', 'armory' => 1, 'phone' => null],
            ['due' => '2026-11-01', 'lat' => 8.48446, 'armory' => true, 'phone' => ''],
        ));
        $this->assertSame(['due' => ['from' => '2026-11-01 00:00:00', 'to' => '2026-11-02']],
            \App\Services\AuditLogger::diff(['due' => '2026-11-01 00:00:00'], ['due' => '2026-11-02']));
    }

    public function test_a_signature_does_not_depend_on_how_ids_were_typed(): void
    {
        $row = ['user_id' => 5, 'equipment_id' => null, 'action' => 'x', 'description' => 'd', 'role' => 'Administrator',
            'ip_address' => '127.0.0.1', 'user_agent' => 'ua', 'metadata' => ['b' => 1, 'a' => ['z' => 2, 'y' => 1]], 'created_at' => '2026-10-15 10:00:00'];
        $asRead = ['user_id' => '5', 'metadata' => ['a' => ['y' => 1, 'z' => 2], 'b' => 1]] + $row;

        $this->assertSame(AuditChain::sign('prev', $row), AuditChain::sign('prev', $asRead));
        $this->assertNotSame(AuditChain::sign('prev', $row), AuditChain::sign('other', $row));
    }

    private function withPassword(User $user, string $password = 'Correct-Horse-Battery-9'): string
    {
        $user->forceFill(['password' => Hash::make($password)])->save();
        return $password;
    }

    public function test_deleting_a_user_needs_the_correct_password(): void
    {
        $officer = $this->actAs('cmd.officer');
        $password = $this->withPassword($officer);
        $target = User::where('username', 'cpl.santos')->firstOrFail();

        $this->deleteJson("/api/v1/users/{$target->user_id}")->assertStatus(422)->assertJsonValidationErrors('password');
        $this->deleteJson("/api/v1/users/{$target->user_id}", ['password' => 'wrong-password'])
            ->assertStatus(422)->assertJsonValidationErrors('password');
        $this->assertNotSoftDeleted('users', ['user_id' => $target->user_id]);
        $this->assertDatabaseHas('audit_logs', ['action' => 'password_confirm_failed', 'user_id' => $officer->user_id]);

        $this->deleteJson("/api/v1/users/{$target->user_id}", ['password' => $password])->assertOk();
        $this->assertSoftDeleted('users', ['user_id' => $target->user_id]);

        $log = AuditLog::where('action', 'user_delete')->latest('log_id')->first();
        $this->assertSame('Command Officer', $log->role);
        $this->assertSame('cpl.santos', $log->metadata['deleted']['username']);
    }

    public function test_deleting_a_firearm_or_geofence_needs_the_password(): void
    {
        $officer = $this->actAs('cmd.officer');
        $password = $this->withPassword($officer);
        $firearm = $this->availableFirearm();
        $zone = GpsLocation::firstOrFail();

        $this->deleteJson("/api/v1/firearms/{$firearm->equipment_id}", ['password' => 'nope'])->assertStatus(422);
        $this->deleteJson("/api/v1/locations/{$zone->location_id}", ['password' => 'nope'])->assertStatus(422);
        $this->assertNotSoftDeleted('firearm_equipment', ['equipment_id' => $firearm->equipment_id]);
        $this->assertDatabaseHas('gps_locations', ['location_id' => $zone->location_id]);

        $this->deleteJson("/api/v1/firearms/{$firearm->equipment_id}", ['password' => $password])->assertOk();
        $deleted = AuditLog::where('action', 'firearm_delete')->latest('log_id')->first();
        $this->assertSame($firearm->serial_number, $deleted->metadata['deleted']['serial_number']);
    }

    public function test_edits_are_logged_with_before_and_after_values(): void
    {
        $this->actAs('cmd.officer');
        $firearm = $this->availableFirearm();
        $oldModel = $firearm->model;

        $this->patchJson("/api/v1/firearms/{$firearm->equipment_id}", ['model' => 'Renamed Model', 'remarks' => $firearm->remarks])->assertOk();

        $changes = AuditLog::where('action', 'firearm_update')->latest('log_id')->first()->metadata['changes'];
        $this->assertSame(['from' => $oldModel, 'to' => 'Renamed Model'], $changes['model']);
        $this->assertArrayNotHasKey('remarks', $changes, 'Unchanged fields are not reported as changes.');

        $target = User::where('username', 'cpl.santos')->firstOrFail();
        $this->patchJson("/api/v1/users/{$target->user_id}", ['password' => 'A-new-password-123'])->assertOk();
        $userChanges = AuditLog::where('action', 'user_update')->latest('log_id')->first()->metadata['changes'];
        $this->assertArrayHasKey('password', $userChanges);
        $this->assertStringNotContainsString('A-new-password-123', json_encode($userChanges));
    }

    public function test_audit_trail_is_signed_and_verifies_intact(): void
    {
        $this->actAs('cmd.officer');
        $this->patchJson('/api/v1/firearms/' . $this->availableFirearm()->equipment_id, ['remarks' => 'checked'])->assertOk();

        $log = AuditLog::latest('log_id')->first();
        $this->assertNotNull($log->hash);
        $this->assertSame(AuditLog::where('log_id', '<', $log->log_id)->orderByDesc('log_id')->value('hash'), $log->prev_hash);

        $this->getJson('/api/v1/audit-logs/verify')->assertOk()->assertJsonPath('intact', true);
    }

    public function test_the_database_refuses_to_change_or_delete_audit_entries(): void
    {
        $this->actAs('cmd.officer');
        $this->patchJson('/api/v1/firearms/' . $this->availableFirearm()->equipment_id, ['remarks' => 'x'])->assertOk();
        $id = AuditLog::max('log_id');

        try {
            DB::table('audit_logs')->where('log_id', $id)->update(['description' => 'covered up']);
            $this->fail('UPDATE on audit_logs should be refused.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('append-only', $e->getMessage());
        }

        try {
            DB::table('audit_logs')->where('log_id', $id)->delete();
            $this->fail('DELETE on audit_logs should be refused.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('append-only', $e->getMessage());
        }
    }

    public function test_verification_catches_an_edited_or_deleted_entry(): void
    {
        $this->actAs('cmd.officer');
        foreach (['a', 'b', 'c'] as $remark) {
            $this->patchJson('/api/v1/firearms/' . $this->availableFirearm()->equipment_id, ['remarks' => $remark])->assertOk();
        }
        $ids = AuditLog::orderByDesc('log_id')->limit(3)->pluck('log_id')->all(); // newest first

        // As if someone with database access had removed the protection and tampered:
        // one entry reworded, the next one deleted.
        $rows = DB::table('audit_logs')->orderBy('log_id')->get()
            ->reject(fn($r) => (int) $r->log_id === $ids[1])
            ->map(function ($r) use ($ids) {
                if ((int) $r->log_id === $ids[2]) {
                    $r->description = 'nothing happened';
                }
                return $r;
            });

        $result = AuditChain::verifyRows($rows);
        $this->assertFalse($result['intact']);
        $problems = collect($result['issues'])->groupBy('log_id');
        $this->assertStringContainsString('altered', $problems[$ids[2]][0]['problem']);
        $this->assertStringContainsString('missing', $problems[$ids[0]][0]['problem']);
    }

    public function test_each_signed_in_user_gets_their_own_rate_limit_bucket(): void
    {
        // The limiter runs before auth:sanctum. Drive it directly with bearer-token requests, as
        // in production: the HTTP test client resolves the user early and would hide the bug.
        $this->freezeTime();
        config(['armory.rate_limit_per_second' => 3]);
        $first  = User::where('username', 'admin')->firstOrFail()->createToken('t1')->plainTextToken;
        $second = User::where('username', 'cmd.officer')->firstOrFail()->createToken('t2')->plainTextToken;
        $limiter = app(\App\Http\Middleware\StrictRateLimit::class);
        $call = function (string $token) use ($limiter) {
            $request = \Illuminate\Http\Request::create('/api/v1/auth/me', 'GET', server: [
                'HTTP_AUTHORIZATION' => "Bearer {$token}",
                'REMOTE_ADDR'        => '192.168.1.50',
            ]);
            $this->app->instance('request', $request);
            $this->app['auth']->forgetGuards();
            return $limiter->handle($request, fn() => response()->json(['ok' => true]))->getStatusCode();
        };

        for ($i = 0; $i < 3; $i++) {
            $this->assertSame(200, $call($first));
        }
        // Another user on the same machine is not slowed down by the first one...
        $this->assertSame(200, $call($second), "second user was throttled by the first user's requests");
        // ...while the first one is held to their own limit.
        $this->assertSame(429, $call($first));
    }

    public function test_tracker_status_polling_does_not_use_up_the_normal_request_budget(): void
    {
        $this->freezeTime();
        config(['armory.rate_limit_per_second' => 2]);
        $token = User::where('username', 'cmd.officer')->firstOrFail()->createToken('t')->plainTextToken;
        $limiter = app(\App\Http\Middleware\StrictRateLimit::class);
        $call = function (int $budget) use ($limiter, $token) {
            $request = \Illuminate\Http\Request::create('/api/v1/x', 'GET', server: ['HTTP_AUTHORIZATION' => "Bearer {$token}"]);
            $this->app->instance('request', $request);
            $this->app['auth']->forgetGuards();
            return $limiter->handle($request, fn() => response()->json([]), $budget)->getStatusCode();
        };

        // Five polls on the 30/s budget...
        for ($i = 0; $i < 5; $i++) {
            $this->assertSame(200, $call(30));
        }
        // ...leave the default budget (2/s) untouched.
        $this->assertSame(200, $call(0));
        $this->assertSame(200, $call(0));
        $this->assertSame(429, $call(0));
    }
}
