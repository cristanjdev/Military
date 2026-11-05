<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The latest battery level a firearm's tracker reported, from a position or from a no-fix
 * status report, so the GPS page can show the level even while the tracker has no fix.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('firearm_equipment', function (Blueprint $table) {
            $table->unsignedTinyInteger('tracker_battery_pct')->nullable()->after('remarks');
            $table->timestamp('tracker_battery_at')->nullable()->after('tracker_battery_pct');
        });
    }

    public function down(): void
    {
        Schema::table('firearm_equipment', function (Blueprint $table) {
            $table->dropColumn(['tracker_battery_pct', 'tracker_battery_at']);
        });
    }
};
