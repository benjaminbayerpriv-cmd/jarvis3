using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace UiMap;

internal readonly record struct PixelRect(int X, int Y, int Width, int Height)
{
    [JsonIgnore]
    public Rectangle Bounds => new(X, Y, Width, Height);

    public static PixelRect From(Rectangle rect) => new(rect.X, rect.Y, rect.Width, rect.Height);
}

internal sealed record Target(string Id, string Role, string Label, PixelRect Rect, bool Enabled, string Source);
internal sealed record WindowRef(long Handle, uint Pid, long Started, PixelRect Rect)
{
    [JsonIgnore]
    public IntPtr Hwnd => new(Handle);
}

internal sealed record Entry(Target Target, WindowRef Window, int[]? RuntimeId, int ControlType);
internal sealed record Snapshot(int Version, Entry[] Entries);

internal static class Program
{
    private const int SnapshotVersion = 1;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [MTAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 0 || args is ["--help" or "-h"])
        {
            Console.WriteLine("uimap scan --app <exe or window title> [--screen] [--overlay]");
            Console.WriteLine("uimap click <id> | type <id> <text> | scroll <id> <dy> | focus <id>");
            return args.Length == 0 ? 2 : 0;
        }

        try
        {
            return Run(args);
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException
            or JsonException or UnauthorizedAccessException or NotSupportedException or COMException
            or System.ComponentModel.Win32Exception or TimeoutException)
        {
            // A provider error during SetValue could contain the submitted text.
            string message = args[0] == "type" && error is not ArgumentException and not InvalidOperationException
                ? $"Text operation failed (0x{error.HResult:X8})."
                : error.Message;
            Console.Error.WriteLine($"uimap: {message}");
            return error is ArgumentException ? 2 : 1;
        }
    }

    private static int Run(string[] args)
    {
        string? app = null;
        bool screen = false, overlay = false;
        int delta = 0;
        if (args[0] == "scan")
        {
            for (int i = 1; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--app" when app == null && i + 1 < args.Length && !args[i + 1].StartsWith("--"):
                        app = args[++i];
                        break;
                    case "--screen" when !screen:
                        screen = true;
                        break;
                    case "--overlay" when !overlay:
                        overlay = true;
                        break;
                    default:
                        throw new ArgumentException($"Unexpected scan argument: {args[i]}");
                }
            }
            if (string.IsNullOrWhiteSpace(app))
                throw new ArgumentException("scan requires --app <exe or window title>.");
        }
        else if (args is ["scroll", _, var dy])
        {
            if (!int.TryParse(dy, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out delta))
                throw new ArgumentException("dy must be a signed 32-bit integer in wheel units.");
        }
        else if (args is not ["click" or "focus", _] and not ["type", _, _])
        {
            throw new ArgumentException("Invalid command or argument count. See uimap --help.");
        }

        Native.UsePhysicalPixels();
        int session = Process.GetCurrentProcess().SessionId;
        if (session == 0)
            throw new InvalidOperationException("Run uimap in the signed-in user's interactive Windows session.");
        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Jarvis", "uimap", session.ToString(CultureInfo.InvariantCulture));
        Directory.CreateDirectory(folder);
        string path = Path.Combine(folder, "scan.json");

        Target[]? targets = null;
        using (var gate = new Mutex(false, $@"Local\Jarvis.uimap.{session}"))
        {
            try
            {
                if (!gate.WaitOne(TimeSpan.FromSeconds(15)))
                    throw new TimeoutException("Another uimap command is still running.");
            }
            catch (AbandonedMutexException)
            {
                // The previous process exited. Snapshot publication uses an atomic rename.
            }
            try
            {
                using var automation = new Accessibility();
                if (app != null)
                {
                    // Starting a scan invalidates the previous IDs even if the new scan fails.
                    File.Delete(path);
                    var entries = Scan(app, screen, automation);
                    string temporary = path + ".tmp";
                    try
                    {
                        File.WriteAllText(temporary, JsonSerializer.Serialize(new Snapshot(SnapshotVersion, entries), Json));
                        File.Move(temporary, path, true);
                    }
                    finally { File.Delete(temporary); }

                    targets = entries.Select(entry => entry.Target).ToArray();
                    Console.WriteLine(JsonSerializer.Serialize(targets, Json));
                }
                else
                {
                    if (!File.Exists(path))
                        throw new InvalidOperationException("No current scan. Run uimap scan first.");
                    var snapshot = JsonSerializer.Deserialize<Snapshot>(File.ReadAllText(path), Json);
                    var entry = snapshot?.Version == SnapshotVersion
                        ? snapshot.Entries.FirstOrDefault(item => item.Target.Id == args[1])
                        : null;
                    if (entry == null)
                        throw new InvalidOperationException("Unknown or expired ID. Run uimap scan again.");
                    automation.Act(entry, args[0], args[0] == "type" ? args[2] : null, delta);
                }
            }
            finally { gate.ReleaseMutex(); }
        }

        if (overlay && targets is { Length: > 0 })
        {
            Console.Out.Flush();
            Overlay.ShowTargets(targets);
        }
        return 0;
    }

    private static Entry[] Scan(string app, bool screen, Accessibility automation)
    {
        var windows = Native.Windows();
        var anchor = Native.SelectWindow(windows, app);
        var monitor = Native.Monitor(anchor.Hwnd);
        Rectangle region = screen ? monitor.Bounds : anchor.Rect.Bounds;
        var entries = new List<Entry>();
        var passwordRects = new List<Rectangle>();
        var seenWindows = new HashSet<long>();

        foreach (var window in screen ? windows : [anchor])
        {
            Rectangle clip = Rectangle.Intersect(region, window.Rect.Bounds);
            if (clip.Width < 3 || clip.Height < 3) continue;
            if (automation.Collect(window, clip, entries, passwordRects))
                seenWindows.Add(window.Handle);
        }

        try
        {
            foreach (var rect in Capture.Detect(screen ? monitor.Handle : anchor.Hwnd, screen, region, passwordRects))
            {
                if (passwordRects.Any(rect.IntersectsWith) || entries.Any(e => VisualEdges.Similar(rect, e.Target.Rect.Bounds)))
                    continue;
                var owner = screen ? windows.FirstOrDefault(w => w.Hwnd == Native.WindowAt(Native.Center(rect))) : anchor;
                if (owner is null || !owner.Rect.Bounds.Contains(rect) || !Native.IsCurrent(owner))
                    continue;
                entries.Add(new Entry(new Target("", "visual", "Mögliche Taste", PixelRect.From(rect), true, "visual"),
                    owner, null, 0));
            }
        }
        catch (Exception e) when (e is COMException or NotSupportedException or InvalidOperationException or TimeoutException
            or ArgumentException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"uimap: Windows Graphics Capture unavailable: {e.Message}");
            if (seenWindows.Count == 0)
                throw new InvalidOperationException("Neither UI Automation nor the visual fallback could scan the target.");
        }

        string generation = Guid.NewGuid().ToString("N");
        return entries.OrderBy(e => e.Target.Rect.Y).ThenBy(e => e.Target.Rect.X)
            .Select((entry, index) => entry with { Target = entry.Target with { Id = $"{generation}:{index + 1}" } })
            .ToArray();
    }
}
