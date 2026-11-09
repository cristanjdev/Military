<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\GpsLog;
use App\Models\MaintenanceRecord;
use App\Models\RepairRequest;
use App\Models\Transaction;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Defense feedback (2026-11): Custodian reports → S4 forwards → Command Officer approves → S4 informs
 * the Custodian → Custodian sends it for repair → the status changes only when it comes back.
 */
class RepairWorkflowTest extends TestCase
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

    private function report(FirearmEquipment $firearm): int
    {
        $this->actAs('armory.custodian');
        return $this->postJson('/api/v1/repairs', [
            'equipment_id' => $firearm->equipment_id,
            'problem'      => 'Broken firing pin',
            'damaged_at'   => now()->subDays(3)->toDateString(),
        ])->assertCreated()->assertJsonPath('status', 'reported')->json('repair_id');
    }

    /** Takes a reported repair up to the point where the Custodian may send the firearm. */
    private function approveAndInform(int $id): void
    {
        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/forward", ['estimated_cost' => 1800])->assertOk();
        $this->actAs('cmd.officer');
        $this->patchJson("/api/v1/repairs/{$id}/decide", ['decision' => 'approved'])->assertOk();
        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/inform")->assertOk();
    }

    public function test_the_full_repair_flow_keeps_every_date_and_changes_the_status_only_on_return(): void
    {
        $firearm = $this->availableFirearm();
        $id = $this->report($firearm);
        $s4 = User::where('username', 's4.officer')->first();
        $this->assertDatabaseHas('notifications', ['user_id' => $s4->user_id, 'type' => 'repair_reported']);

        // A firearm reported for repair cannot be issued meanwhile.
        $this->postJson('/api/v1/transactions/issue', [
            'equipment_id' => $firearm->equipment_id,
            'user_id' => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose' => 1, 'condition_on_issue' => 2,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ])->assertStatus(409);

        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/forward", ['estimated_cost' => 1800, 's4_notes' => 'Part available at the depot.'])
            ->assertOk()->assertJsonPath('status', 'forwarded');
        $commander = User::where('username', 'cmd.officer')->first();
        $this->assertDatabaseHas('notifications', ['user_id' => $commander->user_id, 'type' => 'repair_forwarded']);

        $this->actAs('cmd.officer');
        $this->patchJson("/api/v1/repairs/{$id}/decide", ['decision' => 'approved', 'note' => 'Proceed.'])
            ->assertOk()->assertJsonPath('status', 'approved');

        // The Custodian waits for the S4 Officer to report the approval back.
        $this->actAs('armory.custodian');
        $this->patchJson("/api/v1/repairs/{$id}/send", ['received_by' => 'SSG Reyes'])->assertStatus(422);

        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/inform")->assertOk();
        $this->patchJson("/api/v1/repairs/{$id}/inform")->assertStatus(422);

        $this->actAs('armory.custodian');
        $this->patchJson("/api/v1/repairs/{$id}/send", ['received_by' => 'SSG Reyes', 'received_by_unit' => '4th Maintenance Bn'])
            ->assertOk()->assertJsonPath('status', 'in_repair')->assertJsonPath('received_by', 'SSG Reyes');
        $this->assertSame(FirearmEquipment::STATUS_MAINTENANCE, (int) $firearm->fresh()->availability_status);

        $repair = $this->patchJson("/api/v1/repairs/{$id}/complete", [
            'repaired_at'   => now()->toDateString(),
            'result_status' => MaintenanceRecord::RESULT_SERVICEABLE,
            'cost'          => 1750,
            'work_done'     => 'Firing pin replaced, function check passed.',
        ])->assertOk()->assertJsonPath('status', 'completed')->json();

        $this->assertSame(FirearmEquipment::STATUS_AVAILABLE, (int) $firearm->fresh()->availability_status);
        foreach (['damaged_at', 'reported_at', 'forwarded_at', 'decided_at', 'custodian_informed_at', 'sent_at', 'repaired_at', 'returned_at'] as $date) {
            $this->assertNotNull($repair[$date], "{$date} was not recorded");
        }
        $this->assertDatabaseHas('maintenance_records', [
            'maintenance_id' => $repair['maintenance_id'], 'maintenance_type' => 'Repair', 'repaired_by' => 'SSG Reyes', 'cost' => 1750,
        ]);
    }

    public function test_each_step_belongs_to_one_role(): void
    {
        $firearm = $this->availableFirearm();

        foreach (['s4.officer', 'cmd.officer', 'admin'] as $username) {
            $this->actAs($username);
            $this->postJson('/api/v1/repairs', ['equipment_id' => $firearm->equipment_id, 'problem' => 'x', 'damaged_at' => now()->toDateString()])
                ->assertForbidden();
        }

        $id = $this->report($firearm);
        foreach (['armory.custodian', 'cmd.officer'] as $username) {
            $this->actAs($username);
            $this->patchJson("/api/v1/repairs/{$id}/forward")->assertForbidden();
        }

        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/forward")->assertOk();
        foreach (['s4.officer', 'armory.custodian', 'admin'] as $username) {
            $this->actAs($username);
            $this->patchJson("/api/v1/repairs/{$id}/decide", ['decision' => 'approved'])->assertForbidden();
        }

        // Everyone on staff can follow the repair.
        foreach (['cmd.officer', 's4.officer', 'armory.custodian', 'admin'] as $username) {
            $this->actAs($username);
            $this->getJson("/api/v1/repairs?equipment_id={$firearm->equipment_id}")->assertOk()->assertJsonPath('data.0.repair_id', $id);
        }
        $this->actAs('pvt.dela.cruz');
        $this->getJson('/api/v1/repairs')->assertForbidden();
    }

    public function test_a_rejected_repair_leaves_the_firearm_in_the_armory(): void
    {
        $firearm = $this->availableFirearm();
        $id = $this->report($firearm);

        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/forward")->assertOk();
        $this->actAs('cmd.officer');
        $this->patchJson("/api/v1/repairs/{$id}/decide", ['decision' => 'rejected', 'note' => 'Condemn instead.'])
            ->assertOk()->assertJsonPath('status', 'rejected');
        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/repairs/{$id}/inform")->assertOk();

        $custodian = User::where('username', 'armory.custodian')->first();
        $this->assertDatabaseHas('notifications', ['user_id' => $custodian->user_id, 'type' => 'repair_rejected']);

        $this->actAs('armory.custodian');
        $this->patchJson("/api/v1/repairs/{$id}/send", ['received_by' => 'SSG Reyes'])->assertStatus(422);
        $this->assertSame(FirearmEquipment::STATUS_AVAILABLE, (int) $firearm->fresh()->availability_status);

        // A rejected request is closed: the firearm can be reported again.
        $this->report($firearm);
    }

    public function test_an_issued_firearm_or_one_already_reported_cannot_be_reported(): void
    {
        $this->actAs('armory.custodian');
        $issued = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_CHECKED_OUT)->firstOrFail();
        $this->postJson('/api/v1/repairs', ['equipment_id' => $issued->equipment_id, 'problem' => 'x', 'damaged_at' => now()->toDateString()])
            ->assertStatus(409);

        $firearm = $this->availableFirearm();
        $this->report($firearm);
        $this->postJson('/api/v1/repairs', ['equipment_id' => $firearm->equipment_id, 'problem' => 'again', 'damaged_at' => now()->toDateString()])
            ->assertStatus(409);
    }

    public function test_the_repair_date_cannot_be_before_the_damage(): void
    {
        $firearm = $this->availableFirearm();
        $id = $this->report($firearm);
        $this->approveAndInform($id);

        $this->actAs('armory.custodian');
        $this->patchJson("/api/v1/repairs/{$id}/send", ['received_by' => 'SSG Reyes'])->assertOk();
        $this->patchJson("/api/v1/repairs/{$id}/complete", [
            'repaired_at' => now()->subDays(10)->toDateString(), 'result_status' => 1, 'work_done' => 'x',
        ])->assertStatus(422)->assertJsonValidationErrors('repaired_at');
        $this->assertSame(FirearmEquipment::STATUS_MAINTENANCE, (int) $firearm->fresh()->availability_status);
    }

    public function test_a_firearm_out_for_repair_stays_tracked_and_shows_on_the_live_map(): void
    {
        $secret = 'test-secret';
        config(['armory.iot.hmac_secret' => $secret]);
        $firearm = $this->availableFirearm();
        $id = $this->report($firearm);
        $this->approveAndInform($id);
        $this->actAs('armory.custodian');
        $this->patchJson("/api/v1/repairs/{$id}/send", ['received_by' => 'SSG Reyes'])->assertOk();

        $body = json_encode([
            'equipment_id' => $firearm->equipment_id,
            'device_id'    => 'TRK-REPAIR',
            'captured_at'  => now()->toIso8601String(),
            'latitude'     => 8.4,
            'longitude'    => 124.6,
            'battery_pct'  => 77,
        ]);
        $this->call('POST', '/api/v1/gps/ingest', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_X_ARMORY_SIGNATURE' => hash_hmac('sha256', $body, $secret),
        ], $body)->assertOk()->assertJsonPath('repair_id', $id);

        $log = GpsLog::where('device_id', 'TRK-REPAIR')->firstOrFail();
        $this->assertSame($id, (int) $log->repair_id);
        $this->assertNull($log->transaction_id);

        $this->actAs('cmd.officer');
        $item = collect($this->getJson('/api/v1/gps/live')->assertOk()->json('items'))
            ->firstWhere('equipment_id', $firearm->equipment_id);
        $this->assertNotNull($item, 'The firearm out for repair is missing from the live map');
        $this->assertSame('Maintenance', $item['status']);
        $this->assertSame('SSG Reyes', $item['repair']['received_by']);
        $this->assertSame(77, $item['battery_pct']);
        $this->assertFalse($item['needs_attention']);
    }

    public function test_the_firearm_details_show_who_used_and_who_maintained_it(): void
    {
        $firearm = $this->availableFirearm();
        $id = $this->report($firearm);

        $this->actAs('cmd.officer');
        $details = $this->getJson("/api/v1/firearms/{$firearm->equipment_id}")->assertOk();
        $details->assertJsonPath('repairs.0.repair_id', $id)
            ->assertJsonPath('repairs.0.reporter.username', 'armory.custodian');
        $this->assertIsArray($details->json('maintenance_records'));
        $this->assertIsArray($details->json('transactions'));
    }

    public function test_the_command_officer_only_views(): void
    {
        $this->actAs('cmd.officer');
        $personnel = User::where('username', 'pvt.dela.cruz')->first();
        $tx = Transaction::whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])->firstOrFail();

        $this->getJson('/api/v1/users')->assertOk();
        $this->getJson('/api/v1/firearms')->assertOk();
        $this->getJson('/api/v1/maintenance')->assertOk();
        $this->getJson('/api/v1/repairs')->assertOk();
        $this->getJson('/api/v1/gps/live')->assertOk();

        $this->postJson('/api/v1/users', [])->assertForbidden();
        $this->patchJson("/api/v1/users/{$personnel->user_id}", ['phone' => '09170000000'])->assertForbidden();
        $this->deleteJson("/api/v1/users/{$personnel->user_id}")->assertForbidden();
        $this->postJson('/api/v1/firearms', [])->assertForbidden();
        $this->postJson('/api/v1/locations', [])->assertForbidden();
        $this->postJson('/api/v1/maintenance', [])->assertForbidden();
        $this->patchJson("/api/v1/transactions/{$tx->transaction_id}/destination", [])->assertForbidden();
        $this->postJson('/api/v1/transactions/issue', [])->assertForbidden();
    }

    public function test_routine_maintenance_is_the_custodians_and_repairs_need_approval(): void
    {
        $firearm = $this->availableFirearm();
        $record = [
            'equipment_id' => $firearm->equipment_id, 'maintenance_type' => 'Cleaning',
            'result_status' => 1, 'maintenance_date' => now()->toDateString(), 'description' => 'Routine cleaning.',
        ];

        foreach (['admin', 's4.officer', 'cmd.officer'] as $username) {
            $this->actAs($username);
            $this->postJson('/api/v1/maintenance', $record)->assertForbidden();
        }

        $this->actAs('armory.custodian');
        $this->postJson('/api/v1/maintenance', $record)->assertCreated();
        // A repair goes through the approval, not this form.
        $this->postJson('/api/v1/maintenance', ['maintenance_type' => 'Repair'] + $record)
            ->assertStatus(422)->assertJsonValidationErrors('maintenance_type');
    }
}
