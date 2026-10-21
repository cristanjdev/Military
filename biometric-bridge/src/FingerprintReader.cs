using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using DPFP;
using DPFP.Capture;
using DPFP.Processing;
using DPFP.Verification;

namespace ArmoryBiometricBridge
{
    /// <summary>Thrown for expected capture outcomes; Status maps straight to the HTTP response.</summary>
    internal sealed class CaptureException : Exception
    {
        public int Status { get; }
        public CaptureException(int status, string message) : base(message) { Status = status; }
    }

    /// <summary>
    /// Wraps the DigitalPersona One Touch for Windows SDK (1.4) capture, enrollment and
    /// verification APIs. One capture session runs at a time; the reader is only held
    /// for the duration of a request.
    /// </summary>
    internal sealed class FingerprintReader
    {
        private readonly object _gate = new object();
        private readonly Priority _priority;
        private bool _busy;
        private Session _current;

        public FingerprintReader(string priority)
        {
            _priority = priority == "high" ? Priority.High : priority == "normal" ? Priority.Normal : Priority.Low;
        }

        public sealed class ReaderInfo
        {
            public string Product;
            public string Vendor;
            public string Serial;
        }

        /// <summary>
        /// Shown when the SDK itself cannot start ("Failed to initialize"). The .NET wrappers load,
        /// but the DigitalPersona runtime they call is missing or its Windows service is stopped.
        /// </summary>
        public const string SdkUnavailableMessage =
            "The DigitalPersona fingerprint service is not running on this computer. " +
            "Restart the computer, or open services.msc and start \"Biometric Authentication Service\" (DpHost). " +
            "If that service is missing, reinstall the One Touch for Windows SDK (Install\\x64\\Setup.exe) and restart.";

        /// <summary>Opens the SDK's reader list, turning an SDK start-up failure into a 503 with the fix.</summary>
        private static ReadersCollection OpenReaders()
        {
            try
            {
                return new ReadersCollection();
            }
            catch (DPFP.Error.SDKException ex)
            {
                throw new CaptureException(503, SdkUnavailableMessage + " (SDK: " + ex.Message + ")");
            }
        }

        public List<ReaderInfo> ListReaders()
        {
            var result = new List<ReaderInfo>();
            var readers = OpenReaders();
            foreach (var r in readers.Values)
            {
                result.Add(new ReaderInfo { Product = r.ProductName, Vendor = r.Vendor, Serial = r.SerialNumber });
            }
            return result;
        }

        /// <summary>
        /// Collects four good-quality touches and returns the serialized template.
        /// Poor-quality touches are ignored and the user simply touches again.
        /// </summary>
        public byte[] Enroll(TimeSpan timeout, Action<string> log)
        {
            using (var session = Begin(timeout))
            {
                var enrollment = new Enrollment();
                var needed = (int) enrollment.FeaturesNeeded;
                log($"[enroll] touch the reader {needed} times, lifting your finger between touches");
                CaptureProgress.Begin("enroll", needed);

                try
                {
                    while (true)
                    {
                        var features = session.NextFeatures(DataPurpose.Enrollment, log);
                        enrollment.AddFeatures(features);
                        var done = needed - (int) enrollment.FeaturesNeeded;

                        switch (enrollment.TemplateStatus)
                        {
                            case Enrollment.Status.Ready:
                                log("[enroll] template created");
                                CaptureProgress.End("done", "Fingerprint enrolled");
                                return enrollment.Template.Bytes;

                            case Enrollment.Status.Failed:
                                /* The four samples did not agree (usually different fingers). */
                                enrollment.Clear();
                                throw new CaptureException(422,
                                    "Enrollment failed: the touches did not match each other. Use the same finger every time and try again.");

                            default:
                                log($"[enroll] good touch - {enrollment.FeaturesNeeded} more needed");
                                CaptureProgress.Update("good",
                                    $"Good scan {done} of {needed} - lift your finger, then touch again", done);
                                break;
                        }
                    }
                }
                catch (Exception ex)
                {
                    CaptureProgress.End("error", ex is CaptureException ? ex.Message : "Fingerprint reader error");
                    throw;
                }
            }
        }

        /// <summary>Captures one good-quality touch and compares it to the enrolled template.</summary>
        public bool Verify(byte[] templateBytes, TimeSpan timeout, Action<string> log)
        {
            var template = new Template();
            template.DeSerialize(templateBytes);

            using (var session = Begin(timeout))
            {
                log("[verify] touch the reader once");
                CaptureProgress.Begin("verify", 1);

                try
                {
                    var features = session.NextFeatures(DataPurpose.Verification, log);
                    CaptureProgress.Update("processing", "Checking fingerprint...");

                    var result = new Verification.Result();
                    new Verification().Verify(features, template, ref result);
                    log($"[verify] {(result.Verified ? "MATCH" : "no match")} (FAR achieved {result.FARAchieved})");

                    if (result.Verified) CaptureProgress.End("done", "Fingerprint matched");
                    else CaptureProgress.End("failed", "Fingerprint does not match");
                    return result.Verified;
                }
                catch (Exception ex)
                {
                    CaptureProgress.End("error", ex is CaptureException ? ex.Message : "Fingerprint reader error");
                    throw;
                }
            }
        }

        private Session Begin(TimeSpan timeout)
        {
            lock (_gate)
            {
                if (_busy)
                {
                    /* A page that was closed or refreshed mid-scan leaves its capture running until it
                     * times out. The newest request wins: cancel the old one and wait for it to let go. */
                    _current?.Cancel();
                    var giveUp = DateTime.UtcNow.AddSeconds(3);
                    while (_busy && DateTime.UtcNow < giveUp) Monitor.Wait(_gate, 100);
                    if (_busy) throw new CaptureException(409, "The fingerprint reader is still busy. Wait a few seconds and try again.");
                }
                if (OpenReaders().Count == 0)
                    throw new CaptureException(503, "No fingerprint reader is connected. Plug in the U.are.U reader and try again.");
                _busy = true;
            }

            try
            {
                var session = new Session(this, timeout, _priority);
                lock (_gate) _current = session;
                return session;
            }
            catch
            {
                lock (_gate) _busy = false;
                throw;
            }
        }

        private void End()
        {
            lock (_gate)
            {
                _busy = false;
                _current = null;
                Monitor.PulseAll(_gate);
            }
        }

        /// <summary>
        /// One capture subscription. The browser has focus, so Priority.Normal (foreground only)
        /// would never see touches. Priority.High needs Administrator rights, so Priority.Low is
        /// used: it receives touches in the background as long as no higher-priority
        /// subscriber holds the reader. Only one Low subscriber is allowed, which matches
        /// the one-capture-at-a-time rule above.
        /// </summary>
        private sealed class Session : DPFP.Capture.EventHandler, IDisposable
        {
            private readonly FingerprintReader _owner;
            private readonly Capture _capture;
            private readonly DateTime _deadline;
            private readonly BlockingCollection<object> _events = new BlockingCollection<object>();

            private sealed class Disconnected { }
            private sealed class Cancelled { }

            /// <summary>Wakes the capture loop so it stops; used when a newer request takes over.</summary>
            public void Cancel() => TryAdd(new Cancelled());

            private readonly Action<string> _trace = line => Console.WriteLine("[reader-event] " + line);

            public Session(FingerprintReader owner, TimeSpan timeout, Priority priority)
            {
                _owner = owner;
                _deadline = DateTime.UtcNow + timeout;
                _capture = new Capture(priority) { EventHandler = this };
                _trace("capture started, priority=" + priority);
                try
                {
                    _capture.StartCapture();
                }
                catch (DPFP.Error.SDKException ex)
                {
                    throw new CaptureException(503,
                        "Could not start the fingerprint reader (" + ex.Message + "). " +
                        "Close any other program using it (DigitalPersona sample apps), unplug and replug the reader, then try again.");
                }
            }

            public FeatureSet NextFeatures(DataPurpose purpose, Action<string> log)
            {
                var extractor = new FeatureExtraction();

                while (true)
                {
                    var remaining = _deadline - DateTime.UtcNow;
                    if (remaining <= TimeSpan.Zero || !_events.TryTake(out var ev, remaining))
                        throw new CaptureException(408, "Timed out waiting for a finger on the reader.");

                    if (ev is Disconnected)
                        throw new CaptureException(503, "The fingerprint reader was disconnected.");
                    if (ev is Cancelled)
                        throw new CaptureException(409, "This capture was replaced by a newer one.");

                    var feedback = CaptureFeedback.None;
                    /* The SDK fills a FeatureSet it is handed; it does not allocate one itself. */
                    var features = new FeatureSet();
                    extractor.CreateFeatureSet((Sample) ev, purpose, ref feedback, ref features);

                    if (feedback == CaptureFeedback.Good) return features;
                    log($"[capture] poor quality ({feedback}) - touch again");
                    CaptureProgress.Update("poor", CaptureProgress.Advice(feedback), feedback: feedback.ToString());
                }
            }

            public void Dispose()
            {
                try { _capture.StopCapture(); } catch { /* reader may already be gone */ }
                _capture.EventHandler = null;
                _events.Dispose();
                _owner.End();
            }

            public void OnComplete(object capture, string readerSerial, Sample sample) { _trace("sample received"); TryAdd(sample); }
            public void OnReaderDisconnect(object capture, string readerSerial) => TryAdd(new Disconnected());
            public void OnFingerGone(object capture, string readerSerial)
            {
                _trace("finger lifted");
                var phase = CaptureProgress.Phase;
                if (phase == "finger_on")
                {
                    /* Lifted before a scan arrived: too quick a tap. */
                    CaptureProgress.Update("waiting", "Too quick - press flat and hold for about a second");
                }
                else if (phase == "good" && CaptureProgress.Done < CaptureProgress.Needed)
                {
                    CaptureProgress.Update("waiting",
                        $"Touch the reader again (scan {CaptureProgress.Done + 1} of {CaptureProgress.Needed})");
                }
            }

            public void OnFingerTouch(object capture, string readerSerial)
            {
                _trace("finger detected");
                CaptureProgress.Update("finger_on", "Scanning - keep your finger still");
            }
            public void OnReaderConnect(object capture, string readerSerial) => _trace("reader connected");
            public void OnSampleQuality(object capture, string readerSerial, CaptureFeedback feedback) => _trace("quality: " + feedback);

            private void TryAdd(object ev)
            {
                try { _events.Add(ev); } catch (ObjectDisposedException) { } catch (InvalidOperationException) { }
            }
        }
    }
}
