"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Fingerprint, Lock, Loader2, AlertTriangle, X, Timer, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth";

interface SystemSettings {
  totp_required: boolean;
  biometric_required: boolean;
  session_expiry_enabled: boolean;
}

const SETTINGS_KEY = ["system-settings"] as const;

function useSystemSettings(enabled: boolean) {
  return useQuery<SystemSettings>({
    queryKey: SETTINGS_KEY,
    queryFn: async () => (await api.get<SystemSettings>("/settings")).data,
    enabled,
    staleTime: 60_000,
  });
}

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "Administrator";
  const settings = useSystemSettings(isAdmin);

  return (
    <div className="space-y-6 w-full">
      <div>
        <h1 className="text-2xl font-bold text-olive-50">Settings</h1>
        <p className="text-sm text-steel-400">Manage your authentication methods and password.</p>
      </div>

      <PasswordChangeSection />
      {isAdmin && <TotpSection settings={settings.data} loading={settings.isLoading} />}
      {isAdmin && <BiometricSection settings={settings.data} loading={settings.isLoading} />}
      {isAdmin && <SessionExpirySection settings={settings.data} loading={settings.isLoading} />}
    </div>
  );
}

function PasswordChangeSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function verifyCurrentPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword.trim()) {
      toast.warning("Please enter your current password.");
      return;
    }
    setVerifying(true);
    try {
      await api.post("/auth/verify-password", { current_password: currentPassword });
      setVerified(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Incorrect password.");
    } finally {
      setVerifying(false);
    }
  }

  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 10) {
      toast.warning("New password must be at least 10 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.warning("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await api.post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
        new_password_confirmation: confirmPassword,
      });
      toast.success("Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowCurrentPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
      setVerified(false);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Password change failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-xl p-5"
    >
      <p className="section-title flex items-center gap-2 mb-3"><Lock className="h-4 w-4" /> Change Password</p>

      {!verified ? (
        <form onSubmit={verifyCurrentPassword}>
          <p className="text-sm text-steel-400 mb-3">Enter your current password to proceed.</p>
          <div className="flex gap-3 items-start">
            <div className="relative flex-1 max-w-sm">
              <input
                className="input-field w-full pr-10"
                type={showCurrentPassword ? "text" : "password"}
                required
                placeholder="Current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-steel-400 hover:text-olive-300 transition-colors p-1"
                aria-label={showCurrentPassword ? "Hide password" : "Show password"}
              >
                {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <button disabled={verifying} className="btn-primary shrink-0">
              {verifying && <Loader2 className="h-4 w-4 animate-spin" />} Verify
            </button>
          </div>
        </form>
      ) : (
        <motion.form
          onSubmit={submitNewPassword}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <p className="text-sm text-green-400 mb-3">✓ Password verified. Enter your new password below.</p>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="relative">
              <input
                className="input-field w-full pr-10"
                type={showNewPassword ? "text" : "password"}
                required
                placeholder="New password (≥10 chars)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-steel-400 hover:text-olive-300 transition-colors p-1"
                aria-label={showNewPassword ? "Hide password" : "Show password"}
              >
                {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="relative">
              <input
                className="input-field w-full pr-10"
                type={showConfirmPassword ? "text" : "password"}
                required
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-steel-400 hover:text-olive-300 transition-colors p-1"
                aria-label={showConfirmPassword ? "Hide password" : "Show password"}
              >
                {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button disabled={loading} className="btn-primary">
              {loading && <Loader2 className="h-4 w-4 animate-spin" />} Update Password
            </button>
            <button
              type="button"
              onClick={() => {
                setVerified(false);
                setNewPassword("");
                setConfirmPassword("");
                setShowCurrentPassword(false);
                setShowNewPassword(false);
                setShowConfirmPassword(false);
              }}
              className="btn-secondary text-xs"
            >
              Cancel
            </button>
          </div>
        </motion.form>
      )}
    </motion.div>
  );
}

/* -------------- Reusable Confirmation Modal -------------- */
function ConfirmModal({
  open,
  onClose,
  onConfirm,
  loading,
  action,
  title,
  description,
  icon: Icon,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
  action: "enable" | "disable";
  title: string;
  description: string;
  icon: typeof KeyRound;
}) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            onClick={(e) => e.stopPropagation()}
            className="glass rounded-xl p-6 w-full max-w-md space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className={`flex items-center gap-2 ${action === "disable" ? "text-amber-300" : "text-olive-300"}`}>
                {action === "disable" ? <AlertTriangle className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                <h3 className="text-sm font-bold uppercase tracking-widest">{title}</h3>
              </div>
              <button onClick={onClose} className="btn-ghost p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-steel-300">{description}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
              <button onClick={onConfirm} disabled={loading} className="btn-primary text-xs">
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {action === "disable" ? " Confirm Disable" : " Confirm Enable"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* -------------- TOTP Section (System-wide, Admin Only) -------------- */
function TotpSection({ settings, loading: parentLoading }: { settings?: SystemSettings; loading: boolean }) {
  const qc = useQueryClient();
  const enabled = settings?.totp_required ?? null;
  const [loading, setLoading] = useState(false);
  const [modalAction, setModalAction] = useState<"enable" | "disable" | null>(null);

  function handleToggleClick() {
    if (enabled === null) return;
    setModalAction(enabled ? "disable" : "enable");
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      const newValue = modalAction === "enable";
      const res = await api.patch<SystemSettings>("/settings", { totp_required: newValue });
      qc.setQueryData(SETTINGS_KEY, res.data);
      toast.success(
        newValue
          ? "TOTP requirement enabled system-wide. All users will set up Google Authenticator on their next login."
          : "TOTP requirement disabled. No user will be prompted for a 6-digit code at login."
      );
      setModalAction(null);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Failed to update setting.");
    } finally {
      setLoading(false);
    }
  }

  if (parentLoading || enabled === null) {
    return (
      <div className="glass rounded-xl p-5 animate-pulse">
        <div className="h-5 w-48 bg-steel-700 rounded" />
      </div>
    );
  }

  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-olive-300" />
          <div>
            <p className="section-title">TOTP (Google Authenticator)</p>
            <p className="text-sm text-steel-400 mt-0.5">
              {enabled
                ? "Active — all users are required to enter a 6-digit code from Google Authenticator at login."
                : "Disabled — no user is prompted for a TOTP code at login."}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggleClick}
          disabled={loading}
          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${
            enabled ? "bg-olive-600" : "bg-steel-700"
          }`}
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle system-wide TOTP"
        >
          <span
            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg ring-0 transition-transform duration-300 ease-in-out ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <ConfirmModal
        open={modalAction !== null}
        onClose={() => setModalAction(null)}
        onConfirm={handleConfirm}
        loading={loading}
        action={modalAction ?? "disable"}
        title={modalAction === "enable" ? "Enable TOTP System-wide" : "Disable TOTP System-wide"}
        description={
          modalAction === "enable"
            ? "This will require every user — regardless of role — to set up Google Authenticator and enter a 6-digit code at login. The change takes effect on each user's next login."
            : "This will remove the TOTP requirement from the login flow for every user. No 6-digit code will be required to sign in."
        }
        icon={KeyRound}
      />
    </div>
  );
}

/* -------------- Biometric Section (System-wide, Admin Only) -------------- */
function BiometricSection({ settings, loading: parentLoading }: { settings?: SystemSettings; loading: boolean }) {
  const qc = useQueryClient();
  const enabled = settings?.biometric_required ?? null;
  const [loading, setLoading] = useState(false);
  const [modalAction, setModalAction] = useState<"enable" | "disable" | null>(null);

  function handleToggleClick() {
    if (enabled === null) return;
    setModalAction(enabled ? "disable" : "enable");
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      const newValue = modalAction === "enable";
      const res = await api.patch<SystemSettings>("/settings", { biometric_required: newValue });
      qc.setQueryData(SETTINGS_KEY, res.data);
      toast.success(
        newValue
          ? "Biometric requirement enabled system-wide. All users will enroll their fingerprint on their next login."
          : "Biometric requirement disabled. No user will be prompted for a fingerprint scan at login."
      );
      setModalAction(null);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Failed to update setting.");
    } finally {
      setLoading(false);
    }
  }

  if (parentLoading || enabled === null) {
    return (
      <div className="glass rounded-xl p-5 animate-pulse">
        <div className="h-5 w-48 bg-steel-700 rounded" />
      </div>
    );
  }

  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Fingerprint className="h-5 w-5 text-olive-300" />
          <div>
            <p className="section-title">Biometric (Fingerprint)</p>
            <p className="text-sm text-steel-400 mt-0.5">
              {enabled
                ? "Active — all users are required to scan their fingerprint at login."
                : "Disabled — no user is prompted for a fingerprint at login."}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggleClick}
          disabled={loading}
          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${
            enabled ? "bg-olive-600" : "bg-steel-700"
          }`}
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle system-wide Biometric"
        >
          <span
            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg ring-0 transition-transform duration-300 ease-in-out ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <ConfirmModal
        open={modalAction !== null}
        onClose={() => setModalAction(null)}
        onConfirm={handleConfirm}
        loading={loading}
        action={modalAction ?? "disable"}
        title={modalAction === "enable" ? "Enable Biometric System-wide" : "Disable Biometric System-wide"}
        description={
          modalAction === "enable"
            ? "This will require every user — regardless of role — to enroll and scan their fingerprint at login. The change takes effect on each user's next login."
            : "This will remove the biometric requirement from the login flow for every user. No fingerprint scan will be required to sign in."
        }
        icon={Fingerprint}
      />
    </div>
  );
}

/* -------------- Session Auto-Expiry Section (Admin Only) -------------- */
function SessionExpirySection({ settings, loading: parentLoading }: { settings?: SystemSettings; loading: boolean }) {
  const qc = useQueryClient();
  const enabled = settings?.session_expiry_enabled ?? null;
  const [loading, setLoading] = useState(false);
  const [modalAction, setModalAction] = useState<"enable" | "disable" | null>(null);

  function handleToggleClick() {
    if (enabled === null) return;
    setModalAction(enabled ? "disable" : "enable");
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      const newValue = modalAction === "enable";
      const res = await api.patch<SystemSettings>("/settings", { session_expiry_enabled: newValue });
      qc.setQueryData(SETTINGS_KEY, res.data);
      toast.success(
        newValue
          ? "Session auto-expiry enabled. Sessions will expire after 15 minutes."
          : "Session auto-expiry disabled. Sessions will no longer auto-expire."
      );
      setModalAction(null);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? "Failed to update setting.");
    } finally {
      setLoading(false);
    }
  }

  if (parentLoading || enabled === null) {
    return (
      <div className="glass rounded-xl p-5 animate-pulse">
        <div className="h-5 w-48 bg-steel-700 rounded" />
      </div>
    );
  }

  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Timer className="h-5 w-5 text-olive-300" />
          <div>
            <p className="section-title">Session Auto-Expiry</p>
            <p className="text-sm text-steel-400 mt-0.5">
              {enabled
                ? "Active — sessions automatically expire after 15 minutes of inactivity."
                : "Disabled — sessions will not auto-expire (users stay logged in until manual logout)."}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggleClick}
          disabled={loading}
          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${
            enabled ? "bg-olive-600" : "bg-steel-700"
          }`}
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle Session Auto-Expiry"
        >
          <span
            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg ring-0 transition-transform duration-300 ease-in-out ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <ConfirmModal
        open={modalAction !== null}
        onClose={() => setModalAction(null)}
        onConfirm={handleConfirm}
        loading={loading}
        action={modalAction ?? "disable"}
        title={modalAction === "enable" ? "Enable Auto-Expiry" : "Disable Auto-Expiry"}
        description={
          modalAction === "enable"
            ? "Sessions will automatically expire after 15 minutes. Users will need to log in again after the timeout."
            : "Sessions will no longer auto-expire. Users will stay logged in until they manually log out. Note: this change takes effect on the next login."
        }
        icon={Timer}
      />
    </div>
  );
}
