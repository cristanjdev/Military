<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Client revision: an issued firearm travels camp -> assigned destination -> camp. A zone is
 * marked as part of the camp, and each issuance records its destination and how far along the
 * trip it is (TripMonitor).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('gps_locations', function (Blueprint $table) {
            $table->boolean('is_camp')->default(false)->after('is_armory')
                ->comment('Part of the camp; armory zones count as camp too');
        });

        // The baseline perimeter zone is the camp.
        DB::table('gps_locations')->where('location_name', 'Camp Evangelista Perimeter')->update(['is_camp' => true]);

        Schema::table('transactions', function (Blueprint $table) {
            $table->unsignedBigInteger('destination_location_id')->nullable()->after('purpose');
            $table->string('trip_stage', 20)->nullable()->after('destination_location_id')
                ->comment('at_camp | outbound | on_site | returning | back_at_camp');
            $table->string('trip_place', 100)->nullable()->after('trip_stage')
                ->comment('Last confirmed place: camp | destination | away | other:<zone ids>');
            $table->timestamp('destination_arrived_at')->nullable()->after('trip_place');

            $table->foreign('destination_location_id')->references('location_id')->on('gps_locations')
                ->onUpdate('cascade')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropForeign(['destination_location_id']);
            $table->dropColumn(['destination_location_id', 'trip_stage', 'trip_place', 'destination_arrived_at']);
        });
        Schema::table('gps_locations', function (Blueprint $table) {
            $table->dropColumn('is_camp');
        });
    }
};
