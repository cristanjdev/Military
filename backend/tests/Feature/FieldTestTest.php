<?php

namespace Tests\Feature;

use App\Models\FirearmEquipment;
use App\Models\GpsLog;
use App\Models\Transaction;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class FieldTestTest extends TestCase
{
    use RefreshDatabase;

    private const REF_LAT = 10.3;
    private const REF_LNG = 123.9;

    private CarbonImmutable $t0;
    private FirearmEquipment $firearm;
    private Transaction $tx;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
        config(['armory.gps.interval_seconds' => 30]);

        $this->t0 = CarbonImmutable::parse('2026-11-20 08:00:00');
        $this->at(0);

        $this->firearm = FirearmEquipment::where('availability_status', FirearmEquipment::STATUS_AVAILABLE)->firstOrFail();
        $this->tx = Transaction::create([
            'equipment_id'         => $this->firearm->equipment_id,
            'user_id'              => User::where('username', 'pvt.dela.cruz')->value('user_id'),
            'authorized_by'        => User::where('username', 'armory.custodian')->value('user_id'),
            'checkout_at'          => now()->subHour(),
            'expected_return_at'   => now()->addHours(4),
            'purpose'              => Transaction::PURPOSE_TRAINING,
            'status'               => Transaction::STATUS_ACTIVE,
            'condition_on_issue'   => FirearmEquipment::CONDITION_GOOD,
            'gps_tracking_enabled' => true,
        ]);
        $this->firearm->update(['availability_status' => FirearmEquipment::STATUS_CHECKED_OUT]);

        Sanctum::actingAs(User::where('username', 'armory.custodian')->first(), ['Armory Custodian']);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_a_full_field_test_gives_the_measured_numbers(): void
    {
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])
            ->assertCreated()->json('test.field_test_id');

        $this->patchJson("/api/v1/field-tests/{$id}/reference", ['latitude' => self::REF_LAT, 'longitude' => self::REF_LNG])->assertOk();

        // One position every 30 s. 210 s is missing (a missed update); the range walk and the
        // hotspot-off period get their own positions below.
        foreach (range(30, 1080, 30) as $s) {
            if ($s === 210 || ($s > 320 && $s < 500) || ($s > 800 && $s < 1000)) {
                continue;
            }
            $this->position($s, meters: $s === 90 ? 20 : 5, delay: $s === 60 ? 8 : 2, inside: ! ($s >= 630 && $s <= 690));
        }
        // Range walk: live at 20 m and 40 m; the 60 m one only arrived later from the backlog.
        $this->position(330, meters: 20, delay: 2);
        $this->position(360, meters: 40, delay: 2);
        $this->position(390, meters: 60, delay: 100);
        // Taken while the hotspot was off and sent once it came back: not a normal delay.
        $this->position(840, meters: 5, delay: 170);

        $this->tap($id, 10, 'spot_start');
        $this->tap($id, 310, 'spot_end');
        $this->tap($id, 320, 'range_start');
        $this->tap($id, 500, 'range_end');
        $this->tap($id, 600, 'zone_start');
        $this->tap($id, 610, 'left');
        $this->tap($id, 700, 'entered');
        $this->tap($id, 760, 'zone_end');
        $this->tap($id, 800, 'hotspot_off');
        $this->tap($id, 1000, 'hotspot_on');

        $this->alert(950, 'signal_lost');
        $this->alert(951, 'signal_lost');      // the same alert, stored for another recipient
        $this->alert(1010, 'signal_restored');
        $this->alert(1090, 'signal_lost');     // no hotspot change behind it: a false alert

        $this->at(1100);
        $m = $this->postJson("/api/v1/field-tests/{$id}/finish")->assertOk()->json('report.metrics');

        // 22 normal positions, one of them 8 s late.
        $this->assertSame(22, $m['latency']['samples']);
        $this->assertEquals(95.5, $m['latency']['pct']);
        $this->assertTrue($m['latency']['pass']);

        // 9 positions on the spot, one of them 20 m off.
        $this->assertSame(9, $m['distance']['samples']);
        $this->assertEquals(88.9, $m['distance']['pct']);
        $this->assertFalse($m['distance']['pass']);

        $this->assertEquals(40.0, $m['range']['farthest_m']);
        $this->assertTrue($m['range']['lost']);
        $this->assertTrue($m['range']['pass']);

        // 18 received, 1 missed (the hotspot-off and range periods are not counted).
        $this->assertSame(18, $m['reliability']['received']);
        $this->assertSame(1, $m['reliability']['missed']);
        $this->assertEquals(94.7, $m['reliability']['pct']);

        $this->assertSame(2, $m['geofence']['correct']);
        $this->assertEquals(100, $m['geofence']['pct']);
        $this->assertSame(20, $m['geofence']['crossings'][0]['delay_s']);

        // Lost and restored both fired; one false "Signal Lost".
        $this->assertSame(2, $m['alerts']['correct']);
        $this->assertSame(1, $m['alerts']['false_count']);
        $this->assertEquals(66.7, $m['alerts']['pct']);
        $this->assertSame(150, $m['alerts']['trials'][0]['delay_s']);
    }

    public function test_steps_must_follow_in_order(): void
    {
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->json('test.field_test_id');
        $mark = function (string $kind, int $second) use ($id) {
            $this->at($second); // one request a second, under the API rate limit
            return $this->postJson("/api/v1/field-tests/{$id}/marks", ['kind' => $kind]);
        };

        $mark('spot_start', 1)->assertStatus(422);   // no marked spot yet
        $mark('left', 2)->assertStatus(422);         // zone walks not started
        $mark('hotspot_on', 3)->assertStatus(422);   // hotspot never turned off
        $mark('hotspot_off', 4)->assertOk();
        $mark('hotspot_off', 5)->assertStatus(422);  // already off

        $this->at(6);
        $this->postJson("/api/v1/field-tests/{$id}/undo")->assertOk()->assertJsonCount(0, 'test.marks');

        // Starting again returns the running test.
        $this->at(7);
        $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])
            ->assertOk()->assertJsonPath('test.field_test_id', $id);
    }

    public function test_a_firearm_must_be_issued_with_gps_on(): void
    {
        $this->tx->update(['gps_tracking_enabled' => false]);
        $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->assertStatus(422);
    }

    public function test_personnel_cannot_use_field_tests(): void
    {
        Sanctum::actingAs(User::where('username', 'pvt.dela.cruz')->first(), ['Personnel']);
        $this->getJson('/api/v1/field-tests')->assertForbidden();
    }

    private function at(int $seconds): void
    {
        Carbon::setTestNow($this->t0->addSeconds($seconds));
    }

    private function tap(int $id, int $seconds, string $kind): void
    {
        $this->at($seconds);
        $this->postJson("/api/v1/field-tests/{$id}/marks", ['kind' => $kind])->assertOk();
    }

    /** A position $meters north of the marked spot, taken at t0 + $seconds. */
    private function position(int $seconds, float $meters, int $delay, bool $inside = true): void
    {
        GpsLog::create([
            'transaction_id'     => $this->tx->transaction_id,
            'equipment_id'       => $this->firearm->equipment_id,
            'captured_at'        => $this->t0->addSeconds($seconds),
            'received_at'        => $this->t0->addSeconds($seconds + $delay),
            'latitude'           => self::REF_LAT + $meters / 111194.9,
            'longitude'          => self::REF_LNG,
            'is_inside_geofence' => $inside,
            'device_id'          => 'TRK-TEST',
        ]);
    }

    private function alert(int $seconds, string $type): void
    {
        $when = $this->t0->addSeconds($seconds);
        DB::table('notifications')->insert([
            'user_id'      => User::where('username', 'admin')->value('user_id'),
            'equipment_id' => $this->firearm->equipment_id,
            'type'         => $type,
            'severity'     => 'warning',
            'title'        => $type,
            'message'      => $type,
            'status'       => 'Unread',
            'created_at'   => $when,
            'updated_at'   => $when,
        ]);
    }
}
