using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace UiMap;

[JsonConverter(typeof(PixelRectConverter))]
internal readonly record struct PixelRect(int X, int Y, int Width, int Height)
{
    public Rectangle Bounds => new(X, Y, Width, Height);
    public static PixelRect From(Rectangle rect) => new(rect.X, rect.Y, rect.Width, rect.Height);
}

internal sealed class PixelRectConverter : JsonConverter<PixelRect>
{
    public override PixelRect Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray) throw new JsonException("rect must be [x,y,w,h].");
        Span<int> numbers = stackalloc int[4];
        for (int i = 0; i < numbers.Length; i++)
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.Number || !reader.TryGetInt32(out numbers[i]))
                throw new JsonException("rect must be [x,y,w,h].");
        }
        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray ||
            numbers[2] <= 0 || numbers[3] <= 0 ||
            (long)numbers[0] + numbers[2] > int.MaxValue || (long)numbers[1] + numbers[3] > int.MaxValue)
            throw new JsonException("rect must be [x,y,w,h] with positive dimensions.");
        return new(numbers[0], numbers[1], numbers[2], numbers[3]);
    }

    public override void Write(Utf8JsonWriter writer, PixelRect rect, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteNumberValue(rect.X);
        writer.WriteNumberValue(rect.Y);
        writer.WriteNumberValue(rect.Width);
        writer.WriteNumberValue(rect.Height);
        writer.WriteEndArray();
    }
}

internal sealed record Target(int Id, string Role, string AxRole, string Label, PixelRect Rect, bool Enabled, string Source);
internal sealed record WindowRef(long Handle, uint Pid, long Started, PixelRect Rect)
{
    [JsonIgnore]
    public IntPtr Hwnd => new(Handle);
}

internal sealed record Entry(Target Target, WindowRef Window, int[]? RuntimeId, int ControlType, bool Password);
internal sealed record Snapshot(Entry[] Entries, int NextId, int Display);
internal sealed record Request(string? Cmd, int? Id = null, string? Text = null, int? Dy = null,
    PixelRect? Rect = null, bool Marks = false, bool All = false, int? Display = null);

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [MTAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 0 || args is ["--help" or "-h"])
        {
            Console.WriteLine("uimap scan|serve [--app <exe or window title>] [--display <index>] [--screen]");
            Console.WriteLine("scan also accepts --all --text --overlay; other commands: click, type, focus, scroll, read, shot, displays");
            return args.Length == 0 ? 2 : 0;
        }

        try { return Run(args); }
        catch (Exception e) when (IsCommandError(e))
        {
            Console.Error.WriteLine($"uimap: {ErrorMessage(e)}");
            return e is ArgumentException ? 2 : 1;
        }
    }

    private static int Run(string[] args)
    {
        string command = args[0];
        string? app = null;
        bool screen = false, overlay = false, shortList = false, all = false;
        int? display = null;
        Request request;
        if (command is "scan" or "serve")
        {
            for (int i = 1; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--app" when app == null && i + 1 < args.Length && !args[i + 1].StartsWith("--"):
                        app = args[++i];
                        if (string.IsNullOrWhiteSpace(app)) throw new ArgumentException("Missing app name.");
                        break;
                    case "--display" when display == null && i + 1 < args.Length:
                        display = Number(args[++i]);
                        break;
                    case "--screen" when !screen: screen = true; break;
                    case "--overlay" when command == "scan" && !overlay: overlay = true; break;
                    case "--all" when command == "scan" && !all: all = true; break;
                    case "--text" when command == "scan" && !shortList: shortList = true; break;
                    default: throw new ArgumentException($"Unexpected argument: {args[i]}");
                }
            }
            request = new(command, All: all, Display: display);
        }
        else
        {
            request = args switch
            {
                ["click" or "focus" or "read", var id] => new(command, Id: Number(id)),
                ["type", var id, var text] => new(command, Id: Number(id), Text: text),
                ["scroll", var id, var dy] => new(command, Id: Number(id), Dy: Number(dy)),
                ["scroll", var dy] => new(command, Dy: Number(dy)),
                ["read", "--rect", var x, var y, var w, var h] =>
                    new(command, Rect: ParseRect(x, y, w, h)),
                ["shot"] or ["shot", "--marks"] => new(command, Marks: args.Length == 2),
                ["shot", "--rect", var x, var y, var w, var h] =>
                    new(command, Rect: ParseRect(x, y, w, h)),
                ["shot", "--rect", var x, var y, var w, var h, "--marks"] =>
                    new(command, Rect: ParseRect(x, y, w, h), Marks: true),
                ["displays"] => new(command),
                _ => throw new ArgumentException("Invalid command or argument count. See uimap --help.")
            };
        }

        Native.UsePhysicalPixels();
        int windowsSession = Process.GetCurrentProcess().SessionId;
        if (windowsSession == 0)
            throw new InvalidOperationException("Run uimap in the signed-in user's interactive Windows session.");
        using var session = new Session(app, screen, display);
        if (command == "serve") return Serve(session);
        if (command == "displays") { Emit(session.Handle(request, false)); return 0; }

        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Jarvis", "uimap", windowsSession.ToString(CultureInfo.InvariantCulture));
        Directory.CreateDirectory(folder);
        string path = Path.Combine(folder, "latest-v2.json");
        Dictionary<string, object?> reply;
        using (var gate = new Mutex(false, $@"Local\Jarvis.uimap.{windowsSession}"))
        {
            try
            {
                if (!gate.WaitOne(TimeSpan.FromSeconds(30))) throw new TimeoutException("Another uimap command is running.");
            }
            catch (AbandonedMutexException) { }
            try
            {
                if (File.Exists(path))
                    session.Restore(JsonSerializer.Deserialize<Snapshot>(File.ReadAllText(path), Json));
                reply = session.Handle(request, shortList);
                if (command == "scan")
                {
                    string temporary = path + ".tmp";
                    try
                    {
                        File.WriteAllText(temporary, JsonSerializer.Serialize(session.Save(), Json));
                        File.Move(temporary, path, true);
                    }
                    finally { File.Delete(temporary); }
                }
            }
            finally { gate.ReleaseMutex(); }
        }

        if (reply["ok"] is true && shortList) Console.WriteLine(reply["text"]);
        else Emit(reply);
        if (reply["ok"] is not true) return 1;
        if (overlay && reply["targets"] is Target[] { Length: > 0 } targets) Overlay.ShowTargets(targets);
        return 0;
    }

    private sealed record ScanRequest(bool All = false, bool Text = false, int? Display = null);

    internal static int Serve(Session session)
    {
        while (Console.ReadLine() is { } line)
        {
            Dictionary<string, object?> reply;
            JsonElement? rid = null;
            try
            {
                using var json = JsonDocument.Parse(line);
                if (json.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException();
                if (json.RootElement.TryGetProperty("rid", out var value)) rid = value.Clone();
                bool shortList = false;
                var root = json.RootElement;
                if (root.TryGetProperty("cmd", out var cmd) && cmd.ValueKind == JsonValueKind.String &&
                    cmd.GetString() == "scan")
                {
                    var scan = root.Deserialize<ScanRequest>(Json) ?? throw new JsonException();
                    shortList = scan.Text;
                    reply = session.Handle(new Request("scan", All: scan.All, Display: scan.Display), shortList);
                }
                else
                {
                    var request = root.Deserialize<Request>(Json) ?? throw new JsonException();
                    reply = session.Handle(request, false);
                }
            }
            catch (JsonException) { reply = new() { ["ok"] = false, ["error"] = "Invalid JSON request or field type." }; }
            if (rid is { } correlation) reply["rid"] = correlation;
            Emit(reply);
        }
        return 0;
    }

    private static int Number(string value) => int.TryParse(value, NumberStyles.AllowLeadingSign,
        CultureInfo.InvariantCulture, out int number) ? number : throw new ArgumentException("Expected an integer.");

    private static PixelRect ParseRect(string x, string y, string w, string h)
    {
        var numbers = new[] { Number(x), Number(y), Number(w), Number(h) };
        return JsonSerializer.Deserialize<PixelRect>(JsonSerializer.SerializeToElement(numbers), Json);
    }

    private static void Emit(Dictionary<string, object?> value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, Json));
        Console.Out.Flush();
    }

    internal static bool IsCommandError(Exception e) => e is ArgumentException or InvalidOperationException or IOException
        or JsonException or UnauthorizedAccessException or NotSupportedException or COMException
        or System.ComponentModel.Win32Exception or TimeoutException or OverflowException or ExternalException;

    internal static string ErrorMessage(Exception e) =>
        e is COMException ? $"Windows provider error (0x{e.HResult:X8})." : e.Message;
}
