<?php

namespace Database\Seeders;

use App\Models\FirearmEquipment;
use App\Models\Notification;
use App\Models\Role;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;

/**
 * Sample notifications of every kind (sign-ins, trackers, trips, repairs, requests) over the last
 * few days, for trying the Notifications page locally. In-app only: no alert e-mails are sent.
 * Not part of DatabaseSeeder; run it with:
 *   php artisan db:seed --class=NotificationSeeder
 */
class NotificationSeeder extends Seeder
{
    public function run(): void
    {
        if (Notification::where('payload->sample', true)->exists()) {
            $this->command?->info('Sample notifications already seeded. Skipping.');
            return;
        }

        // The roles that see firearm alerts, plus the S4 Officer for requests and repairs.
        $users = User::where('status', User::STATUS_ACTIVE)
            ->whereHas('role', fn($q) => $q->whereIn('role_name', [...Notification::OVERSIGHT_ROLES, Role::S4_OFFICER]))
            ->get();

        if ($users->isEmpty()) {
            $this->command?->warn('No users to notify. Run UserSeeder first.');
            return;
        }

        $firearm = fn(string $serial) => FirearmEquipment::where('serial_number', $serial)->value('equipment_id');
        $now = Carbon::now();

        $samples = [
            ['geofence_violation', 'critical', 'Geofence Breach: PA-M4-001', 'PA-M4-001 left all authorised zones near Divisoria while issued to PVT Juan Dela Cruz.', 'PA-M4-001', $now->copy()->subMinutes(12), false],
            ['signal_lost', 'warning', 'Signal Lost: Location Updates Stopped', 'Tracker ESP32-001 on PA-M16-001 has not reported for 2 minutes. Last position: Camp Evangelista gate.', 'PA-M16-001', $now->copy()->subMinutes(48), false],
            ['failed_login', 'warning', 'Failed Sign-in Attempt', 'Someone tried to sign in as cpl.santos with a wrong password from 192.168.1.24.', null, $now->copy()->subHours(2), false],
            ['request_submitted', 'info', 'New Request: M4 Carbines for reserve training', 'CPT Joana Reyes requested 10 new firearms (PHP 950,000) and is waiting for your decision.', null, $now->copy()->subHours(3), false],
            ['battery_low', 'warning', 'Low Battery: PA-M16-001', 'The tracker battery is at 18%. Charge or replace the 21700 cell before the next issue.', 'PA-M16-001', $now->copy()->subHours(5), true],
            ['signal_restored', 'info', 'Signal Restored', 'Tracker ESP32-001 on PA-M16-001 is reporting again.', 'PA-M16-001', $now->copy()->subHours(6), true],
            ['trip_arrived', 'info', 'Arrived at Destination', 'PA-M4-002 arrived at Greenhills Firing Range.', 'PA-M4-002', $now->copy()->subDay()->setTime(10, 20), true],
            ['off_route', 'warning', 'Off-Route: PA-M4-002', 'PA-M4-002 left the expected route to Greenhills Firing Range.', 'PA-M4-002', $now->copy()->subDay()->setTime(9, 5), true],
            ['trip_left_camp', 'info', 'Left Camp', 'PA-M4-002 left Camp Evangelista for Greenhills Firing Range.', 'PA-M4-002', $now->copy()->subDay()->setTime(8, 40), true],
            ['overdue_return', 'warning', 'Overdue Return: PA-PI-002', 'PA-PI-002 was due back yesterday at 5:00 PM and has not been returned.', 'PA-PI-002', $now->copy()->subDays(2)->setTime(17, 1), true],
            ['repair_forwarded', 'info', 'Repair Needs Approval', 'The Armory Custodian forwarded the repair of PA-SG-001 for approval.', 'PA-SG-001', $now->copy()->subDays(3)->setTime(13, 45), true],
            ['account_locked', 'critical', 'Account Locked', 'pvt.dela.cruz was locked after 5 failed sign-in attempts.', null, $now->copy()->subDays(4)->setTime(7, 55), true],
        ];

        $count = 0;
        foreach ($users as $user) {
            foreach ($samples as [$type, $severity, $title, $message, $serial, $at, $read]) {
                $n = new Notification([
                    'user_id'      => $user->user_id,
                    'equipment_id' => $serial ? $firearm($serial) : null,
                    'type'         => $type,
                    'severity'     => $severity,
                    'title'        => $title,
                    'message'      => $message,
                    'payload'      => ['sample' => true],
                    'status'       => $read ? Notification::STATUS_READ : Notification::STATUS_UNREAD,
                    'read_at'      => $read ? $at->copy()->addMinutes(30) : null,
                ]);
                $n->withoutEmail = true;
                $n->created_at = $at;
                $n->updated_at = $at;
                $n->save();
                $count++;
            }
        }

        $this->command?->info("Seeded {$count} sample notifications for {$users->count()} users.");
    }
}
