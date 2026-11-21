<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Hardware timings for the field test (mock defense feedback, 2026-11-21):
 *   gps_logs.fix_age_ms   how old the GPS fix was when the tracker sent it
 *   gps_logs.post_ms      how long the tracker's previous send took, start to answer
 *   tracker_startups      seconds from power-on to Wi-Fi, satellites, GPS fix and first position
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('gps_logs', function (Blueprint $table) {
            $table->unsignedInteger('fix_age_ms')->nullable()->after('battery_pct');
            $table->unsignedInteger('post_ms')->nullable()->after('fix_age_ms');
        });

        Schema::create('tracker_startups', function (Blueprint $table) {
            $table->id('startup_id');
            $table->foreignId('equipment_id')->constrained('firearm_equipment', 'equipment_id')->cascadeOnDelete();
            $table->string('device_id', 64);
            $table->string('reason', 20)->nullable();
            $table->dateTime('booted_at');
            $table->unsignedInteger('wifi_ms')->nullable();
            $table->unsignedInteger('sats_ms')->nullable();
            $table->unsignedInteger('fix_ms')->nullable();
            $table->dateTime('first_received_at');
            $table->timestamp('created_at')->nullable();
            $table->index(['equipment_id', 'booted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tracker_startups');
        Schema::table('gps_logs', function (Blueprint $table) {
            $table->dropColumn(['fix_age_ms', 'post_ms']);
        });
    }
};
