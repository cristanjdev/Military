<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The cell voltage behind the latest tracker battery reading. It tells a real level apart from
 * a tracker that measures no cell at all (USB power, switch off), which used to show as 0%.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('firearm_equipment', function (Blueprint $table) {
            $table->unsignedSmallInteger('tracker_battery_mv')->nullable()->after('tracker_battery_pct');
        });
    }

    public function down(): void
    {
        Schema::table('firearm_equipment', function (Blueprint $table) {
            $table->dropColumn('tracker_battery_mv');
        });
    }
};
