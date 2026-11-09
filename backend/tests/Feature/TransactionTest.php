<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\Role;
use App\Models\Transaction;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class TransactionTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
    }

    private function actAsArmorer(): User
    {
        $user = User::where('username', 'armory.custodian')->first();
        Sanctum::actingAs($user, ['Armory Custodian']);
        return $user;
    }

    private function actAsPersonnel(): User
    {
        $user = User::where('username', 'pvt.dela.cruz')->first();
        Sanctum::actingAs($user, ['Personnel']);
        return $user;
    }

    public function test_issue_firearm(): void
    {
        $this->actAsArmorer();
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->first();
        $personnel = User::where('username', 'pvt.dela.cruz')->first();

        $response = $this->postJson('/api/v1/transactions/issue', [
            'equipment_id'       => $firearm->equipment_id,
            'user_id'            => $personnel->user_id,
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => 1,
            'condition_on_issue' => 2,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ]);

        $response->assertStatus(201)
            ->assertJsonFragment(['status' => 'Active']);

        $firearm->refresh();
        $this->assertEquals(FirearmEquipment::STATUS_CHECKED_OUT, $firearm->availability_status);
    }

    public function test_cannot_issue_unavailable_firearm(): void
    {
        $this->actAsArmorer();
        $firearm = FirearmEquipment::first();
        $firearm->update(['availability_status' => FirearmEquipment::STATUS_CHECKED_OUT]);
        $personnel = User::where('username', 'pvt.dela.cruz')->first();

        $response = $this->postJson('/api/v1/transactions/issue', [
            'equipment_id'       => $firearm->equipment_id,
            'user_id'            => $personnel->user_id,
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => 1,
            'condition_on_issue' => 2,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ]);

        $response->assertStatus(409);
    }

    public function test_return_firearm(): void
    {
        $this->actAsArmorer();
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->first();
        $personnel = User::where('username', 'pvt.dela.cruz')->first();

        // Issue first
        $issueResp = $this->postJson('/api/v1/transactions/issue', [
            'equipment_id'       => $firearm->equipment_id,
            'user_id'            => $personnel->user_id,
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => Transaction::PURPOSE_FUNERAL,
            'condition_on_issue' => 1,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ]);
        $txId = $issueResp->json('transaction_id');

        // Return
        $response = $this->patchJson("/api/v1/transactions/{$txId}/return", [
            'condition_on_return' => 2,
            'notes'               => 'Returned in good condition.',
        ]);

        $response->assertOk()
            ->assertJsonFragment(['status' => 'Returned']);

        $firearm->refresh();
        $this->assertEquals(FirearmEquipment::STATUS_AVAILABLE, $firearm->availability_status);
    }

    public function test_personnel_cannot_issue(): void
    {
        $this->actAsPersonnel();
        $firearm = FirearmEquipment::first();
        $personnel = User::where('username', 'cpl.santos')->first();

        $response = $this->postJson('/api/v1/transactions/issue', [
            'equipment_id'       => $firearm->equipment_id,
            'user_id'            => $personnel->user_id,
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => 1,
            'condition_on_issue' => 2,
            'destination_location_id' => \App\Models\GpsLocation::where('location_name', 'Northern Mindanao Training Range')->value('location_id'),
        ]);

        $response->assertStatus(403);
    }

    public function test_sweep_overdue(): void
    {
        $this->actAsArmorer();
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->first();
        $personnel = User::where('username', 'pvt.dela.cruz')->first();

        // Issue with past expected return
        Transaction::create([
            'equipment_id'         => $firearm->equipment_id,
            'user_id'              => $personnel->user_id,
            'authorized_by'        => User::where('username', 'armory.custodian')->first()->user_id,
            'checkout_at'          => now()->subHours(10),
            'expected_return_at'   => now()->subHours(2),
            'purpose'              => 1,
            'status'               => Transaction::STATUS_ACTIVE,
            'condition_on_issue'   => 2,
            'gps_tracking_enabled' => true,
        ]);
        $firearm->update(['availability_status' => FirearmEquipment::STATUS_CHECKED_OUT]);

        $response = $this->postJson('/api/v1/transactions/sweep-overdue');
        $response->assertOk();
        $this->assertGreaterThanOrEqual(1, $response->json('flagged'));
    }

    public function test_list_transactions(): void
    {
        $this->actAsArmorer();
        $response = $this->getJson('/api/v1/transactions');
        $response->assertOk()->assertJsonStructure(['data']);
    }

    public function test_personnel_can_read_only_their_own_transactions(): void
    {
        $personnel = User::where('username', 'pvt.dela.cruz')->firstOrFail();
        $otherPersonnel = User::where('username', 'cpl.santos')->firstOrFail();
        $authorizer = User::where('username', 'armory.custodian')->firstOrFail();
        $firearms = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)
            ->limit(2)
            ->get();

        $own = Transaction::create([
            'equipment_id' => $firearms[0]->equipment_id,
            'user_id' => $personnel->user_id,
            'authorized_by' => $authorizer->user_id,
            'checkout_at' => now(),
            'expected_return_at' => now()->addHours(4),
            'purpose' => Transaction::PURPOSE_TRAINING,
            'status' => Transaction::STATUS_ACTIVE,
            'condition_on_issue' => FirearmEquipment::CONDITION_GOOD,
            'gps_tracking_enabled' => true,
        ]);
        $other = Transaction::create([
            'equipment_id' => $firearms[1]->equipment_id,
            'user_id' => $otherPersonnel->user_id,
            'authorized_by' => $authorizer->user_id,
            'checkout_at' => now(),
            'expected_return_at' => now()->addHours(4),
            'purpose' => Transaction::PURPOSE_TRAINING,
            'status' => Transaction::STATUS_ACTIVE,
            'condition_on_issue' => FirearmEquipment::CONDITION_GOOD,
            'gps_tracking_enabled' => true,
        ]);

        Sanctum::actingAs($personnel, [Role::PERSONNEL]);

        $list = $this->getJson('/api/v1/transactions')->assertOk();
        $ids = collect($list->json('data'))->pluck('transaction_id');
        $this->assertTrue($ids->contains($own->transaction_id));
        $this->assertFalse($ids->contains($other->transaction_id));

        $this->getJson("/api/v1/transactions/{$own->transaction_id}")
            ->assertOk()
            ->assertJsonMissingPath('gps_logs');
        $this->getJson("/api/v1/transactions/{$other->transaction_id}")
            ->assertNotFound();
    }

    /** An issuance to pvt.dela.cruz that is still open. */
    private function openIssuance(): Transaction
    {
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->first();
        $tx = Transaction::create([
            'equipment_id'       => $firearm->equipment_id,
            'user_id'            => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'authorized_by'      => User::where('username', 'armory.custodian')->value('user_id'),
            'checkout_at'        => now(),
            'expected_return_at' => now()->addHours(4),
            'purpose'            => Transaction::PURPOSE_TRAINING,
            'status'             => Transaction::STATUS_ACTIVE,
            'condition_on_issue' => FirearmEquipment::CONDITION_GOOD,
        ]);
        $firearm->update(['availability_status' => FirearmEquipment::STATUS_CHECKED_OUT]);
        return $tx;
    }

    public function test_a_person_holding_a_firearm_cannot_be_deleted(): void
    {
        $tx = $this->openIssuance();
        $admin = User::where('username', 'admin')->first();
        $admin->forceFill(['password' => \Illuminate\Support\Facades\Hash::make('Correct#Pass1')])->save();
        Sanctum::actingAs($admin);

        $message = $this->deleteJson("/api/v1/users/{$tx->user_id}", ['password' => 'Correct#Pass1'])
            ->assertStatus(422)
            ->json('message');
        $this->assertStringContainsString('PVT Juan Dela Cruz still holds', $message);
        $this->assertStringContainsString($tx->firearm->serial_number, $message);
        $this->assertStringContainsString('before deleting the account', $message);
        $this->assertNotSoftDeleted('users', ['user_id' => $tx->user_id]);
    }

    public function test_a_firearm_held_by_a_deleted_account_keeps_its_holder_and_can_be_returned(): void
    {
        $tx = $this->openIssuance();
        User::find($tx->user_id)->delete(); // deleted before the guard above existed

        $this->actAsArmorer();
        $this->getJson("/api/v1/transactions/{$tx->transaction_id}")
            ->assertOk()
            ->assertJsonPath('user.first_name', 'Juan')
            ->assertJsonPath('user.last_name', 'Dela Cruz');
        $this->getJson('/api/v1/transactions?search=Dela Cruz')
            ->assertOk()
            ->assertJsonFragment(['transaction_id' => $tx->transaction_id]);

        $this->patchJson("/api/v1/transactions/{$tx->transaction_id}/return", ['condition_on_return' => 2])
            ->assertOk()
            ->assertJsonPath('status', 'Returned');
    }
}
