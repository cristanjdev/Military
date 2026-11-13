<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\GpsLocation;
use App\Models\Notification;
use App\Models\Transaction;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** Client revision: camp -> assigned destination (90-minute hold) -> camp, and tracker battery alerts. */
class TripMonitoringTest extends TestCase
{
    use RefreshDatabase;

    private const SECRET = 'test-iot-hmac-secret';

    private const CAMP = [8.485, 124.658];        // Camp Evangelista Perimeter
    private const RANGE = [8.452, 124.633];       // Northern Mindanao Training Range (destination)
    private const AWAY = [8.50, 124.70];          // on the road, outside every zone
    private const OTHER = [8.55, 124.75];         // a zone that is neither camp nor destination

    private CarbonImmutable $clock;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
        config([
            'armory.iot.hmac_secret' => self::SECRET,
            'armory.gps.max_age_seconds' => 300,
            'armory.gps.future_tolerance_seconds' => 30,
        ]);
        GpsLocation::create([
            'location_name' => 'Barangay Outpost', 'security_level' => GpsLocation::SECURITY_STANDARD,
            'center_latitude' => self::OTHER[0], 'center_longitude' => self::OTHER[1], 'radius_meters' => 500,
        ]);
        $this->clock = CarbonImmutable::now()->subSeconds(200);
    }

    public function test_issuing_requires_a_destination_outside_the_camp(): void
    {
        $this->actAs('armory.custodian');
        $payload = [
            'equipment_id'       => FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->value('equipment_id'),
            'user_id'            => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'expected_return_at' => now()->addHours(8)->toIso8601String(),
            'purpose'            => 1,
            'condition_on_issue' => 2,
        ];

        $this->postJson('/api/v1/transactions/issue', $payload)
            ->assertStatus(422)->assertJsonValidationErrors('destination_location_id');

        $camp = GpsLocation::where('location_name', 'Camp Evangelista Perimeter')->value('location_id');
        $this->postJson('/api/v1/transactions/issue', $payload + ['destination_location_id' => $camp])
            ->assertStatus(422)->assertJsonValidationErrors('destination_location_id');

        $range = $this->zone('Northern Mindanao Training Range')->location_id;
        $this->postJson('/api/v1/transactions/issue', $payload + ['destination_location_id' => $range])
            ->assertCreated()
            ->assertJsonPath('destination.location_name', 'Northern Mindanao Training Range')
            ->assertJsonPath('trip_stage', Transaction::TRIP_AT_CAMP);
    }

    public function test_a_newly_created_zone_can_be_chosen_as_a_destination(): void
    {
        $this->actAs('admin');
        $zone = $this->postJson('/api/v1/locations', [
            'location_name'    => 'Lumbia Firing Range',
            'center_latitude'  => 8.40,
            'center_longitude' => 124.60,
            'radius_meters'    => 300,
            'is_armory'        => false,
            'is_camp'          => false,
            'security_level'   => 1,
        ])->assertCreated()->json();

        // The issuance form lists every zone that is neither camp nor armory.
        $listed = collect($this->getJson('/api/v1/locations')->assertOk()->json())
            ->firstWhere('location_id', $zone['location_id']);
        $this->assertFalse($listed['is_camp']);
        $this->assertFalse($listed['is_armory']);

        $this->actAs('armory.custodian');
        $this->postJson('/api/v1/transactions/issue', [
            'equipment_id'            => FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->value('equipment_id'),
            'user_id'                 => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'expected_return_at'      => now()->addHours(8)->toIso8601String(),
            'purpose'                 => 1,
            'condition_on_issue'      => 2,
            'destination_location_id' => $zone['location_id'],
        ])->assertCreated()->assertJsonPath('destination.location_name', 'Lumbia Firing Range');
    }

    public function test_a_normal_trip_sends_normal_notifications_only(): void
    {
        [$firearm, $tx] = $this->trip();

        $this->report($firearm, $tx, self::CAMP, 2);
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->assertSame(Transaction::TRIP_OUTBOUND, $tx->fresh()->trip_stage);

        $this->report($firearm, $tx, self::RANGE, 2);
        $this->assertSame(Transaction::TRIP_ON_SITE, $tx->fresh()->trip_stage);
        $this->assertNotNull($tx->fresh()->destination_arrived_at);

        $this->travel(91)->minutes();
        $this->clock = CarbonImmutable::now()->subSeconds(200);
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::CAMP, 2);

        $this->assertSame(Transaction::TRIP_BACK_AT_CAMP, $tx->fresh()->trip_stage);
        $this->assertSame(
            ['trip_left_camp', 'trip_arrived', 'trip_left_destination', 'trip_returned'],
            $this->issuerTypes($tx),
        );
        $this->assertSame(0, Notification::where('equipment_id', $firearm->equipment_id)
            ->where('severity', Notification::SEVERITY_CRITICAL)->count());
        $this->assertSame(0, Notification::where('equipment_id', $firearm->equipment_id)
            ->where('type', 'geofence_violation')->count());
    }

    public function test_leaving_the_destination_before_90_minutes_is_a_security_alert(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::RANGE, 2);

        $this->travel(30)->minutes();
        $this->clock = CarbonImmutable::now()->subSeconds(200);
        $this->report($firearm, $tx, self::AWAY, 2);

        $alert = Notification::where('type', 'premature_departure')->where('user_id', $tx->authorized_by)->sole();
        $this->assertSame(Notification::SEVERITY_CRITICAL, $alert->severity);
        $this->assertStringContainsString('must stay 90 min', $alert->message);
        // Everyone who oversees the armory gets it, not only the issuer.
        $this->assertGreaterThan(1, Notification::where('type', 'premature_departure')->count());
    }

    public function test_going_back_to_the_destination_after_the_hold_is_off_route(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::RANGE, 2);

        $this->travel(91)->minutes();
        $this->clock = CarbonImmutable::now()->subSeconds(200);
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::RANGE, 2);

        $this->assertSame(Transaction::TRIP_RETURNING, $tx->fresh()->trip_stage);
        $this->assertSame(1, Notification::where('type', 'off_route')->where('user_id', $tx->authorized_by)->count());

        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::CAMP, 2);
        $this->assertSame(Transaction::TRIP_BACK_AT_CAMP, $tx->fresh()->trip_stage);
    }

    public function test_coming_back_before_the_hold_ends_continues_the_same_stay(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::RANGE, 2);
        $arrived = $tx->fresh()->destination_arrived_at;

        $this->travel(30)->minutes();
        $this->clock = CarbonImmutable::now()->subSeconds(200);
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::RANGE, 2);

        $this->assertSame(Transaction::TRIP_ON_SITE, $tx->fresh()->trip_stage);
        $this->assertTrue($arrived->equalTo($tx->fresh()->destination_arrived_at));
        $this->assertSame(0, Notification::where('type', 'off_route')->count());
    }

    public function test_leaving_the_camp_again_after_returning_is_a_security_alert(): void
    {
        [$firearm, $tx] = $this->trip();
        $tx->update(['trip_stage' => Transaction::TRIP_BACK_AT_CAMP]);

        $this->report($firearm, $tx, self::CAMP, 2);
        $this->report($firearm, $tx, self::AWAY, 3);

        $this->assertSame(['camp_exit_after_return'], $this->issuerTypes($tx));
        $this->assertSame(Transaction::TRIP_BACK_AT_CAMP, $tx->fresh()->trip_stage);
    }

    public function test_entering_a_zone_that_is_not_the_destination_is_an_alert(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::AWAY, 2);
        $this->report($firearm, $tx, self::OTHER, 3);

        $this->assertSame(['trip_left_camp', 'off_route'], $this->issuerTypes($tx));
        $this->assertStringContainsString('Barangay Outpost',
            Notification::where('type', 'off_route')->where('user_id', $tx->authorized_by)->value('message'));
    }

    public function test_one_stray_reading_does_not_count_as_a_move(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::CAMP, 2);
        $this->report($firearm, $tx, self::AWAY, 1);
        $this->report($firearm, $tx, self::CAMP, 2);

        $this->assertSame([], $this->issuerTypes($tx));
        $this->assertSame(Transaction::TRIP_AT_CAMP, $tx->fresh()->trip_stage);
    }

    public function test_custodian_and_above_can_change_the_destination_before_arrival(): void
    {
        [$firearm, $tx] = $this->trip();
        $outpost = $this->zone('Barangay Outpost')->location_id;

        $this->actAs('s4.officer');
        $this->patchJson("/api/v1/transactions/{$tx->transaction_id}/destination", ['destination_location_id' => $outpost])
            ->assertForbidden();

        // The Command Officer only views since the defense feedback (2026-11).
        $this->actAs('cmd.officer');
        $this->patchJson("/api/v1/transactions/{$tx->transaction_id}/destination", ['destination_location_id' => $outpost])
            ->assertForbidden();

        $this->actAs('armory.custodian');
        $this->patchJson("/api/v1/transactions/{$tx->transaction_id}/destination", ['destination_location_id' => $outpost])
            ->assertOk()->assertJsonPath('destination.location_name', 'Barangay Outpost');

        $tx->update(['trip_stage' => Transaction::TRIP_ON_SITE]);
        $this->patchJson("/api/v1/transactions/{$tx->transaction_id}/destination", [
            'destination_location_id' => $this->zone('Northern Mindanao Training Range')->location_id,
        ])->assertStatus(409);
    }

    public function test_a_zone_an_active_trip_is_heading_to_cannot_be_deleted(): void
    {
        $this->trip();
        $this->actAs('admin');
        $this->deleteJson('/api/v1/locations/' . $this->zone('Northern Mindanao Training Range')->location_id)
            ->assertStatus(409);
    }

    public function test_low_and_critical_battery_alert_once_per_discharge(): void
    {
        [$firearm, $tx] = $this->trip();

        foreach ([25, 19, 18, 19, 9, 8] as $pct) {
            $this->report($firearm, $tx, self::CAMP, 1, $pct);
        }
        $this->assertSame(['battery_low', 'battery_critical'], $this->issuerTypes($tx));

        // Recharged, then drained again: the alerts come back.
        foreach ([90, 15] as $pct) {
            $this->report($firearm, $tx, self::CAMP, 1, $pct);
        }
        $this->assertSame(['battery_low', 'battery_critical', 'battery_low'], $this->issuerTypes($tx));
    }

    public function test_a_tracker_without_a_fix_reports_its_battery_through_status(): void
    {
        [$firearm, $tx] = $this->trip();
        $body = json_encode([
            'device_id' => 'TEST-GPS-DEVICE-01', 'equipment_id' => $firearm->equipment_id,
            'line' => '[gps] no fix yet', 'battery_pct' => 8,
        ], JSON_THROW_ON_ERROR);

        $this->call('POST', '/api/v1/gps/status', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_X_ARMORY_SIGNATURE' => hash_hmac('sha256', $body, self::SECRET),
        ], $body)->assertOk();

        $this->assertSame(['battery_critical'], $this->issuerTypes($tx));

        // The GPS page shows that reading although the tracker never sent a position.
        $this->actAs('admin');
        $item = collect($this->getJson('/api/v1/gps/live')->assertOk()->json('items'))
            ->firstWhere('equipment_id', $firearm->equipment_id);
        $this->assertSame(8, $item['battery_pct']);
        $this->assertNotNull($item['battery_reported_at']);
    }

    public function test_a_tracker_measuring_no_cell_reports_no_battery_instead_of_zero(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::CAMP, 1, 64);

        // On USB power with the battery switched off the divider reads about 0 V. Older firmware
        // turned that into 0%; either way it must not raise "Battery Critical".
        foreach ([['battery_mv' => 40], ['battery_mv' => 40, 'battery_pct' => 0]] as $battery) {
            $body = json_encode([
                'device_id' => 'TEST-GPS-DEVICE-01', 'equipment_id' => $firearm->equipment_id,
                'line' => '[gps] no fix yet',
            ] + $battery, JSON_THROW_ON_ERROR);
            $this->call('POST', '/api/v1/gps/status', [], [], [], [
                'CONTENT_TYPE' => 'application/json',
                'HTTP_ACCEPT' => 'application/json',
                'HTTP_X_ARMORY_SIGNATURE' => hash_hmac('sha256', $body, self::SECRET),
            ], $body)->assertOk();
        }
        $this->assertSame([], $this->issuerTypes($tx));

        // The GPS page shows "no battery" in place of the earlier 64%, not a stale or false level.
        $this->actAs('admin');
        $item = collect($this->getJson('/api/v1/gps/live')->assertOk()->json('items'))
            ->firstWhere('equipment_id', $firearm->equipment_id);
        $this->assertNull($item['battery_pct']);
        $this->assertTrue($item['battery_absent']);
        $this->assertSame(40, $item['battery_mv']);
        $this->assertNotNull($item['battery_reported_at']);
    }

    public function test_a_real_cell_near_empty_still_alerts(): void
    {
        [$firearm, $tx] = $this->trip();
        $body = json_encode([
            'device_id' => 'TEST-GPS-DEVICE-01', 'equipment_id' => $firearm->equipment_id,
            'line' => '[gps] no fix yet', 'battery_pct' => 3, 'battery_mv' => 3420,
        ], JSON_THROW_ON_ERROR);
        $this->call('POST', '/api/v1/gps/status', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_X_ARMORY_SIGNATURE' => hash_hmac('sha256', $body, self::SECRET),
        ], $body)->assertOk();

        $this->assertSame(['battery_critical'], $this->issuerTypes($tx));
        $this->actAs('admin');
        $item = collect($this->getJson('/api/v1/gps/live')->assertOk()->json('items'))
            ->firstWhere('equipment_id', $firearm->equipment_id);
        $this->assertSame(3, $item['battery_pct']);
        $this->assertFalse($item['battery_absent']);
        $this->assertSame(3420, $item['battery_mv']);
    }

    public function test_the_setup_tool_lists_trackable_firearms_with_a_signed_request(): void
    {
        [$firearm, $tx] = $this->trip();
        $ts = (string) time();
        $signed = fn (string $ts, string $secret = self::SECRET) => [
            'X-Armory-Timestamp' => $ts,
            'X-Armory-Signature' => hash_hmac('sha256', 'trackable:' . $ts, $secret),
            'Accept'             => 'application/json',
        ];

        $items = $this->getJson('/api/v1/gps/trackable', $signed($ts))->assertOk()->json('items');
        $this->assertContains([
            'equipment_id'  => $firearm->equipment_id,
            'serial_number' => $firearm->serial_number,
            'model'         => $firearm->model,
            'status'        => Transaction::STATUS_ACTIVE,
        ], $items);

        // A different secret, or a signature older than 5 minutes, gets nothing.
        $this->getJson('/api/v1/gps/trackable', $signed($ts, 'wrong-secret'))->assertStatus(401);
        $this->getJson('/api/v1/gps/trackable', $signed((string) (time() - 600)))->assertStatus(401);
    }

    public function test_the_gps_page_shows_the_latest_battery_reading_from_positions(): void
    {
        [$firearm, $tx] = $this->trip();
        $this->report($firearm, $tx, self::CAMP, 1, 64);

        $this->actAs('admin');
        $item = collect($this->getJson('/api/v1/gps/live')->assertOk()->json('items'))
            ->firstWhere('equipment_id', $firearm->equipment_id);
        $this->assertSame(64, $item['battery_pct']);
        $this->assertNotNull($item['battery_reported_at']);
    }

    /** An issued firearm heading for the training range, still at the camp. */
    private function trip(): array
    {
        $firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->firstOrFail();
        $tx = Transaction::create([
            'equipment_id'            => $firearm->equipment_id,
            'user_id'                 => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'authorized_by'           => User::where('username', 'armory.custodian')->value('user_id'),
            'checkout_at'             => now()->subMinutes(5),
            'expected_return_at'      => now()->addHours(8),
            'purpose'                 => Transaction::PURPOSE_OPERATION,
            'status'                  => Transaction::STATUS_ACTIVE,
            'condition_on_issue'      => FirearmEquipment::CONDITION_GOOD,
            'gps_tracking_enabled'    => true,
            'destination_location_id' => $this->zone('Northern Mindanao Training Range')->location_id,
            'trip_stage'              => Transaction::TRIP_AT_CAMP,
            'trip_place'              => 'camp',
        ]);
        $firearm->update(['availability_status' => FirearmEquipment::STATUS_CHECKED_OUT]);

        return [$firearm->fresh(), $tx->fresh()];
    }

    /** $times signed reports from one spot, a few seconds apart. */
    private function report(FirearmEquipment $firearm, Transaction $tx, array $at, int $times, int $battery = 90): void
    {
        for ($i = 0; $i < $times; $i++) {
            $this->clock = $this->clock->addSeconds(5);
            $this->signedPost([
                'equipment_id'   => $firearm->equipment_id,
                'transaction_id' => $tx->transaction_id,
                'device_id'      => 'TEST-GPS-DEVICE-01',
                'captured_at'    => $this->clock->toIso8601String(),
                'latitude'       => $at[0],
                'longitude'      => $at[1],
                'satellites'     => 8,
                'battery_pct'    => $battery,
            ])->assertOk();
        }
    }

    /** Trip and battery notification types the issuer received, oldest first. */
    private function issuerTypes(Transaction $tx): array
    {
        return Notification::where('user_id', $tx->authorized_by)
            ->whereIn('type', [
                'trip_left_camp', 'trip_arrived', 'trip_left_destination', 'trip_returned',
                'premature_departure', 'off_route', 'camp_exit_after_return', 'battery_low', 'battery_critical',
            ])
            ->orderBy('notification_id')
            ->pluck('type')
            ->all();
    }

    private function zone(string $name): GpsLocation
    {
        return GpsLocation::where('location_name', $name)->firstOrFail();
    }

    private function actAs(string $username): void
    {
        Sanctum::actingAs(User::where('username', $username)->firstOrFail());
    }

    private function signedPost(array $payload): TestResponse
    {
        $body = json_encode($payload, JSON_THROW_ON_ERROR);

        return $this->call('POST', '/api/v1/gps/ingest', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_X_ARMORY_SIGNATURE' => hash_hmac('sha256', $body, self::SECRET),
        ], $body);
    }
}
