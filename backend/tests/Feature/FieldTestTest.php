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
        $this->assertArrayNotHasKey('pass', $m['range']); // no target in the manuscript

        // 18 received, 1 missed (the hotspot-off and range periods are not counted).
        $this->assertSame(18, $m['reliability']['received']);
        $this->assertSame(1, $m['reliability']['missed']);
        $this->assertEquals(94.7, $m['reliability']['pct']);

        $this->assertSame(2, $m['geofence']['correct']);
        $this->assertEquals(100, $m['geofence']['pct']);
        $this->assertSame(20, $m['geofence']['crossings'][0]['delay_s']);

        // Checked against when positions really arrived: nothing from 782 s to 1010 s (the kept
        // position arriving), so "Signal Lost" was due and came at 950 s, and "Signal Restored" came
        // with that first position back. The 128 s gap in the range
        // walk is too short to expect one. The alert at 1090 s had no silence behind it.
        $this->assertSame(['signal_lost', 'signal_restored'], array_column($m['alerts']['trials'], 'kind'));
        $this->assertSame(2, $m['alerts']['correct']);
        $this->assertSame(1, $m['alerts']['false_count']);
        $this->assertEquals(66.7, $m['alerts']['pct']);
        $this->assertSame(168, $m['alerts']['trials'][0]['delay_s']);
        $this->assertSame('hotspot_off', $m['alerts']['trials'][0]['during']);
        $this->assertSame(0, $m['alerts']['trials'][1]['delay_s']);
    }

    public function test_alerts_follow_the_tracker_not_late_taps(): void
    {
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->json('test.field_test_id');

        // The hotspot really went off after 300 s and came back at 600 s, but the tester tapped
        // "off" too early and "on" two minutes late.
        foreach (range(30, 900, 30) as $s) {
            if ($s > 300 && $s < 600) {
                continue;
            }
            $this->position($s, meters: 5, delay: 2);
        }
        $this->tap($id, 100, 'hotspot_off');
        $this->tap($id, 720, 'hotspot_on');
        $this->alert(480, 'signal_lost');
        $this->alert(602, 'signal_restored');

        $this->at(900);
        $a = $this->getJson("/api/v1/field-tests/{$id}")->assertOk()->json('report.metrics.alerts');

        $this->assertSame(2, $a['correct']);
        $this->assertSame(0, $a['false_count']);
        $this->assertEquals(100, $a['pct']);
        $this->assertSame(178, $a['trials'][0]['delay_s']); // 302 s last position, alert at 480 s
    }

    public function test_startup_times_come_from_the_trackers_first_position(): void
    {
        config(['armory.iot.hmac_secret' => 'test-secret']);
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->json('test.field_test_id');

        // Sending every 5 s, switched off after 120 s, back on at 200 s.
        foreach (range(30, 120, 5) as $s) {
            $this->position($s, meters: 5, delay: 2);
        }

        // First position after power-on: taken 58 s after it started, reaching the server at 261 s.
        $body = json_encode([
            'equipment_id' => $this->firearm->equipment_id,
            'device_id'    => 'TRK-TEST',
            'captured_at'  => $this->t0->addSeconds(258)->utc()->format('Y-m-d\TH:i:s\Z'),
            'latitude'     => self::REF_LAT,
            'longitude'    => self::REF_LNG,
            'satellites'   => 9,
            'fix_age_ms'   => 800,
            'post_ms'      => 2500,
            'startup'      => ['uptime_ms' => 58000, 'wifi_ms' => 4200, 'sats_ms' => 9000, 'fix_ms' => 31000, 'reason' => 'power_on'],
        ]);
        $this->at(261);
        $this->call('POST', '/api/v1/gps/ingest', [], [], [], [
            'CONTENT_TYPE'           => 'application/json',
            'HTTP_ACCEPT'            => 'application/json',
            'HTTP_X_ARMORY_SIGNATURE' => hash_hmac('sha256', $body, 'test-secret'),
        ], $body)->assertOk();

        foreach (range(265, 400, 5) as $s) {
            $this->position($s, meters: 5, delay: 2);
        }

        $this->at(405);
        $m = $this->getJson("/api/v1/field-tests/{$id}")->assertOk()->json('report');

        $this->assertSame(5, $m['interval_seconds']); // measured from the positions, not the server setting
        $try = $m['metrics']['startup']['tries'][0];
        $this->assertSame('power_on', $try['reason']);
        $this->assertEquals(4.2, $try['wifi_s']);
        $this->assertEquals(9.0, $try['satellites_s']);
        $this->assertEquals(31.0, $try['fix_s']);
        $this->assertSame(61, $try['first_position_s']);
        $this->assertEquals(31.0, $m['metrics']['startup']['summary']['fix_s']['average']);

        // The switched-off minutes are not missed updates.
        $this->assertSame(0, $m['metrics']['reliability']['missed']);
        $this->assertEquals(0.8, $m['metrics']['latency']['fix_age_s']);
        $this->assertEquals(2.5, $m['metrics']['latency']['send_s']);
    }

    public function test_reliability_stops_at_the_last_position(): void
    {
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->json('test.field_test_id');

        // Every 5 s up to 300 s, with two missed on the way. The test is finished four hours later.
        foreach (range(30, 300, 5) as $s) {
            if ($s !== 100 && $s !== 200) {
                $this->position($s, meters: 5, delay: 2);
            }
        }

        $this->at(400);
        $r = $this->getJson("/api/v1/field-tests/{$id}")->assertOk()->json('report.metrics.reliability');
        $this->assertSame(53, $r['received']);
        $this->assertSame(2, $r['missed']); // gaps before the last position still count
        $this->assertSame(100, $r['silent_after_s']);

        $this->at(14700);
        $r = $this->postJson("/api/v1/field-tests/{$id}/finish")->assertOk()->json('report.metrics.reliability');
        $this->assertSame(53, $r['received']);
        $this->assertSame(2, $r['missed']);
        $this->assertEquals(96.4, $r['pct']);
        $this->assertSame(14400, $r['silent_after_s']);
    }

    public function test_silence_with_the_hotspot_off_is_not_reported_after_the_last_position(): void
    {
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->json('test.field_test_id');
        foreach (range(30, 300, 5) as $s) {
            $this->position($s, meters: 5, delay: 2);
        }
        $this->tap($id, 301, 'hotspot_off');

        $this->at(900);
        $r = $this->getJson("/api/v1/field-tests/{$id}")->assertOk()->json('report.metrics.reliability');
        $this->assertSame(0, $r['missed']);
        $this->assertSame(1, $r['silent_after_s']); // only the second before the tap
    }

    public function test_a_single_position_is_counted(): void
    {
        $id = $this->postJson('/api/v1/field-tests', ['equipment_id' => $this->firearm->equipment_id])->json('test.field_test_id');
        $this->position(30, meters: 5, delay: 2);

        $this->at(90);
        $r = $this->getJson("/api/v1/field-tests/{$id}")->assertOk()->json('report.metrics.reliability');
        $this->assertSame(1, $r['received']);
        $this->assertSame(0, $r['missed']);
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
        $mark('zone_start', 6)->assertStatus(422)    // one step at a time
            ->assertJsonPath('message', 'Stop "Alert trigger accuracy" first.');

        $this->at(7);
        $this->postJson("/api/v1/field-tests/{$id}/undo")->assertOk()->assertJsonCount(0, 'test.marks');
        $mark('zone_start', 8)->assertOk();

        // Starting again returns the running test.
        $this->at(9);
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
