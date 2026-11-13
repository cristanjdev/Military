"use client";

import React from "react";
import {
  Activity, ArrowDownLeft, ArrowUpRight, ClipboardCheck, Clock, Fingerprint, KeyRound, LogIn, LogOut,
  MapPinned, QrCode, Settings, Shield, ShieldAlert, ShieldCheck, UserCog, Wrench, type LucideIcon,
} from "lucide-react";
import { fmtDate } from "@/lib/utils";
import { humanizeAuditAction } from "@/lib/audit";

export interface AuditFeedItem {
  log_id: number;
  action: string;
  description: string;
  created_at: string;
  ip_address: string;
  user?: {
    username: string;
    rank?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    [key: string]: any;
  } | null;
}

interface AuditFeedProps {
  items?: AuditFeedItem[];
  maxHeight?: string;
}

/** What the person did, read after their name: "Juan Cruz signed in". */
const PHRASES: Record<string, string> = {
  login: "signed in",
  logout: "signed out",
  failed_login: "failed to sign in",
  account_locked: "was locked out after failed sign-ins",
  access_denied: "was denied access to a page",
  password_change: "changed a password",
  password_confirm_failed: "entered a wrong password to delete a record",
  totp_enable: "set up the authenticator app",
  totp_reset: "reset an authenticator app",
  mfa_reset: "reset two-step sign-in",
  biometric_enroll: "registered a fingerprint",
  biometric_enable: "changed the fingerprint requirement",
  biometric_reset: "reset a fingerprint",
  biometric_stepup: "confirmed an action by fingerprint",
  biometric_stepup_failed: "failed a fingerprint check",
  settings_update: "changed the system settings",
  config_change: "changed the system settings",
  issuance: "issued a firearm",
  return: "recorded a firearm return",
  overdue_flagged: "flagged a firearm as overdue",
  firearm_register: "added a firearm",
  firearm_create: "added a firearm",
  firearm_update: "updated a firearm",
  firearm_delete: "archived a firearm",
  maintenance: "recorded maintenance",
  qr_scan: "scanned a firearm's QR code",
  destination_change: "changed a trip destination",
  user_create: "created a user account",
  user_update: "updated a user account",
  user_delete: "archived a user account",
  request_submitted: "submitted a request",
  request_approved: "approved a request",
  request_rejected: "rejected a request",
  repair_reported: "reported a firearm for repair",
  repair_forwarded: "forwarded a repair request",
  repair_approved: "approved a repair",
  repair_rejected: "rejected a repair",
  repair_custodian_informed: "informed the custodian about a repair",
  repair_sent: "sent a firearm for repair",
  repair_returned: "recorded a firearm back from repair",
  gps_signature_invalid: "rejected GPS data with an invalid signature",
  audit_verify: "verified the audit trail",
};

/** Actions whose description only repeats the sentence ("Successful login by …"). */
const SELF_EXPLANATORY = new Set(["login", "logout", "password_change", "totp_enable"]);

/** Things that need a second look: amber, or red for the serious ones. */
const WARNING = new Set(["failed_login", "access_denied", "biometric_stepup_failed", "password_confirm_failed"]);
const DANGER = new Set(["account_locked", "gps_signature_invalid"]);

function iconFor(action: string): LucideIcon {
  if (WARNING.has(action) || DANGER.has(action)) return ShieldAlert;
  if (action === "login") return LogIn;
  if (action === "logout") return LogOut;
  if (action.startsWith("biometric")) return Fingerprint;
  if (/password|totp|mfa/.test(action)) return KeyRound;
  if (action === "settings_update" || action === "config_change") return Settings;
  if (action === "issuance") return ArrowUpRight;
  if (action === "return") return ArrowDownLeft;
  if (action === "overdue_flagged") return Clock;
  if (action.startsWith("firearm")) return Shield;
  if (action.startsWith("repair") || action === "maintenance") return Wrench;
  if (action.startsWith("user")) return UserCog;
  if (action.startsWith("request")) return ClipboardCheck;
  if (action === "qr_scan") return QrCode;
  if (action === "destination_change") return MapPinned;
  if (action === "audit_verify") return ShieldCheck;
  return Activity;
}

function toneFor(action: string): string {
  if (DANGER.has(action)) return "text-red-400";
  if (WARNING.has(action)) return "text-amber-400";
  return "text-olive-400";
}

/** Done by the system itself; any other entry without a user is someone not signed in. */
const SYSTEM_ACTIONS = new Set(["overdue_flagged", "gps_signature_invalid"]);

function actorName(user: AuditFeedItem["user"], action: string): string {
  if (!user) return SYSTEM_ACTIONS.has(action) ? "System" : "Someone";
  const name = [user.rank, user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || user.username;
}

/** Plain-language reasons for the backend's sign-in failure descriptions (AuthController). */
const FAILED_LOGIN_REASONS: [RegExp, string][] = [
  [/^Failed password for /, "Wrong password"],
  [/^Invalid TOTP$/, "Wrong authenticator code"],
  [/^Biometric mismatch$/, "Fingerprint did not match"],
];

/** Who did it, what they did, and the extra detail line, for one entry. */
function describe(a: AuditFeedItem): { who: string; phrase: React.ReactNode; detail: string } {
  if (a.action === "failed_login") {
    // Nobody signed in to name: the attempt used a username or email that has no account.
    const unknown = !a.user && a.description.match(/^Unknown username or email (.+)$/);
    if (unknown) {
      return { who: `"${unknown[1]}"`, phrase: "failed to sign in", detail: "No account has this username or email" };
    }
    const reason = FAILED_LOGIN_REASONS.find(([re]) => re.test(a.description));
    if (reason) return { who: actorName(a.user, a.action), phrase: PHRASES.failed_login, detail: reason[1] };
  }
  return {
    who: actorName(a.user, a.action),
    phrase: PHRASES[a.action] ?? <>· {humanizeAuditAction(a.action)}</>,
    detail: SELF_EXPLANATORY.has(a.action) ? "" : a.description,
  };
}

/** "just now", "6 min ago", "3 hr ago", "yesterday", then the date. */
function shortTime(iso: string): string {
  const at = new Date(iso);
  const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr ago`;
  if (minutes < 48 * 60) return "yesterday";
  return fmtDate(at, "MMM d");
}

export function AuditFeed({ items = [], maxHeight = "max-h-[320px]" }: AuditFeedProps) {
  // The separate sign-in steps (password, code, fingerprint) end in one "signed in" entry.
  const events = items.filter((a) => !/^login_step\d$/.test(a.action));

  if (events.length === 0) {
    return <p className="text-xs text-steel-500 py-4 text-center">No recent activity.</p>;
  }

  return (
    <ol className={`overflow-y-auto pr-2 divide-y divide-steel-800/70 ${maxHeight}`}>
      {events.map((a) => {
        const Icon = iconFor(a.action);
        const { who, phrase, detail } = describe(a);
        const when = fmtDate(a.created_at, "MMM d, yyyy h:mm a");
        return (
          <li
            key={a.log_id}
            className="flex items-center gap-3 py-2.5 first:pt-0"
            title={[when, a.user?.username && `@${a.user.username}`, a.ip_address && `IP ${a.ip_address}`].filter(Boolean).join(" · ")}
          >
            {/* Centred on the title and detail lines together */}
            <Icon className={`h-4 w-4 shrink-0 ${toneFor(a.action)}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-snug text-steel-300 break-words">
                <span className="font-semibold text-olive-100">{who}</span> {phrase}
              </p>
              {detail && <p className="mt-0.5 text-xs leading-snug text-steel-400 line-clamp-2 break-words">{detail}</p>}
            </div>
            <time dateTime={a.created_at} className="shrink-0 whitespace-nowrap text-[11px] text-steel-500">
              {shortTime(a.created_at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
