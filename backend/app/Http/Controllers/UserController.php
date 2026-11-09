<?php

namespace App\Http\Controllers;

use App\Models\Role;
use App\Models\Transaction;
use App\Models\User;
use App\Services\AccountNotifier;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class UserController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $q = User::with('role')
            ->when($request->filled('role'), fn($qq) => $qq->whereHas('role', fn($r) => $r->where('role_name', $request->string('role'))))
            ->when($request->boolean('only_active'), fn($qq) => $qq->where('status', User::STATUS_ACTIVE))
            ->when($request->string('search')->trim()->value(), function ($qq, $s) {
                $qq->where(fn($w) => $w->where('username', 'like', "%{$s}%")
                    ->orWhere('first_name', 'like', "%{$s}%")
                    ->orWhere('last_name', 'like', "%{$s}%")
                    ->orWhere('rank', 'like', "%{$s}%"));
            })
            ->orderBy('last_name');

        return response()->json($q->paginate($request->integer('per_page', 15)));
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username'           => ['required', 'string', 'max:50', 'unique:users,username'],
            'email'              => ['required', 'email', 'max:100', 'unique:users,email'],
            'password'           => ['required', 'string', 'min:10', 'max:200'],
            'first_name'         => ['required', 'string', 'max:50'],
            'last_name'          => ['required', 'string', 'max:50'],
            'rank'               => ['required', 'string', 'max:30'],
            'phone'              => ['nullable', 'string', 'max:11'],
            'role_id'            => ['required', 'exists:roles,role_id'],
            'security_clearance' => ['required', 'integer', 'between:1,3'],
            'status'             => ['nullable', 'integer', 'in:0,1'],
        ]);

        $this->assertMayManage($request, null, (int) $data['role_id']);
        $this->assertClearanceFitsRole((int) $data['role_id'], (int) $data['security_clearance']);

        $data['password'] = Hash::make($data['password']);
        $data['status']   = $data['status'] ?? User::STATUS_ACTIVE;

        $user = User::create($data);
        AuditLogger::log('user_create', "Created user {$user->username}", $request->user(), request: $request,
            metadata: ['created' => $user->only(['user_id', 'username', 'email', 'rank', 'first_name', 'last_name']) + ['role' => optional($user->fresh('role')->role)->role_name]]);
        return response()->json($user->fresh('role'), 201);
    }

    public function show(int $id): JsonResponse
    {
        return response()->json(User::with('role')->findOrFail($id));
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $user = User::findOrFail($id);

        $data = $request->validate([
            'username'           => ['sometimes', 'string', 'max:50', Rule::unique('users', 'username')->ignore($user->user_id, 'user_id')],
            'email'              => ['sometimes', 'email', 'max:100', Rule::unique('users', 'email')->ignore($user->user_id, 'user_id')],
            'first_name'         => ['sometimes', 'string', 'max:50'],
            'last_name'          => ['sometimes', 'string', 'max:50'],
            'rank'               => ['sometimes', 'string', 'max:30'],
            'phone'              => ['sometimes', 'nullable', 'string', 'max:11'],
            'role_id'            => ['sometimes', 'exists:roles,role_id'],
            'security_clearance' => ['sometimes', 'integer', 'between:1,3'],
            'status'             => ['sometimes', 'integer', 'in:0,1'],
            'password'           => ['sometimes', 'string', 'min:10', 'max:200'],
        ]);

        $this->assertMayManage($request, $user, isset($data['role_id']) ? (int) $data['role_id'] : null);

        // Check the combination the account will end up with, whichever of the two changed.
        $this->assertClearanceFitsRole(
            (int) ($data['role_id'] ?? $user->role_id),
            (int) ($data['security_clearance'] ?? $user->security_clearance),
        );

        $changes = AuditLogger::diff($user->getAttributes(), $data);
        if (isset($changes['role_id'])) {
            $names = Role::whereIn('role_id', [$changes['role_id']['from'], $changes['role_id']['to']])->pluck('role_name', 'role_id');
            $changes['role'] = ['from' => $names[$changes['role_id']['from']] ?? null, 'to' => $names[$changes['role_id']['to']] ?? null];
        }

        if (isset($data['password'])) {
            $data['password'] = Hash::make($data['password']);
        }

        $user->update($data);
        AuditLogger::log('user_update', "Updated user {$user->username}", $request->user(), request: $request,
            metadata: ['target_user_id' => $user->user_id, 'changes' => $changes]);
        AccountNotifier::accountChanged($user, $request->user(), array_map(
            fn($field) => str_replace(['_id', '_'], ['', ' '], $field),
            array_keys(array_diff_key($changes, ['role_id' => true]))
        ), $request);

        return response()->json($user->fresh('role'));
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $user = User::findOrFail($id);

        if ($user->user_id === $request->user()->user_id) {
            return response()->json(['message' => 'Cannot delete yourself.'], 422);
        }
        $this->assertMayManage($request, $user);
        if ($refused = $this->confirmPassword($request, "delete user {$user->username}")) {
            return $refused;
        }

        // A person still holding a firearm must return it first, or the issuance loses its holder.
        $held = Transaction::with('firearm')
            ->where('user_id', $user->user_id)
            ->whereIn('status', [Transaction::STATUS_ACTIVE, Transaction::STATUS_OVERDUE])
            ->get();
        if ($held->isNotEmpty()) {
            $serials = $held->map(fn($tx) => $tx->firearm?->serial_number)->filter()->implode(', ');
            return response()->json([
                'message' => "{$user->fullName()} still holds {$serials}. Return "
                    . ($held->count() > 1 ? 'these firearms' : 'the firearm') . ' before deleting the account.',
            ], 422);
        }

        $user->update(['status' => User::STATUS_INACTIVE]);
        $user->delete();

        AuditLogger::log('user_delete', "Soft-deleted user {$user->username}", $request->user(), request: $request,
            metadata: ['deleted' => $user->only(['user_id', 'username', 'email', 'rank', 'first_name', 'last_name']) + ['role' => optional($user->role)->role_name]]);
        return response()->json(['message' => 'User archived.']);
    }

    /**
     * A Command Officer manages every account except Administrator ones: they cannot create,
     * change, delete or reset an Administrator, nor give anyone the Administrator role.
     */
    private function assertMayManage(Request $request, ?User $target, ?int $newRoleId = null): void
    {
        if ($request->user()->hasRole(Role::ADMIN)) {
            return;
        }

        $adminRoleId = Role::where('role_name', Role::ADMIN)->value('role_id');
        $touchesAdmin = ($target && (int) $target->role_id === (int) $adminRoleId)
            || ($newRoleId !== null && $newRoleId === (int) $adminRoleId);

        if ($touchesAdmin) {
            abort(response()->json(['message' => 'Only an Administrator can manage Administrator accounts.'], 403));
        }
    }

    /**
     * Refuses a clearance below what the role needs (see Role::CLEARANCE_POLICY).
     */
    private function assertClearanceFitsRole(int $roleId, int $clearance): void
    {
        $role = Role::find($roleId);
        if ($role && $clearance < $role->min_clearance) {
            $labels = [
                User::CLEARANCE_CONFIDENTIAL => 'Confidential',
                User::CLEARANCE_SECRET       => 'Secret',
                User::CLEARANCE_TOP_SECRET   => 'Top Secret',
            ];
            throw ValidationException::withMessages([
                'security_clearance' => "{$role->role_name} accounts need at least {$labels[$role->min_clearance]} clearance: "
                    . 'the role includes the Audit Trail and security reports.',
            ]);
        }
    }

    public function roles(): JsonResponse
    {
        return response()->json(Role::orderBy('role_name')->get());
    }

    /**
     * Admin-only: Reset a user's MFA (TOTP + biometric) so they re-enroll on next login.
     */
    public function resetMfa(Request $request, int $id): JsonResponse
    {
        $user = User::findOrFail($id);
        $this->assertMayManage($request, $user);

        $user->update([
            'totp_secret'       => null,
            'totp_enabled'      => false,
            'biometric_data'    => null,
            'biometric_enrolled'=> false,
        ]);

        AuditLogger::log(
            action: 'mfa_reset',
            description: "MFA reset for user {$user->username} by {$request->user()->username}",
            user: $request->user(),
            request: $request,
            metadata: ['target_user_id' => $user->user_id],
        );

        AccountNotifier::accountChanged($user, $request->user(), ['authenticator and fingerprint reset'], $request);

        return response()->json(['message' => "MFA reset for {$user->username}. They will re-enroll on next login."]);
    }
}
