<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Repair approval (defense feedback, 2026-11): the Armory Custodian reports a damaged firearm to
 * the S4 Officer, the S4 forwards it to the Command Officer, the Command Officer decides, the S4
 * tells the Custodian, and only then does the Custodian send the firearm for repair. Every step
 * keeps its date, and the firearm stays tracked while it is away.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('repair_requests', function (Blueprint $table) {
            $table->bigIncrements('repair_id');
            $table->unsignedBigInteger('equipment_id');
            $table->string('status', 20);

            // 1. The Custodian reports the damage to the S4 Officer.
            $table->string('problem', 500);
            $table->date('damaged_at');
            $table->unsignedBigInteger('reported_by');
            $table->timestamp('reported_at');

            // 2-3. The S4 Officer enters the request and forwards it to the Command Officer.
            $table->unsignedInteger('estimated_cost')->nullable();
            $table->string('s4_notes', 500)->nullable();
            $table->unsignedBigInteger('forwarded_by')->nullable();
            $table->timestamp('forwarded_at')->nullable();

            // 4. The Command Officer approves or rejects.
            $table->unsignedBigInteger('decided_by')->nullable();
            $table->timestamp('decided_at')->nullable();
            $table->string('decision_note', 500)->nullable();

            // 5. The S4 Officer reports the decision back to the Custodian.
            $table->unsignedBigInteger('informed_by')->nullable();
            $table->timestamp('custodian_informed_at')->nullable();

            // 6. The Custodian sends the firearm for repair, to whoever receives it there.
            $table->unsignedBigInteger('sent_by')->nullable();
            $table->timestamp('sent_at')->nullable();
            $table->string('received_by', 100)->nullable();
            $table->string('received_by_unit', 100)->nullable();

            // 7. Back from maintenance: the firearm's status changes only now.
            $table->date('repaired_at')->nullable();
            $table->unsignedBigInteger('returned_to')->nullable();
            $table->timestamp('returned_at')->nullable();
            $table->unsignedTinyInteger('result_status')->nullable();
            $table->unsignedInteger('cost')->nullable();
            $table->string('work_done', 500)->nullable();
            $table->unsignedBigInteger('maintenance_id')->nullable();

            $table->timestamps();

            $table->foreign('equipment_id')->references('equipment_id')->on('firearm_equipment')->cascadeOnUpdate()->restrictOnDelete();
            foreach (['reported_by', 'forwarded_by', 'decided_by', 'informed_by', 'sent_by', 'returned_to'] as $userColumn) {
                $table->foreign($userColumn)->references('user_id')->on('users')->cascadeOnUpdate()->restrictOnDelete();
            }
            $table->foreign('maintenance_id')->references('maintenance_id')->on('maintenance_records')->cascadeOnUpdate()->nullOnDelete();
            $table->index(['equipment_id', 'status']);
            $table->index('status');
        });

        // Positions sent while the firearm is out for repair belong to the repair, not to an issuance.
        Schema::table('gps_logs', function (Blueprint $table) {
            $table->unsignedBigInteger('repair_id')->nullable()->after('transaction_id');
            $table->foreign('repair_id')->references('repair_id')->on('repair_requests')->cascadeOnUpdate()->nullOnDelete();
            $table->index('repair_id');
        });

        // Who actually did the work: the repairer is usually not an account in the system.
        Schema::table('maintenance_records', function (Blueprint $table) {
            $table->string('repaired_by', 100)->nullable()->after('performed_by');
        });
    }

    public function down(): void
    {
        Schema::table('maintenance_records', function (Blueprint $table) {
            $table->dropColumn('repaired_by');
        });
        Schema::table('gps_logs', function (Blueprint $table) {
            $table->dropForeign(['repair_id']);
            $table->dropIndex(['repair_id']);
            $table->dropColumn('repair_id');
        });
        Schema::dropIfExists('repair_requests');
    }
};
