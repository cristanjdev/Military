"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore, hasClearance } from "@/store/auth";
import { api, type AuthUser } from "@/lib/api";
import { requiredClearance } from "@/lib/utils";
import { RestrictedPanel } from "@/components/ui/restricted-panel";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { BiometricConfirmHost } from "@/components/biometric/biometric-confirm-host";

// Route-to-role matrix — must stay in sync with sidebar ALL_ITEMS.
// "*" means any authenticated user. Unlisted routes default to "*".
const ROUTE_ROLES: Record<string, string[] | "*"> = {
  "/dashboard":     "*",
  "/firearms":      ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian", "Personnel"],
  "/firearms/new":  ["Administrator", "S4 Officer", "Armory Custodian"],
  "/scan":          ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian"],
  "/transactions":  ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian", "Personnel"],
  "/transactions/new": ["Administrator", "Armory Custodian"],
  "/gps":           ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian"],
  "/geofences":     ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian"],
  "/maintenance":   ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian"],
  "/requests":      ["Administrator", "Command Officer", "S4 Officer"],
  "/notifications": "*",
  "/audit":         ["Administrator", "Command Officer", "S4 Officer"],
  "/users":         ["Administrator", "Command Officer"],
  "/reports":       ["Administrator", "Command Officer", "S4 Officer", "Armory Custodian"],
  "/settings":      "*",
};

function isAllowed(pathname: string, role: string | null | undefined): boolean {
  // Find the matching route prefix (longest match wins)
  const match = Object.keys(ROUTE_ROLES)
    .filter((r) => pathname === r || pathname.startsWith(r + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return true; // unlisted routes default to allowed
  const allowed = ROUTE_ROLES[match];
  if (allowed === "*") return true;
  return !!role && allowed.includes(role);
}

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const loaded = useAuthStore((s) => s.loaded);
  const token  = useAuthStore((s) => s.token);
  const user   = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // The profile saved at sign-in goes stale when an administrator changes this account's role or
  // clearance. Re-read it every minute and on returning to the tab, so menus and page access follow.
  const { data: me } = useQuery({
    queryKey: ["auth-me"],
    queryFn: async () => (await api.get<AuthUser>("/auth/me")).data,
    enabled: loaded && !!token,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!me) return;
    if (!user || me.role !== user.role || me.security_clearance !== user.security_clearance || me.full_name !== user.full_name) {
      updateUser({ ...(user ?? {}), ...me } as AuthUser);
    }
  }, [me, user, updateUser]);

  useEffect(() => {
    if (loaded && !token) router.replace("/login");
  }, [loaded, token, router]);

  useEffect(() => {
    if (loaded && token && user && !isAllowed(pathname, user.role)) {
      router.replace("/dashboard");
    }
  }, [loaded, token, user, pathname, router]);

  if (!loaded) return null;
  if (!token)  return null;
  if (user && !isAllowed(pathname, user.role)) return null;

  // Pages whose API needs a minimum clearance: explain instead of loading (a refused request is
  // also logged on the server as a clearance violation).
  const neededClearance = requiredClearance(pathname);
  const cleared = hasClearance(user, neededClearance);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar mobileOpen={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Topbar onMenuClick={() => setMobileMenuOpen(true)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 lg:px-8 py-6 animate-fade-in">
          {cleared ? children : <RestrictedPanel required={neededClearance} current={user?.security_clearance} />}
        </main>
      </div>
      <BiometricConfirmHost />
    </div>
  );
}
