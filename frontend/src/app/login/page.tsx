"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock,
  User,
  Loader2,
  Eye,
  EyeOff,
  KeyRound,
  ArrowLeft,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { AxiosError } from "axios";
import { BrandLogo } from "@/components/brand-logo";
import { useAuthStore } from "@/store/auth";
import { RecaptchaCheckbox, RecaptchaCheckboxHandle } from "@/components/auth/recaptcha-checkbox";

interface LoginResponse {
  message: string;
  challenge_token?: string;
  next?: "totp" | "totp_setup" | "biometric" | "biometric_enroll";
  totp_enabled?: boolean;
  biometric_enrolled?: boolean;
  username?: string;
  challenge_expires_in?: number;
  // Present when both MFA methods are disabled (direct login)
  token?: string;
  token_type?: string;
  expires_in?: number;
  user?: import("@/lib/api").AuthUser;
}

interface AuthRequirements {
  totp_required: boolean;
  biometric_required: boolean;
  mfa_required: boolean;
  recaptcha_action: string;
}

interface ForgotPasswordResponse {
  message: string;
  reset_token: string;
  masked_email: string;
}

interface VerifyResetCodeResponse {
  message: string;
  verified: boolean;
  username?: string;
}

interface ResetPasswordResponse {
  message: string;
  username?: string;
}

const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? "";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
// Demo builds without a site key skip the widget; the backend only honours this token in demo mode.
const RECAPTCHA_DEMO_BYPASS = DEMO_MODE && !RECAPTCHA_SITE_KEY;

type AuthMode = "login" | "forgot_request" | "forgot_verify" | "forgot_new_password";

export default function LoginPage() {
  const router = useRouter();

  // Mode: login, forgot_request, or forgot_reset
  const [mode, setMode] = useState<AuthMode>("login");

  // Login form state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showRecaptcha, setShowRecaptcha] = useState(false);
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);
  const recaptchaRef = useRef<RecaptchaCheckboxHandle | null>(null);
  const [loading, setLoading] = useState(false);

  // Forgot password form state
  const [resetIdentifier, setResetIdentifier] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetDigits, setResetDigits] = useState<string[]>(Array(6).fill(""));
  const otpInputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const [maskedEmail, setMaskedEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Countdown timer for resending reset code
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  // Auto-focus first OTP box when entering forgot_verify mode
  useEffect(() => {
    if (mode === "forgot_verify") {
      const timer = setTimeout(() => {
        otpInputsRef.current[0]?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [mode]);

  function handleOtpChange(index: number, val: string) {
    const sanitized = val.replace(/\D/g, "");
    if (!sanitized) {
      const next = [...resetDigits];
      next[index] = "";
      setResetDigits(next);
      setResetCode(next.join(""));
      return;
    }

    if (sanitized.length > 1) {
      const chars = sanitized.slice(0, 6).split("");
      const next = [...resetDigits];
      chars.forEach((char, idx) => {
        if (index + idx < 6) {
          next[index + idx] = char;
        }
      });
      setResetDigits(next);
      setResetCode(next.join(""));
      const nextFocus = Math.min(index + chars.length, 5);
      otpInputsRef.current[nextFocus]?.focus();
      return;
    }

    const next = [...resetDigits];
    next[index] = sanitized;
    setResetDigits(next);
    setResetCode(next.join(""));
    if (index < 5) {
      otpInputsRef.current[index + 1]?.focus();
    }
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      if (!resetDigits[index] && index > 0) {
        otpInputsRef.current[index - 1]?.focus();
        const next = [...resetDigits];
        next[index - 1] = "";
        setResetDigits(next);
        setResetCode(next.join(""));
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      otpInputsRef.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < 5) {
      otpInputsRef.current[index + 1]?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    const next = Array(6).fill("");
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setResetDigits(next);
    setResetCode(next.join(""));
    const focusTarget = Math.min(pasted.length, 5);
    otpInputsRef.current[focusTarget]?.focus();
  }

  const { data: authRequirements, isLoading: loadingRequirements } = useQuery<AuthRequirements>({
    queryKey: ["auth-requirements"],
    queryFn: async () => (await api.get<AuthRequirements>("/auth/requirements")).data,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const mfaRequired = authRequirements?.mfa_required ?? false;
  const submitLabel = loadingRequirements
    ? "Checking sign-in..."
    : mfaRequired
      ? "Continue → MFA"
      : "Sign In";

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    if (showRecaptcha && !RECAPTCHA_DEMO_BYPASS && !recaptchaToken) {
      toast.warning("Please tick \"I'm not a robot\" before signing in.");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post<LoginResponse>("/auth/login", {
        username,
        password,
        recaptcha_token: showRecaptcha ? (RECAPTCHA_DEMO_BYPASS ? "demo-recaptcha-bypass" : recaptchaToken) : undefined,
      });

      // If both MFA methods are disabled, the backend returns a token directly
      if (data.token && data.user) {
        const { setSession } = useAuthStore.getState();
        setSession(data.token, data.user, data.expires_in != null ? Math.max(1, Math.round(data.expires_in / 60)) : null);
        toast.success(`Welcome, ${data.user.full_name}.`);
        window.location.assign("/dashboard");
        return;
      }

      // MFA required — store challenge and route to the correct step
      sessionStorage.setItem("armory_challenge", data.challenge_token!);
      // Sign-in sessions are short-lived; remember when this one ends so later steps can warn the user.
      sessionStorage.setItem("armory_challenge_expires_at", String(Date.now() + (data.challenge_expires_in ?? 300) * 1000));
      sessionStorage.setItem("armory_username", data.username ?? (data.user?.username || username));
      sessionStorage.setItem("armory_next_step", data.next ?? "totp_setup");
      sessionStorage.setItem("armory_totp_enabled", data.totp_enabled ? "1" : "0");
      sessionStorage.setItem("armory_biometric_enrolled", data.biometric_enrolled ? "1" : "0");

      if (data.next === "biometric" || data.next === "biometric_enroll") {
        toast.success("Password verified — proceed to biometric.");
        router.push("/login/biometric");
      } else {
        toast.success("Password verified — proceed to MFA.");
        router.push("/login/totp");
      }
    } catch (error: unknown) {
      // A reCAPTCHA token works once; make the user tick the box again for the next attempt.
      recaptchaRef.current?.reset();
      if (error instanceof AxiosError) {
        if (error.response?.status === 429 && error.response.data?.recaptcha_required) {
          setShowRecaptcha(true);
          toast.warning("Too many failed attempts. Additional verification is required to retry.");
        } else {
          toast.error(error.response?.data?.message ?? "Login failed.");
        }
      } else {
        toast.error(error instanceof Error ? error.message : "Login failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  // Step 1: Request reset code
  async function submitForgotRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!resetIdentifier.trim()) {
      toast.warning("Please provide your username or email address.");
      return;
    }
    setForgotLoading(true);
    try {
      const { data } = await api.post<ForgotPasswordResponse>("/auth/forgot-password", {
        identifier: resetIdentifier.trim(),
      });
      setResetToken(data.reset_token);
      setMaskedEmail(data.masked_email);
      setResendCooldown(60);
      setResetCode("");
      setResetDigits(Array(6).fill(""));
      setMode("forgot_verify");
      toast.success(data.message || "Verification code dispatched.");
    } catch (error: unknown) {
      if (error instanceof AxiosError) {
        toast.error(error.response?.data?.message ?? "Unable to request password reset.");
      } else {
        toast.error(error instanceof Error ? error.message : "Request failed.");
      }
    } finally {
      setForgotLoading(false);
    }
  }

  // Resend verification code
  async function handleResendCode() {
    if (resendCooldown > 0 || !resetIdentifier.trim()) return;
    setForgotLoading(true);
    try {
      const { data } = await api.post<ForgotPasswordResponse>("/auth/forgot-password", {
        identifier: resetIdentifier.trim(),
      });
      setResetToken(data.reset_token);
      setMaskedEmail(data.masked_email);
      setResendCooldown(60);
      setResetCode("");
      setResetDigits(Array(6).fill(""));
      setTimeout(() => otpInputsRef.current[0]?.focus(), 50);
      toast.success(data.message || "A new verification code has been dispatched.");
    } catch (error: unknown) {
      if (error instanceof AxiosError) {
        toast.error(error.response?.data?.message ?? "Failed to resend code.");
      } else {
        toast.error("Failed to resend verification code.");
      }
    } finally {
      setForgotLoading(false);
    }
  }

  // Step 2: Verify 6-digit code before allowing new password input
  async function submitVerifyCode(e: React.FormEvent) {
    e.preventDefault();

    if (!resetCode.trim() || resetCode.trim().length !== 6) {
      toast.warning("Please enter the complete 6-digit verification code.");
      return;
    }

    setForgotLoading(true);
    try {
      const { data } = await api.post<VerifyResetCodeResponse>("/auth/verify-reset-code", {
        reset_token: resetToken,
        code: resetCode.trim(),
      });
      toast.success(data.message || "Code confirmed. You may now set your new password.");
      setMode("forgot_new_password");
    } catch (error: unknown) {
      if (error instanceof AxiosError) {
        toast.error(error.response?.data?.message ?? "Invalid or expired verification code.");
      } else {
        toast.error("Code verification failed.");
      }
    } finally {
      setForgotLoading(false);
    }
  }

  // Step 3: Set new password
  async function submitResetPassword(e: React.FormEvent) {
    e.preventDefault();

    if (newPassword.length < 10) {
      toast.warning("New password must be at least 10 characters long.");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("Password confirmation does not match.");
      return;
    }

    setForgotLoading(true);
    try {
      const { data } = await api.post<ResetPasswordResponse>("/auth/reset-password", {
        reset_token: resetToken,
        code: resetCode.trim(),
        new_password: newPassword,
        new_password_confirmation: confirmPassword,
      });

      toast.success(data.message || "Password updated successfully!");

      // Transition back to login prefilled with the username
      if (data.username) {
        setUsername(data.username);
      } else if (!resetIdentifier.includes("@")) {
        setUsername(resetIdentifier);
      }
      setPassword("");
      setResetCode("");
      setResetDigits(Array(6).fill(""));
      setNewPassword("");
      setConfirmPassword("");
      setMode("login");
    } catch (error: unknown) {
      if (error instanceof AxiosError) {
        toast.error(error.response?.data?.message ?? "Password reset failed.");
      } else {
        toast.error(error instanceof Error ? error.message : "Password reset failed.");
      }
    } finally {
      setForgotLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left — brand panel */}
      <div className="hidden lg:flex relative items-center justify-center p-12 overflow-hidden border-r border-olive-700/30">
        <div className="absolute inset-0 bg-armory-radial" />
        <div className="absolute inset-0 bg-tactical-grid bg-[length:48px_48px] opacity-30" />
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="relative max-w-md text-center"
        >
          <div className="mx-auto mb-7 flex h-36 w-36 items-center justify-center">
            <BrandLogo size={132} className="object-contain" priority />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-olive-50">
            ArmoryDB
          </h1>
          <p className="mt-1 text-sm uppercase tracking-[0.4em] text-olive-300">
            10th RCDG · Reserve Command
          </p>
          <p className="mt-6 text-steel-300 leading-relaxed">
            IoT-Based Firearm Accountability and Monitoring System with GPS, Geofencing, and
            Biometric Authentication.
            QR identification and tamper-evident audit trails.
          </p>
        </motion.div>
      </div>

      {/* Right — dynamic authentication panel */}
      <div className="flex items-center justify-center p-6">
        <div className="glass w-full max-w-md rounded-2xl p-8 overflow-hidden">
          <AnimatePresence mode="wait">
            {/* VIEW 1: SIGN IN */}
            {mode === "login" && (
              <motion.form
                key="login-form"
                onSubmit={submitLogin}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: 0.25 }}
              >
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-olive-50">Authenticate</h2>
                  <p className="text-sm text-steel-400">Enter your credentials to begin.</p>
                </div>

                {/* Username or Email Input */}
                <label className="block text-xs uppercase tracking-widest text-olive-300 mb-1">
                  Username or Email
                </label>
                <div className="relative mb-4">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-steel-400" />
                  <input
                    required
                    autoFocus
                    autoComplete="username"
                    className="input-field pl-9"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="username or email@domain.com"
                    tabIndex={1}
                  />
                </div>

                {/* Password Input + Forgot Password Action */}
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs uppercase tracking-widest text-olive-300">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (username) setResetIdentifier(username);
                      setMode("forgot_request");
                    }}
                    tabIndex={3}
                    className="text-xs text-olive-400 hover:text-olive-200 transition-colors focus:outline-none underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative mb-2">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-steel-400" />
                  <input
                    required
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    className="input-field pl-9 pr-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    tabIndex={2}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-steel-400 hover:text-olive-300 transition-colors p-1"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                {showRecaptcha && (
                  <div className="mt-3 mb-2 rounded-md border border-amber-700/40 bg-amber-900/20 p-3 text-xs text-amber-200 text-center leading-relaxed space-y-3">
                    <p>Multiple failed attempts detected. Please confirm you are not a robot to continue.</p>
                    {RECAPTCHA_DEMO_BYPASS ? null : RECAPTCHA_SITE_KEY ? (
                      <RecaptchaCheckbox ref={recaptchaRef} siteKey={RECAPTCHA_SITE_KEY} onChange={setRecaptchaToken} />
                    ) : (
                      <p className="text-red-300">reCAPTCHA is not configured. Contact the system administrator.</p>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || (showRecaptcha && !RECAPTCHA_DEMO_BYPASS && !recaptchaToken)}
                  className="btn-primary w-full mt-6"
                  tabIndex={4}
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitLabel}
                </button>

                <p className="mt-6 text-center text-[11px] uppercase tracking-widest text-steel-500">
                  Authorized personnel only · all actions audited
                </p>
              </motion.form>
            )}

            {/* VIEW 2: FORGOT PASSWORD - STEP 1 (REQUEST CODE) */}
            {mode === "forgot_request" && (
              <motion.form
                key="forgot-request-form"
                onSubmit={submitForgotRequest}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.25 }}
              >
                <button
                  type="button"
                  onClick={() => setMode("login")}
                  className="inline-flex items-center gap-1.5 text-xs text-steel-400 hover:text-olive-300 transition-colors mb-4 focus:outline-none"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Back to Sign In</span>
                </button>

                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-olive-50">Account Recovery</h2>
                  <p className="text-sm text-steel-400 mt-1">
                    Enter your username or registered email address to receive an authentication code.
                  </p>
                </div>

                <label className="block text-xs uppercase tracking-widest text-olive-300 mb-1">
                  Username or Email
                </label>
                <div className="relative mb-6">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-steel-400" />
                  <input
                    required
                    autoFocus
                    type="text"
                    className="input-field pl-9"
                    value={resetIdentifier}
                    onChange={(e) => setResetIdentifier(e.target.value)}
                    placeholder="username or email@domain.com"
                  />
                </div>

                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="btn-primary w-full"
                >
                  {forgotLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  Request Recovery Code
                </button>

                <p className="mt-6 text-center text-[11px] text-steel-500">
                  Secured via cryptographic one-time token · 15 minute expiration
                </p>
              </motion.form>
            )}

            {/* VIEW 3: FORGOT PASSWORD - STEP 2 (CONFIRM 6-DIGIT CODE) */}
            {mode === "forgot_verify" && (
              <motion.form
                key="forgot-verify-form"
                onSubmit={submitVerifyCode}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.25 }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setResetDigits(Array(6).fill(""));
                    setResetCode("");
                    setMode("forgot_request");
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-steel-400 hover:text-olive-300 transition-colors mb-4 focus:outline-none"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Change Identifier</span>
                </button>

                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-olive-50">Confirm Verification Code</h2>
                  <p className="text-sm text-steel-400 mt-1">
                    Enter the 6-digit authorization code dispatched to{" "}
                    <span className="font-mono text-olive-200">{maskedEmail || resetIdentifier}</span>.
                  </p>
                  <div className="mt-3 rounded-md border border-yellow-700/40 bg-yellow-900/20 px-3 py-2.5 text-center">
                    <p className="text-xs text-yellow-300/80 leading-relaxed text-center">
                      If you don&apos;t see the email in your inbox, please check your{" "}
                      <span className="font-semibold text-yellow-200">Spam</span> or{" "}
                      <span className="font-semibold text-yellow-200">Junk</span> folder.
                    </p>
                  </div>
                </div>

                {/* 6-digit Code Input */}
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs uppercase tracking-widest text-olive-300">
                    6-Digit Code
                  </label>
                  <button
                    type="button"
                    disabled={resendCooldown > 0 || forgotLoading}
                    onClick={handleResendCode}
                    className="text-[11px] text-olive-400 hover:text-olive-200 disabled:opacity-40 disabled:hover:text-olive-400 transition-colors focus:outline-none"
                  >
                    {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
                  </button>
                </div>
                <div
                  className="grid grid-cols-6 gap-2 sm:gap-2.5 mb-6"
                  onPaste={handleOtpPaste}
                >
                  {resetDigits.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => {
                        otpInputsRef.current[i] = el;
                      }}
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => handleOtpChange(i, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(i, e)}
                      className="input-field text-center text-xl sm:text-2xl font-mono font-bold h-12 sm:h-14 px-0 selection:bg-transparent"
                    />
                  ))}
                </div>

                <button
                  type="submit"
                  disabled={forgotLoading || resetCode.length !== 6}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {forgotLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  Confirm Code
                </button>

                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setResetDigits(Array(6).fill(""));
                      setResetCode("");
                      setMode("login");
                    }}
                    className="text-xs text-steel-400 hover:text-olive-300 transition-colors"
                  >
                    Cancel and return to Sign In
                  </button>
                </div>
              </motion.form>
            )}

            {/* VIEW 4: FORGOT PASSWORD - STEP 3 (SET NEW PASSWORD) */}
            {mode === "forgot_new_password" && (
              <motion.form
                key="forgot-new-password-form"
                onSubmit={submitResetPassword}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.25 }}
              >
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-olive-50">Set New Password</h2>
                  <p className="text-sm text-steel-400 mt-1">
                    Create a new secure password for{" "}
                    <span className="font-mono text-olive-200">{maskedEmail || resetIdentifier}</span>.
                  </p>
                </div>

                {/* New Password Input */}
                <label className="block text-xs uppercase tracking-widest text-olive-300 mb-1">
                  New Password
                </label>
                <div className="relative mb-4">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-steel-400" />
                  <input
                    required
                    autoFocus
                    type={showNewPassword ? "text" : "password"}
                    autoComplete="new-password"
                    className="input-field pl-9 pr-10 text-sm"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 10 characters"
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

                {/* Confirm Password Input */}
                <label className="block text-xs uppercase tracking-widest text-olive-300 mb-1">
                  Confirm New Password
                </label>
                <div className="relative mb-6">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-steel-400" />
                  <input
                    required
                    type={showConfirmPassword ? "text" : "password"}
                    autoComplete="new-password"
                    className="input-field pl-9 pr-10 text-sm"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
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

                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="btn-primary w-full"
                >
                  {forgotLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  Update Password & Sign In
                </button>

                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={() => setMode("login")}
                    className="text-xs text-steel-400 hover:text-olive-300 transition-colors"
                  >
                    Cancel and return to Sign In
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
