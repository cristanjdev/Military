<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\LogisticsRequest;
use App\Models\MaintenanceRecord;
use App\Models\Notification;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Client roles (2026-10-15): the Custodian alone releases and receives firearms; the S4 Officer
 * requests firearms and repair budgets; only the Command Officer approves.
 */
class RoleResponsibilityTest extends TestCase
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

    private function issuePayload(): array
    {
        return [
            'equipment_id'       => FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->value('equipment_id'),
            'user_id'            => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => 1,
            'condition_on_issue' => 2,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ];
    }

    public function test_only_the_custodian_releases_firearms(): void
    {
        foreach (['s4.officer', 'cmd.officer', 'pvt.dela.cruz'] as $username) {
            $this->actAs($username);
            $this->postJson('/api/v1/transactions/issue', $this->issuePayload())->assertForbidden();
        }

        $this->actAs('armory.custodian');
        $this->postJson('/api/v1/transactions/issue', $this->issuePayload())->assertCreated();
    }

    public function test_custodian_gets_the_personnel_list_for_issuance(): void
    {
        $this->actAs('armory.custodian');
        $names = collect($this->getJson('/api/v1/transactions/personnel')->assertOk()->json('data'))->pluck('user_id');

        $this->assertContains(User::where('username', 'pvt.dela.cruz')->value('user_id'), $names);
        $this->assertNotContains(User::where('username', 'admin')->value('user_id'), $names);
        $this->assertArrayNotHasKey('email', $this->getJson('/api/v1/transactions/personnel')->json('data.0'));
    }

    public function test_s4_request_goes_to_the_command_officer_for_approval(): void
    {
        $s4 = $this->actAs('s4.officer');
        $id = $this->postJson('/api/v1/requests', [
            'type'           => 'new_firearm',
            'title'          => '5 x M4 Carbine for reserve training',
            'quantity'       => 5,
            'estimated_cost' => 325000,
        ])->assertCreated()->json('request_id');

        $officer = User::where('username', 'cmd.officer')->firstOrFail();
        $this->assertDatabaseHas('notifications', ['user_id' => $officer->user_id, 'type' => 'request_submitted']);

        // The S4 Officer and the Administrator cannot approve; the Command Officer can.
        $this->patchJson("/api/v1/requests/{$id}/decide", ['decision' => 'approved'])->assertForbidden();
        $this->actAs('admin');
        $this->patchJson("/api/v1/requests/{$id}/decide", ['decision' => 'approved'])->assertForbidden();

        $this->actAs('cmd.officer');
        $this->patchJson("/api/v1/requests/{$id}/decide", ['decision' => 'approved', 'note' => 'Go ahead.'])
            ->assertOk()->assertJsonPath('status', 'approved');
        $this->patchJson("/api/v1/requests/{$id}/decide", ['decision' => 'rejected'])->assertStatus(422);

        $this->assertDatabaseHas('notifications', ['user_id' => $s4->user_id, 'type' => 'request_approved']);
        $this->assertDatabaseHas('audit_logs', ['action' => 'request_approved', 'user_id' => $officer->user_id]);
    }

    public function test_repair_budget_lists_firearms_needing_repair_with_their_cost(): void
    {
        $this->actAs('armory.custodian');
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->firstOrFail();
        $this->postJson('/api/v1/maintenance', [
            'equipment_id'     => $firearm->equipment_id,
            'maintenance_type' => 'Inspection',
            'result_status'    => MaintenanceRecord::RESULT_NEEDS_REPAIR,
            'maintenance_date' => now()->toDateString(),
            'description'      => 'Cracked buffer tube.',
            'cost'             => 2500,
        ])->assertCreated();

        $this->actAs('s4.officer');
        $summary = $this->getJson('/api/v1/requests/repair-summary')->assertOk();
        $item = collect($summary->json('items'))->firstWhere('equipment_id', $firearm->equipment_id);
        $this->assertSame(2500, $item['cost']);
        $this->assertSame('Needs Further Repair', $item['result']);
        $this->assertGreaterThanOrEqual(2500, $summary->json('total_cost'));

        $this->postJson('/api/v1/requests', [
            'type'           => 'repair_budget',
            'title'          => 'Repair budget',
            'estimated_cost' => 2500,
            'items'          => [['equipment_id' => $firearm->equipment_id, 'cost' => 2500]],
        ])->assertCreated()->assertJsonPath('items.0.serial_number', $firearm->serial_number);
    }

    public function test_a_repair_budget_asks_for_the_sum_of_its_firearms(): void
    {
        $this->actAs('s4.officer');
        [$a, $b] = FirearmEquipment::limit(2)->pluck('equipment_id')->all();

        $this->postJson('/api/v1/requests', [
            'type' => 'repair_budget', 'title' => 'Repairs', 'estimated_cost' => 1,
            'items' => [['equipment_id' => $a, 'cost' => 1200], ['equipment_id' => $b, 'cost' => 800]],
        ])->assertCreated()->assertJsonPath('estimated_cost', 2000);

        $this->postJson('/api/v1/requests', [
            'type' => 'repair_budget', 'title' => 'Twice', 'estimated_cost' => 0,
            'items' => [['equipment_id' => $a, 'cost' => 1], ['equipment_id' => $a, 'cost' => 2]],
        ])->assertStatus(422);
    }

    public function test_a_new_firearm_request_needs_a_quantity(): void
    {
        $this->actAs('s4.officer');
        $this->postJson('/api/v1/requests', ['type' => 'new_firearm', 'title' => 'Rifles', 'estimated_cost' => 1000])
            ->assertStatus(422)->assertJsonValidationErrors('quantity');
    }

    public function test_an_s4_officer_sees_only_their_own_requests(): void
    {
        $other = User::where('username', 'admin')->firstOrFail();
        LogisticsRequest::create([
            'type' => 'new_firearm', 'title' => 'Someone else', 'quantity' => 1, 'estimated_cost' => 1,
            'status' => 'pending', 'requested_by' => $other->user_id,
        ]);

        $this->actAs('s4.officer');
        $this->assertSame(0, $this->getJson('/api/v1/requests')->assertOk()->json('total'));

        $this->actAs('cmd.officer');
        $this->assertSame(1, $this->getJson('/api/v1/requests')->assertOk()->json('total'));
    }

    public function test_personnel_cannot_see_requests(): void
    {
        $this->actAs('pvt.dela.cruz');
        $this->getJson('/api/v1/requests')->assertForbidden();
    }
}
