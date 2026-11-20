<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Field tests (mock defense feedback, 2026-11): the team takes an issued firearm's tracker
 * outdoors and taps what they do (tracker placed on a marked spot, walked away from the hotspot,
 * crossed a zone edge, hotspot turned off). The tracker's own positions and the system's alerts
 * during the test then give the measured numbers: update latency, distance error, hotspot range,
 * signal reliability, geofence accuracy and alert trigger accuracy.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('field_tests', function (Blueprint $table) {
            $table->bigIncrements('field_test_id');
            $table->unsignedBigInteger('equipment_id');
            $table->unsignedBigInteger('started_by');
            $table->timestamp('started_at');
            $table->timestamp('ended_at')->nullable();

            // The marked spot: the tracker sits on it for the distance error test, and the
            // phone (hotspot) stays on it for the range test.
            $table->decimal('reference_latitude', 10, 7)->nullable();
            $table->decimal('reference_longitude', 10, 7)->nullable();
            $table->timestamps();

            $table->foreign('equipment_id')->references('equipment_id')->on('firearm_equipment')
                ->onUpdate('cascade')->onDelete('cascade');
            $table->foreign('started_by')->references('user_id')->on('users')
                ->onUpdate('cascade');
            $table->index(['equipment_id', 'ended_at']);
        });

        Schema::create('field_test_marks', function (Blueprint $table) {
            $table->bigIncrements('mark_id');
            $table->unsignedBigInteger('field_test_id');
            $table->string('kind', 20);
            // Server time when the tap arrived, so a phone with a wrong clock cannot skew the results.
            $table->timestamp('occurred_at');
            $table->unsignedBigInteger('created_by')->nullable();

            $table->foreign('field_test_id')->references('field_test_id')->on('field_tests')
                ->onUpdate('cascade')->onDelete('cascade');
            $table->index(['field_test_id', 'occurred_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('field_test_marks');
        Schema::dropIfExists('field_tests');
    }
};
