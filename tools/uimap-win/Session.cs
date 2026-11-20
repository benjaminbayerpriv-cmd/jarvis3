using System.Diagnostics;

namespace UiMap;

internal sealed class Session(string? app, bool screen, int? requestedDisplay) : IDisposable
{
    private readonly Accessibility automation = new();
    private Entry[] entries = [];
    private int display = requestedDisplay ?? 0;
    private int nextId;

    public Snapshot Save() => new(entries, nextId, display);

    public void Restore(Snapshot? snapshot)
    {
        if (snapshot == null) return;
        entries = snapshot.Entries;
        nextId = snapshot.NextId;
        display = requestedDisplay ?? snapshot.Display;
    }

    public void Dispose() => automation.Dispose();

    public Dictionary<string, object?> Handle(Request request, bool shortList)
    {
        var reply = new Dictionary<string, object?> { ["ok"] = true };
        try
        {
            switch (request.Cmd)
            {
                case "scan":
                    var watch = Stopwatch.StartNew();
                    entries = [];
                    var scanned = Scan(request.Display, request.All);
                    entries = scanned.Select(entry => entry with
                        { Target = entry.Target with { Id = checked(nextId++) } }).ToArray();
                    reply["targets"] = entries.Select(entry => entry.Target).ToArray();
                    reply["ms"] = watch.ElapsedMilliseconds;
                    if (shortList)
                        reply["text"] = string.Join("\n", entries.Select(entry =>
                        {
                            var t = entry.Target;
                            var center = Native.Center(t.Rect.Bounds);
                            string role = t.AxRole.StartsWith("AX") ? t.AxRole[2..] : t.AxRole;
                            return $"{t.Id} {role} „{t.Label}“ @{center.X},{center.Y}{(t.Enabled ? "" : " (aus)")}";
                        }));
                    break;
                case "click":
                case "type":
                case "focus":
                    if (request.Cmd == "type" && request.Text == null) throw Missing("text");
                    string via = automation.Act(Find(request.Id), request.Cmd, request.Text, 0);
                    if (request.Cmd != "focus") reply["via"] = via;
                    break;
                case "scroll":
                    int dy = request.Dy ?? throw Missing("dy");
                    if (request.Id is { } id)
                        automation.Act(Find(id), "scroll", null, dy);
                    else
                        Native.ScrollAtCursor(dy);
                    break;
                case "read":
                    if ((request.Id == null) == (request.Rect == null))
                        throw new ArgumentException("read requires either id or rect.");
                    var entry = request.Id != null ? Find(request.Id) : null;
                    string? text = null;
                    Rectangle? bounds = request.Rect?.Bounds;
                    if (entry != null)
                        (text, bounds) = automation.Read(entry);
                    reply["text"] = text ?? Capture.ReadText(bounds!.Value, automation);
                    reply["via"] = text != null ? "ax" : "ocr";
                    break;
                case "shot":
                    var rect = request.Rect ?? PixelRect.From(DisplayAt(display).Bounds);
                    reply["path"] = Capture.Screenshot(rect.Bounds, automation,
                        request.Marks ? entries.Select(entry => entry.Target).ToArray() : []);
                    reply["rect"] = rect;
                    break;
                case "displays":
                    reply["displays"] = Native.Displays().Select((d, index) =>
                        new { index, name = d.Name, rect = PixelRect.From(d.Bounds) }).ToArray();
                    break;
                default:
                    throw new ArgumentException("Unknown command.");
            }
            return reply;
        }
        catch (Exception e) when (Program.IsCommandError(e))
        {
            return new() { ["ok"] = false, ["error"] = Program.ErrorMessage(e) };
        }
    }

    private Entry Find(int? id) => entries.FirstOrDefault(entry => entry.Target.Id == id)
        ?? throw new InvalidOperationException("Unknown or expired ID. Run scan first.");

    private static ArgumentException Missing(string name) => new($"Missing {name}.");

    private static DisplayRef DisplayAt(int index)
    {
        var displays = Native.Displays();
        return index >= 0 && index < displays.Length ? displays[index] : throw new ArgumentException("Unknown display index.");
    }

    private Entry[] Scan(int? index, bool all)
    {
        var windows = Native.Windows();
        var anchor = app != null ? Native.SelectWindow(windows, app) : null;
        if (index != null) display = index.Value;
        else if (anchor != null && requestedDisplay == null)
            display = Array.FindIndex(Native.Displays(), d => d.Handle == Native.Monitor(anchor.Hwnd));
        var monitor = DisplayAt(display);
        bool wholeDisplay = screen || anchor == null;
        Rectangle region = wholeDisplay ? monitor.Bounds : anchor!.Rect.Bounds;
        var result = new List<Entry>();
        var passwords = new List<Rectangle>();
        bool anyUi = false;
        long deadline = Stopwatch.GetTimestamp() + 5 * Stopwatch.Frequency;

        foreach (var window in wholeDisplay ? windows : [anchor!])
        {
            Rectangle clip = Rectangle.Intersect(region, window.Rect.Bounds);
            if (clip.Width < 3 || clip.Height < 3) continue;
            if (Stopwatch.GetTimestamp() > deadline)
            {
                Console.Error.WriteLine("uimap: scan time limit reached; returning partial UI Automation results.");
                break;
            }
            anyUi |= automation.Collect(window, clip, result, passwords, all, wholeDisplay, deadline);
        }

        try
        {
            foreach (var rect in Capture.Detect(wholeDisplay ? monitor.Handle : anchor!.Hwnd, wholeDisplay, region, passwords))
            {
                if (passwords.Any(rect.IntersectsWith) || result.Any(e => VisualEdges.Similar(rect, e.Target.Rect.Bounds)))
                    continue;
                var hit = wholeDisplay ? Native.WindowAt(Native.Center(rect)) : IntPtr.Zero;
                var owner = wholeDisplay ? windows.FirstOrDefault(w => w.Hwnd == hit) : anchor;
                if (owner is null || !owner.Rect.Bounds.Contains(rect) || !Native.IsCurrent(owner)) continue;
                result.Add(new Entry(new Target(0, "visual", "Visual", "Mögliche Taste", PixelRect.From(rect), true, "visual"),
                    owner, null, 0, false));
            }
        }
        catch (Exception e) when (Program.IsCommandError(e))
        {
            Console.Error.WriteLine($"uimap: Windows Graphics Capture: {Program.ErrorMessage(e)}");
            if (!anyUi) throw new InvalidOperationException("Neither UI Automation nor graphics capture could scan the target.");
        }

        return result.OrderBy(entry => entry.Target.Rect.Y).ThenBy(entry => entry.Target.Rect.X).ToArray();
    }
}
