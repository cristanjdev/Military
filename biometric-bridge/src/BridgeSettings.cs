using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace ArmoryBiometricBridge
{
    /// <summary>
    /// Loaded from bridge.settings.json next to the executable.
    /// hmac_secret must equal BIOMETRIC_BRIDGE_HMAC_SECRET in backend/.env.
    /// </summary>
    internal sealed class BridgeSettings
    {
        public int Port { get; private set; } = 8787;
        public string HmacSecret { get; private set; } = "";
        public List<string> AllowedOrigins { get; private set; } = new List<string>
        {
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://militarygps.vercel.app",
        };
        /// <summary>low (default, no admin needed), normal (foreground only) or high (needs Administrator).</summary>
        public string CapturePriority { get; private set; } = "low";
        public int EnrollTimeoutSeconds { get; private set; } = 90;
        public int VerifyTimeoutSeconds { get; private set; } = 30;
        public int MaxFailedVerifications { get; private set; } = 5;
        public int LockoutSeconds { get; private set; } = 300;
        public string DataDirectory { get; private set; } = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ArmoryDB", "BiometricBridge");

        public static BridgeSettings Load(string path)
        {
            if (!File.Exists(path))
            {
                throw new InvalidOperationException(
                    $"Settings file not found: {path}\n" +
                    "Copy bridge.settings.example.json to bridge.settings.json and set hmac_secret.");
            }

            Dictionary<string, object> raw;
            try
            {
                raw = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            }
            catch (ArgumentException)
            {
                /* The serializer's message embeds the whole file, secret included; never print it. */
                throw new InvalidOperationException(
                    $"{path} is not valid JSON. In paths use forward slashes or doubled backslashes (\\\\).");
            }
            var s = new BridgeSettings();

            if (raw.TryGetValue("port", out var port)) s.Port = Convert.ToInt32(port);
            if (raw.TryGetValue("hmac_secret", out var secret)) s.HmacSecret = Convert.ToString(secret) ?? "";
            if (raw.TryGetValue("capture_priority", out var cp)) s.CapturePriority = (Convert.ToString(cp) ?? "low").Trim().ToLowerInvariant();
            if (raw.TryGetValue("enroll_timeout_seconds", out var et)) s.EnrollTimeoutSeconds = Convert.ToInt32(et);
            if (raw.TryGetValue("verify_timeout_seconds", out var vt)) s.VerifyTimeoutSeconds = Convert.ToInt32(vt);
            if (raw.TryGetValue("max_failed_verifications", out var mf)) s.MaxFailedVerifications = Convert.ToInt32(mf);
            if (raw.TryGetValue("lockout_seconds", out var ls)) s.LockoutSeconds = Convert.ToInt32(ls);
            if (raw.TryGetValue("data_directory", out var dd) && !string.IsNullOrWhiteSpace(Convert.ToString(dd)))
            {
                s.DataDirectory = Environment.ExpandEnvironmentVariables(Convert.ToString(dd));
            }
            if (raw.TryGetValue("allowed_origins", out var origins) && origins is IEnumerable list && !(origins is string))
            {
                s.AllowedOrigins = new List<string>();
                foreach (var o in list) s.AllowedOrigins.Add(Convert.ToString(o).TrimEnd('/'));
            }

            if (s.HmacSecret.Length < 32)
            {
                throw new InvalidOperationException(
                    "hmac_secret must be at least 32 characters and match BIOMETRIC_BRIDGE_HMAC_SECRET in backend/.env.");
            }

            return s;
        }
    }
}
