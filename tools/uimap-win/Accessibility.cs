using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using FlaUI.UIA3;
using Interop.UIAutomationClient;

namespace UiMap;

internal sealed class Accessibility : IDisposable
{
    private const int NodeLimit = 5000;
    private readonly UIA3Automation owner = new();
    private readonly IUIAutomation automation;
    private readonly IUIAutomationTreeWalker walker;

    public Accessibility()
    {
        owner.ConnectionTimeout = TimeSpan.FromMilliseconds(500);
        owner.TransactionTimeout = TimeSpan.FromMilliseconds(750);
        automation = owner.NativeAutomation;
        walker = automation.RawViewWalker;
    }

    public void Dispose() => owner.Dispose();

    public bool Collect(WindowRef window, Rectangle clip, List<Entry> entries, List<Rectangle> passwords, bool all, bool visibleOnly, long deadline)
    {
        try
        {
            Native.AddNativePasswordRects(window.Hwnd, clip, passwords);
            int previous = entries.Count;
            foreach (var (element, password) in Walk(window, passwords, deadline: deadline))
            {
                try
                {
                    if (element.CurrentIsOffscreen != 0) continue;
                    int kind = element.CurrentControlType;
                    string? role = password ? "field" : Role(element, kind, all);
                    if (role is null) continue;
                    Rectangle rect = Rectangle.Intersect(clip, Bounds(element));
                    if (rect.Width < 3 || rect.Height < 3 ||
                        (visibleOnly && Native.WindowAt(Native.Center(rect)) != window.Hwnd)) continue;
                    var runtimeId = element.GetRuntimeId();
                    if (runtimeId is not { Length: > 0 }) continue;
                    string label = password ? "Passwortfeld" :
                        (ControlType)kind == ControlType.Edit && PasswordStatus(element) is not false ? "Textfeld" :
                        Regex.Replace(element.CurrentName ?? "", @"\s+", " ").Trim();
                    if (label.Length == 0) label = (ControlType)kind switch
                    {
                        ControlType.Button => "Taste",
                        ControlType.CheckBox => "Kontrollkästchen",
                        ControlType.ScrollBar => "Scrollleiste",
                        _ => role switch { "field" => "Textfeld", "link" => "Link", _ => "Bedienelement" }
                    };
                    if (label.Length > 100)
                        label = label[..(char.IsHighSurrogate(label[98]) ? 98 : 99)] + "…";
                    entries.Add(new Entry(new Target(0, role, AxRole(kind, password), label, PixelRect.From(rect),
                        element.CurrentIsEnabled != 0, "ax"), window, runtimeId, kind, password));
                    if (entries.Count - previous >= 600) break;
                }
                catch (COMException) { /* Element disappeared or its provider rejected a property. */ }
            }
            return true;
        }
        catch (Exception e) when (e is COMException or TimeoutException)
        {
            Console.Error.WriteLine($"uimap: UI Automation scan incomplete: {Program.ErrorMessage(e)}");
            return false;
        }
    }

    public string Act(Entry entry, string verb, string? text, int dy)
    {
        if (entry.Password && verb == "type") throw Protected();
        if (!entry.Target.Enabled)
            throw new InvalidOperationException("The target was disabled at scan time.");
        var (current, element, rect) = Resolve(entry);
        if (element?.CurrentIsEnabled == 0)
            throw new InvalidOperationException("The target is disabled.");
        if (verb == "type")
        {
            if (element is null || (ControlType)entry.ControlType != ControlType.Edit ||
                PasswordStatus(element) is not false || IsPassword(element))
                throw new InvalidOperationException("Text requires a UI Automation Edit explicitly marked as non-password.");
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_ValuePatternId) is not IUIAutomationValuePattern value ||
                value.CurrentIsReadOnly != 0)
                throw new InvalidOperationException("The field has no writable ValuePattern.");
            if (PasswordStatus(element) is not false || IsPassword(element)) throw Stale();
            try { value.SetValue(text!); }
            catch (COMException e)
            {
                throw new InvalidOperationException($"ValuePattern rejected the text (0x{e.HResult:X8}).");
            }
            return "ax-value";
        }

        if (verb == "focus")
        {
            if (element != null)
            {
                element.SetFocus();
                if (element.CurrentHasKeyboardFocus == 0)
                    throw new InvalidOperationException("The element did not acquire keyboard focus.");
            }
            else
            {
                Native.FocusWindow(current.Hwnd);
            }
            return "ax";
        }

        if (verb == "click" && element != null)
        {
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_InvokePatternId) is IUIAutomationInvokePattern invoke)
            {
                invoke.Invoke();
                return "ax-invoke";
            }
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_TogglePatternId) is IUIAutomationTogglePattern toggle)
            {
                toggle.Toggle();
                return "ax-toggle";
            }
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_SelectionItemPatternId) is IUIAutomationSelectionItemPattern selection)
            {
                selection.Select();
                return "ax-selection";
            }
        }

        Point point = Native.Center(rect);
        if (Native.WindowAt(point) != current.Hwnd || !CanPointAt(point, element))
            throw new InvalidOperationException("The target point is covered, has changed, or is protected. Scan again.");
        Native.PointerAction(current.Hwnd, point, verb == "click", dy);
        return "mouse";
    }

    public (string? Text, Rectangle Bounds) Read(Entry entry)
    {
        if (entry.Password) throw Protected();
        var (_, element, rect) = Resolve(entry);
        if (element == null) return (null, rect);
        string? text = null;
        try
        {
            if ((ControlType)entry.ControlType == ControlType.Edit)
            {
                if (PasswordStatus(element) is not false || IsPassword(element)) throw Protected();
                if (element.GetCurrentPattern(UIA_PatternIds.UIA_ValuePatternId) is IUIAutomationValuePattern value)
                {
                    if (PasswordStatus(element) is not false || IsPassword(element)) throw Protected();
                    text = value.CurrentValue;
                }
                else if (element.GetCurrentPattern(UIA_PatternIds.UIA_TextPatternId) is IUIAutomationTextPattern document)
                {
                    if (PasswordStatus(element) is not false || IsPassword(element)) throw Protected();
                    text = document.DocumentRange.GetText(4000);
                }
            }
            else if ((ControlType)entry.ControlType is ControlType.Text or ControlType.Button or ControlType.Hyperlink or
                     ControlType.CheckBox or ControlType.RadioButton or ControlType.MenuItem or ControlType.TabItem)
            {
                text = element.CurrentName;
            }
        }
        catch (COMException)
        {
            // The OCR path verifies the capture region again before it sees any text.
            return (null, rect);
        }
        if (string.IsNullOrWhiteSpace(text)) text = null;
        else if (text.Length > 4000) text = text[..(char.IsHighSurrogate(text[3999]) ? 3999 : 4000)];
        return (text, rect);
    }

    public List<Rectangle> ProtectedRegions(Rectangle region)
    {
        var passwords = new List<Rectangle>();
        var watch = Stopwatch.StartNew();
        foreach (var window in Native.Windows(requireIdentity: false))
        {
            if (!window.Rect.Bounds.IntersectsWith(region)) continue;
            if (watch.Elapsed > TimeSpan.FromSeconds(10))
                throw new TimeoutException("Could not verify password protection for the capture region.");
            Native.AddNativePasswordRects(window.Hwnd, region, passwords);
            foreach (var _ in Walk(window, passwords, strict: true)) { }
        }
        return passwords;
    }

    private (WindowRef Window, IUIAutomationElement? Element, Rectangle Rect) Resolve(Entry entry)
    {
        var current = Native.Describe(entry.Window.Hwnd);
        if (current is null || current.Pid != entry.Window.Pid || current.Started != entry.Window.Started)
            throw Stale();
        IUIAutomationElement? element = null;
        Rectangle rect;
        if (entry.RuntimeId is { } id)
        {
            var found = Walk(current).FirstOrDefault(candidate =>
                candidate.Element.GetRuntimeId() is { } runtimeId && runtimeId.SequenceEqual(id));
            element = found.Element;
            if (element == null || element.CurrentControlType != entry.ControlType || element.CurrentIsOffscreen != 0)
                throw Stale();
            if (found.Password && !entry.Password) throw Protected();
            rect = Rectangle.Intersect(Bounds(element), current.Rect.Bounds);
        }
        else
        {
            if (current.Rect != entry.Window.Rect) throw Stale();
            rect = entry.Target.Rect.Bounds;
        }
        if (rect.Width <= 0 || rect.Height <= 0) throw Stale();
        return (current, element, rect);
    }

    private bool CanPointAt(Point point, IUIAutomationElement? expected)
    {
        IUIAutomationElement? hit = automation.ElementFromPoint(new tagPOINT { x = point.X, y = point.Y });
        bool found = expected == null;
        for (int depth = 0; hit != null && depth < 128; depth++, hit = walker.GetParentElement(hit))
        {
            if (IsPassword(hit)) return false;
            if (expected != null && automation.CompareElements(hit, expected) != 0) found = true;
        }
        return hit == null && found;
    }

    private IEnumerable<(IUIAutomationElement Element, bool Password)> Walk(WindowRef window,
        List<Rectangle>? passwords = null, bool strict = false, long deadline = long.MaxValue)
    {
        var root = automation.ElementFromHandle(window.Hwnd);
        if (root == null)
        {
            if (strict) throw new InvalidOperationException("UI Automation could not verify a window in the capture region.");
            yield break;
        }
        var pending = new Stack<(IUIAutomationElement Element, bool IsRoot)>();
        pending.Push((root, true));
        var watch = Stopwatch.StartNew();

        for (int visited = 0; pending.TryPop(out var node); visited++)
        {
            if (visited >= NodeLimit || watch.Elapsed > TimeSpan.FromSeconds(4) || Stopwatch.GetTimestamp() > deadline)
                throw new TimeoutException("UI Automation scan limit reached.");
            var element = node.Element;
            if (!node.IsRoot && walker.GetNextSiblingElement(element) is { } sibling)
                pending.Push((sibling, false));
            bool? status = PasswordStatus(element);
            bool password = status == true || Native.IsPasswordEdit((IntPtr)element.CurrentNativeWindowHandle);
            if (password || (strict && status is null && (ControlType)element.CurrentControlType == ControlType.Edit))
            {
                if (passwords != null && element.CurrentIsOffscreen == 0)
                {
                    var bounds = Bounds(element);
                    if (strict && (bounds.Width <= 0 || bounds.Height <= 0))
                        throw new InvalidOperationException("A protected edit has no usable screen bounds.");
                    passwords.Add(bounds);
                }
                if (password) yield return (element, true);
                continue;
            }
            yield return (element, false);
            if (walker.GetFirstChildElement(element) is { } child)
                pending.Push((child, false));
        }
    }

    private static Rectangle Bounds(IUIAutomationElement element)
    {
        var rect = element.CurrentBoundingRectangle;
        return Rectangle.FromLTRB(rect.left, rect.top, rect.right, rect.bottom);
    }

    private static bool? PasswordStatus(IUIAutomationElement element) =>
        element.GetCurrentPropertyValueEx(UIA_PropertyIds.UIA_IsPasswordPropertyId, 1) switch
        {
            bool value => value,
            short value => value != 0,
            int value => value != 0,
            _ => null
        };

    private static bool IsPassword(IUIAutomationElement element) =>
        PasswordStatus(element) == true || Native.IsPasswordEdit((IntPtr)element.CurrentNativeWindowHandle);

    private static string? Role(IUIAutomationElement element, int type, bool all) => (ControlType)type switch
    {
        ControlType.Edit or ControlType.ComboBox or ControlType.Spinner or ControlType.List => "field",
        ControlType.Hyperlink => "link",
        ControlType.Button or ControlType.CheckBox or ControlType.RadioButton or ControlType.MenuItem or
        ControlType.Slider or ControlType.ScrollBar or ControlType.TabItem or ControlType.ListItem or
        ControlType.TreeItem or ControlType.SplitButton or ControlType.Thumb => "control",
        ControlType.Text or ControlType.Document or ControlType.Pane or ControlType.Group when all => "control",
        _ => element.GetCurrentPropertyValue(UIA_PropertyIds.UIA_IsInvokePatternAvailablePropertyId) is true
            ? "control" : null
    };

    private static string AxRole(int type, bool password) => password ? "AXSecureTextField" : (ControlType)type switch
    {
        ControlType.Edit => "AXTextField",
        ControlType.Hyperlink => "AXLink",
        ControlType.Text => "AXStaticText",
        ControlType.TabItem => "AXTab",
        ControlType.Pane => "AXScrollArea",
        _ => Enum.IsDefined((ControlType)type) ? $"AX{(ControlType)type}" : "AXUnknown"
    };

    private static InvalidOperationException Protected() => new("Passwortfelder sind gesperrt.");
    private static InvalidOperationException Stale() => new("The target changed or is protected. Scan again.");

    // Control type IDs are the native UI Automation IDs.
    private enum ControlType
    {
        Button = 50000, CheckBox = 50002, ComboBox = 50003, Edit = 50004, Hyperlink = 50005,
        ListItem = 50007, List = 50008, MenuItem = 50011, RadioButton = 50013, ScrollBar = 50014,
        Slider = 50015, Spinner = 50016, TabItem = 50019, Text = 50020, TreeItem = 50024, Group = 50026, Thumb = 50027,
        SplitButton = 50031, Document = 50030, Pane = 50033
    }
}
