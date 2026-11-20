/**
 * Simple mapping of technical audit action codes to plain, human-friendly action text.
 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: "User Login",
  login_step1: "Password Verified",
  login_step2: "TOTP Verified",
  login_step3: "Biometric Verified",
  logout: "User Logout",
  failed_login: "Failed Login",
  account_locked: "Account Locked",
  login_while_locked: "Sign-in While Locked",
  recaptcha_failed: "reCAPTCHA Failed",
  access_denied: "Access Denied",
  password_change: "Password Changed",
  totp_enable: "TOTP Enabled",
  totp_reset: "TOTP Reset",
  biometric_enroll: "Fingerprint Enrolled",
  biometric_stepup: "Fingerprint Re-verified",
  biometric_stepup_failed: "Fingerprint Re-scan Failed",
  biometric_enable: "Biometric Enabled",
  biometric_reset: "Biometric Reset",
  mfa_reset: "MFA Reset",
  account_unlock: "Account Unlocked",
  field_test_start: "Field Test Started",
  field_test_finish: "Field Test Finished",
  field_test_delete: "Field Test Deleted",
  issuance: "Firearm Issued",
  return: "Firearm Returned",
  overdue_flagged: "Flagged Overdue",
  firearm_create: "Firearm Added",
  firearm_update: "Firearm Updated",
  firearm_delete: "Firearm Archived",
  maintenance_started: "Maintenance Started",
  maintenance_completed: "Maintenance Completed",
  maintenance_schedule: "Maintenance Scheduled",
  user_create: "User Created",
  user_update: "User Updated",
  user_delete: "User Archived",
  gps_signature_invalid: "Invalid GPS Signature",
  gps_ingest: "GPS Ingested",
  geofence_breach: "Geofence Breach",
  geofence_exit: "Geofence Exit",
  config_change: "Config Changed",
  maintenance: "Maintenance Recorded",
  password_confirm_failed: "Wrong Password on Delete",
  audit_verify: "Audit Trail Verified",
};

/**
 * Transforms raw snake_case codes into plain, user-friendly action text.
 * e.g. "login_step1" -> "Password Verified", "gps_signature_invalid" -> "Invalid GPS Signature"
 */
export function humanizeAuditAction(action?: string): string {
  if (!action) return "System Event";
  if (AUDIT_ACTION_LABELS[action]) {
    return AUDIT_ACTION_LABELS[action];
  }
  return action
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
