using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace ArmoryBiometricBridge
{
    /*
     * ArmoryDB biometric bridge
     * =========================
     * Local HTTP service on 127.0.0.1:8787 used by frontend/src/app/login/biometric/page.tsx.
     *
     *   GET  /health   -> 200 when a reader is connected, 503 otherwise
     *   POST /capture  {username, challenge_token, mode: "enroll" | "verify"}
     *                  -> {template, signature, captured_at, mode}
     *
     * "template" is the user's enrollment token (see EnrollmentStore), released only
     * after a successful 1:1 fingerprint match. "signature" is the attestation the
     * backend checks in AuthController::biometricVerify:
     *   HMAC-SHA256(hmac_secret, challenge_token|username|captured_at|sha256hex(template))
     */
    internal static class Program
    {
        private static BridgeSettings _settings;
        private static EnrollmentStore _store;
        private static FingerprintReader Reader;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static readonly ConcurrentDictionary<string, List<DateTime>> Failures =
            new ConcurrentDictionary<string, List<DateTime>>(StringComparer.OrdinalIgnoreCase);
        private static readonly Regex UsernamePattern = new Regex(@"^[A-Za-z0-9._@\-]{1,100}$");

        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.Title = "ArmoryDB Biometric Bridge";

            try
            {
                var baseDir = AppDomain.CurrentDomain.BaseDirectory;
                _settings = BridgeSettings.Load(Path.Combine(baseDir, "bridge.settings.json"));
                _store = new EnrollmentStore(_settings.DataDirectory);
                Reader = new FingerprintReader(_settings.CapturePriority);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[config] " + ex.Message);
                return 2;
            }

            if (args.Length > 0 && args[0] == "--test")
            {
                /* Diagnostics: the SDK's COM callbacks can swallow errors, so surface every exception. */
                AppDomain.CurrentDomain.FirstChanceException += (s, e) =>
                    Console.WriteLine("[exception] " + e.Exception.GetType().Name + ": " + e.Exception.Message);
                Console.WriteLine($"[diag] process is {(Environment.Is64BitProcess ? "64" : "32")}-bit, apartment={System.Threading.Thread.CurrentThread.GetApartmentState()}");
            }
            if (args.Length > 0 && args[0] == "--test") return RunSelfTest(args.Length > 1 ? args[1] : "bridge-test");
            if (args.Length > 1 && args[0] == "--reset")
            {
                Console.WriteLine(_store.Delete(args[1])
                    ? $"[reset] enrollment for '{args[1]}' deleted"
                    : $"[reset] no enrollment for '{args[1]}'");
                return 0;
            }

            return RunServer();
        }

        /* ------------------------------------------------------------------ server */

        private static int RunServer()
        {
            Console.WriteLine("=== ArmoryDB Biometric Bridge (DigitalPersona U.are.U) ===");
            PrintReaders();
            Console.WriteLine($"[store] {_store.DirectoryPath}");
            Console.WriteLine($"[cors]  {string.Join(", ", _settings.AllowedOrigins)}");

            var listener = new TcpListener(IPAddress.Loopback, _settings.Port);
            try
            {
                listener.Start();
            }
            catch (SocketException ex)
            {
                Console.Error.WriteLine($"[http] cannot listen on 127.0.0.1:{_settings.Port} - {ex.Message}. Is another bridge already running?");
                return 1;
            }

            Console.WriteLine($"[http]  listening on http://127.0.0.1:{_settings.Port}  (Ctrl+C to stop)");

            while (true)
            {
                var client = listener.AcceptTcpClient();
                Task.Run(() => HandleClient(client));
            }
        }

        private static void PrintReaders()
        {
            List<FingerprintReader.ReaderInfo> readers;
            try
            {
                readers = Reader.ListReaders();
            }
            catch (CaptureException ex)
            {
                // Keep serving: the website then shows this reason instead of "bridge not running".
                Console.WriteLine("[reader] ERROR: " + ex.Message);
                return;
            }
            if (readers.Count == 0)
            {
                Console.WriteLine("[reader] none connected - plug in the U.are.U reader");
                return;
            }
            foreach (var r in readers) Console.WriteLine($"[reader] {r.Vendor} {r.Product}  serial={r.Serial}");
        }

        private sealed class Request
        {
            public string Method;
            public string Path;
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public string Body = "";
            public string Origin => Headers.TryGetValue("Origin", out var o) ? o.TrimEnd('/') : null;
        }

        private static void HandleClient(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 10000;
                    var stream = client.GetStream();
                    var req = ReadRequest(stream);
                    if (req == null) return;

                    var allowedOrigin = req.Origin != null && _settings.AllowedOrigins.Contains(req.Origin, StringComparer.OrdinalIgnoreCase)
                        ? req.Origin
                        : null;

                    if (req.Method == "OPTIONS")
                    {
                        Write(stream, allowedOrigin != null ? 204 : 403, null, allowedOrigin, preflight: true);
                        return;
                    }

                    if (req.Method == "GET" && req.Path == "/health")
                    {
                        List<FingerprintReader.ReaderInfo> readers;
                        try
                        {
                            readers = Reader.ListReaders();
                        }
                        catch (CaptureException ex)
                        {
                            Write(stream, 503, new Dictionary<string, object>
                            {
                                ["status"] = "sdk_unavailable",
                                ["reader_connected"] = false,
                                ["message"] = ex.Message,
                                ["sdk"] = "DigitalPersona One Touch for Windows 1.4",
                            }, allowedOrigin);
                            return;
                        }
                        Write(stream, readers.Count > 0 ? 200 : 503, new Dictionary<string, object>
                        {
                            ["status"] = readers.Count > 0 ? "ok" : "no_reader",
                            ["reader_connected"] = readers.Count > 0,
                            ["readers"] = readers.Select(r => $"{r.Vendor} {r.Product}".Trim()).ToArray(),
                            ["message"] = readers.Count > 0
                                ? "Fingerprint reader ready."
                                : "No fingerprint reader is connected. Plug in the U.are.U reader and try again.",
                            ["sdk"] = "DigitalPersona One Touch for Windows 1.4",
                        }, allowedOrigin);
                        return;
                    }

                    if (req.Method == "GET" && req.Path == "/status")
                    {
                        /* Live capture progress for the login page. Same origin rule as /capture. */
                        if (allowedOrigin == null)
                        {
                            Write(stream, 403, Error("Origin not allowed."), null);
                            return;
                        }
                        Write(stream, 200, CaptureProgress.Snapshot(), allowedOrigin);
                        return;
                    }

                    if (req.Method == "POST" && req.Path == "/capture")
                    {
                        /* Browsers always send Origin on this request; refusing unknown ones
                         * stops an arbitrary web page from driving the reader. */
                        if (allowedOrigin == null)
                        {
                            Write(stream, 403, Error("Origin not allowed."), null);
                            return;
                        }
                        var (status, body) = HandleCapture(req.Body);
                        Write(stream, status, body, allowedOrigin);
                        return;
                    }

                    Write(stream, 404, Error("Not found."), allowedOrigin);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[http] " + ex.Message);
                }
            }
        }

        private static (int, object) HandleCapture(string body)
        {
            Dictionary<string, object> input;
            try { input = Json.Deserialize<Dictionary<string, object>>(body) ?? new Dictionary<string, object>(); }
            catch { return (400, Error("Body must be JSON.")); }

            var username = Convert.ToString(input.TryGetValue("username", out var u) ? u : null)?.Trim();
            var challenge = Convert.ToString(input.TryGetValue("challenge_token", out var c) ? c : null);
            var mode = Convert.ToString(input.TryGetValue("mode", out var m) ? m : null) ?? "verify";

            if (string.IsNullOrEmpty(username) || !UsernamePattern.IsMatch(username)) return (400, Error("Invalid username."));
            if (string.IsNullOrEmpty(challenge) || challenge.Length > 512) return (400, Error("Invalid challenge token."));
            if (mode != "enroll" && mode != "verify") return (400, Error("mode must be 'enroll' or 'verify'."));

            if (IsLockedOut(username))
                return (429, Error($"Too many failed fingerprint attempts. Wait {_settings.LockoutSeconds / 60} minutes and try again."));

            Action<string> log = line => Console.WriteLine($"[{username}] {line}");

            try
            {
                EnrollmentStore.Record record;

                if (mode == "enroll")
                {
                    log("enrollment started");
                    var template = Reader.Enroll(TimeSpan.FromSeconds(_settings.EnrollTimeoutSeconds), log);
                    record = _store.Save(username, template);
                    log("enrolled and saved");
                }
                else
                {
                    record = _store.Load(username);
                    if (record == null)
                    {
                        return (404, Error(
                            "This fingerprint is not enrolled on this workstation. Ask an administrator to reset your biometric so you can enroll again."));
                    }

                    log("verification started");
                    if (!Reader.Verify(record.Template, TimeSpan.FromSeconds(_settings.VerifyTimeoutSeconds), log))
                    {
                        RecordFailure(username);
                        return (401, Error("Fingerprint does not match. Use your enrolled finger and try again."));
                    }
                    Failures.TryRemove(username, out _);
                }

                var capturedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
                var signature = Crypto.HmacSha256Hex(_settings.HmacSecret,
                    string.Join("|", challenge, username, capturedAt, Crypto.Sha256Hex(record.Token)));

                return (200, new Dictionary<string, object>
                {
                    ["template"] = record.Token,
                    ["signature"] = signature,
                    ["captured_at"] = capturedAt,
                    ["mode"] = mode == "enroll" ? "enrolled" : "verified",
                });
            }
            catch (CaptureException ex)
            {
                log($"{ex.Status}: {ex.Message}");
                return (ex.Status, Error(ex.Message));
            }
            catch (Exception ex)
            {
                log("error: " + ex);
                return (500, Error("Fingerprint reader error: " + ex.Message));
            }
        }

        private static bool IsLockedOut(string username)
        {
            if (!Failures.TryGetValue(username, out var list)) return false;
            lock (list)
            {
                list.RemoveAll(t => (DateTime.UtcNow - t).TotalSeconds > _settings.LockoutSeconds);
                return list.Count >= _settings.MaxFailedVerifications;
            }
        }

        private static void RecordFailure(string username)
        {
            var list = Failures.GetOrAdd(username, _ => new List<DateTime>());
            lock (list) list.Add(DateTime.UtcNow);
        }

        private static Dictionary<string, object> Error(string message) =>
            new Dictionary<string, object> { ["message"] = message };

        /* ------------------------------------------------------------------ minimal HTTP/1.1 */

        private static Request ReadRequest(NetworkStream stream)
        {
            /* Read byte by byte until the blank line that ends the headers. */
            var header = new List<byte>();
            while (true)
            {
                var b = stream.ReadByte();
                if (b == -1 || header.Count > 16 * 1024) return null;
                header.Add((byte) b);
                var n = header.Count;
                if (n >= 4 && header[n - 4] == '\r' && header[n - 3] == '\n' && header[n - 2] == '\r' && header[n - 1] == '\n') break;
            }

            var lines = Encoding.ASCII.GetString(header.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
            var first = lines[0].Split(' ');
            if (first.Length < 2) return null;

            var req = new Request { Method = first[0].ToUpperInvariant(), Path = first[1].Split('?')[0] };
            foreach (var line in lines.Skip(1))
            {
                var i = line.IndexOf(':');
                if (i > 0) req.Headers[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
            }

            if (req.Headers.TryGetValue("Content-Length", out var lenText) && int.TryParse(lenText, out var len) && len > 0)
            {
                if (len > 16 * 1024) return null;
                var buf = new byte[len];
                var read = 0;
                while (read < len)
                {
                    var n = stream.Read(buf, read, len - read);
                    if (n <= 0) return null;
                    read += n;
                }
                req.Body = Encoding.UTF8.GetString(buf);
            }
            return req;
        }

        private static void Write(NetworkStream stream, int status, object body, string allowedOrigin, bool preflight = false)
        {
            var payload = body == null ? new byte[0] : Encoding.UTF8.GetBytes(Json.Serialize(body));
            var sb = new StringBuilder();
            sb.Append($"HTTP/1.1 {status} {Reason(status)}\r\n");
            sb.Append("Cache-Control: no-store\r\n");
            sb.Append("Connection: close\r\n");
            if (body != null) sb.Append("Content-Type: application/json; charset=utf-8\r\n");
            sb.Append($"Content-Length: {payload.Length}\r\n");
            if (allowedOrigin != null)
            {
                sb.Append($"Access-Control-Allow-Origin: {allowedOrigin}\r\n");
                sb.Append("Vary: Origin\r\n");
                if (preflight)
                {
                    sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
                    sb.Append("Access-Control-Allow-Headers: Content-Type\r\n");
                    sb.Append("Access-Control-Allow-Private-Network: true\r\n");
                    sb.Append("Access-Control-Max-Age: 600\r\n");
                }
            }
            sb.Append("\r\n");

            var head = Encoding.ASCII.GetBytes(sb.ToString());
            stream.Write(head, 0, head.Length);
            if (payload.Length > 0) stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }

        private static string Reason(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 204: return "No Content";
                case 400: return "Bad Request";
                case 401: return "Unauthorized";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 408: return "Request Timeout";
                case 409: return "Conflict";
                case 422: return "Unprocessable Entity";
                case 429: return "Too Many Requests";
                case 503: return "Service Unavailable";
                default: return "Internal Server Error";
            }
        }

        /* ------------------------------------------------------------------ self test */

        /// <summary>
        /// bridge --test [username]: enroll a finger, then verify it, entirely on the console.
        /// Uses its own throwaway username so real logins are unaffected.
        /// </summary>
        private static int RunSelfTest(string username)
        {
            Console.WriteLine("=== Biometric bridge self-test ===");
            PrintReaders();
            Action<string> log = Console.WriteLine;

            try
            {
                Console.WriteLine("\nSTEP 1/2 - ENROLL");
                var template = Reader.Enroll(TimeSpan.FromSeconds(_settings.EnrollTimeoutSeconds), log);
                _store.Save(username, template);
                Console.WriteLine($"[ok] enrolled '{username}' ({template.Length} byte template)");

                Console.WriteLine("\nSTEP 2/2 - VERIFY (same finger should MATCH; try another finger to see a rejection)");
                for (var i = 1; i <= 3; i++)
                {
                    Console.WriteLine($"\nattempt {i}/3:");
                    var record = _store.Load(username);
                    Reader.Verify(record.Template, TimeSpan.FromSeconds(_settings.VerifyTimeoutSeconds), log);
                }

                _store.Delete(username);
                Console.WriteLine("\n[ok] self-test finished; test enrollment deleted");
                return 0;
            }
            catch (CaptureException ex)
            {
                Console.Error.WriteLine($"[fail] {ex.Message}");
                return 1;
            }
        }
    }
}
