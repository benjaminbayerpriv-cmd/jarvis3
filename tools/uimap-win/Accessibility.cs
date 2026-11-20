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

    public bool Collect(WindowRef window, Rectangle clip, List<Entry> entries, List<Rectangle> passwords)
    {
        try
        {
            int previous = entries.Count;
            foreach (var element in Walk(window, passwords))
            {
                try
                {
                    if (element.CurrentIsOffscreen != 0) continue;
                    int kind = element.CurrentControlType;
                    string? role = Role(element, kind);
                    if (role is null) continue;
                    Rectangle rect = Rectangle.Intersect(clip, Bounds(element));
                    if (rect.Width < 3 || rect.Height < 3) continue;
                    var runtimeId = element.GetRuntimeId();
                    if (runtimeId is not { Length: > 0 }) continue;
                    string label = Regex.Replace(element.CurrentName ?? "", @"\s+", " ").Trim();
                    if (label.Length == 0) label = (ControlType)kind switch
                    {
                        ControlType.Button => "Taste",
                        ControlType.CheckBox => "Kontrollkästchen",
                        ControlType.ScrollBar => "Scrollleiste",
                        _ => role switch { "field" => "Textfeld", "link" => "Link", _ => "Bedienelement" }
                    };
                    if (label.Length > 100)
                        label = label[..(char.IsHighSurrogate(label[98]) ? 98 : 99)] + "…";
                    entries.Add(new Entry(new Target("", role, label, PixelRect.From(rect),
                        element.CurrentIsEnabled != 0, "ax"), window, runtimeId, kind));
                    if (entries.Count - previous >= 600) break;
                }
                catch (COMException) { /* Element disappeared or its provider rejected a property. */ }
            }
            return true;
        }
        catch (COMException e)
        {
            Console.Error.WriteLine($"uimap: UI Automation scan incomplete (0x{e.HResult:X8}).");
            return false;
        }
    }

    public void Act(Entry entry, string verb, string? text, int dy)
    {
        if (!entry.Target.Enabled)
            throw new InvalidOperationException("The target was disabled at scan time.");
        var current = Native.Describe(entry.Window.Hwnd);
        if (current is null || current.Pid != entry.Window.Pid || current.Started != entry.Window.Started)
            throw Stale();

        IUIAutomationElement? element = null;
        Rectangle rect;
        if (entry.RuntimeId is { } id)
        {
            element = Walk(current).FirstOrDefault(candidate => candidate.GetRuntimeId().SequenceEqual(id));
            if (element == null || element.CurrentControlType != entry.ControlType ||
                element.CurrentIsOffscreen != 0 || element.CurrentIsEnabled == 0 || IsPassword(element))
                throw Stale();
            rect = Rectangle.Intersect(Bounds(element), current.Rect.Bounds);
        }
        else
        {
            if (current.Rect != entry.Window.Rect) throw Stale();
            rect = entry.Target.Rect.Bounds;
        }

        if (rect.Width <= 0 || rect.Height <= 0) throw Stale();
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
            return;
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
            return;
        }

        if (verb == "click" && element != null)
        {
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_InvokePatternId) is IUIAutomationInvokePattern invoke)
            {
                invoke.Invoke();
                return;
            }
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_TogglePatternId) is IUIAutomationTogglePattern toggle)
            {
                toggle.Toggle();
                return;
            }
            if (element.GetCurrentPattern(UIA_PatternIds.UIA_SelectionItemPatternId) is IUIAutomationSelectionItemPattern selection)
            {
                selection.Select();
                return;
            }
        }

        Point point = Native.Center(rect);
        if (Native.WindowAt(point) != current.Hwnd || !CanPointAt(point, element))
            throw new InvalidOperationException("The target point is covered, has changed, or is protected. Scan again.");
        Native.PointerAction(current.Hwnd, point, verb == "click", dy);
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

    private IEnumerable<IUIAutomationElement> Walk(WindowRef window, List<Rectangle>? passwords = null)
    {
        var root = automation.ElementFromHandle(window.Hwnd);
        if (root == null) yield break;
        var pending = new Stack<(IUIAutomationElement Element, bool IsRoot)>();
        pending.Push((root, true));
        var watch = Stopwatch.StartNew();

        for (int visited = 0; pending.TryPop(out var node); visited++)
        {
            if (visited >= NodeLimit || watch.Elapsed > TimeSpan.FromSeconds(4))
                throw new InvalidOperationException("UI Automation scan limit reached. Scan a smaller or less busy window.");
            var element = node.Element;
            if (!node.IsRoot && walker.GetNextSiblingElement(element) is { } sibling)
                pending.Push((sibling, false));
            if (IsPassword(element))
            {
                if (passwords != null) passwords.Add(Bounds(element));
                continue;
            }
            yield return element;
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
        element.GetCurrentPropertyValueEx(UIA_PropertyIds.UIA_IsPasswordPropertyId, 1) as bool?;

    private static bool IsPassword(IUIAutomationElement element) =>
        PasswordStatus(element) == true || Native.IsPasswordEdit((IntPtr)element.CurrentNativeWindowHandle);

    private static string? Role(IUIAutomationElement element, int type) => (ControlType)type switch
    {
        ControlType.Edit or ControlType.ComboBox or ControlType.Spinner or ControlType.List => "field",
        ControlType.Hyperlink => "link",
        ControlType.Button or ControlType.CheckBox or ControlType.RadioButton or ControlType.MenuItem or
        ControlType.Slider or ControlType.ScrollBar or ControlType.TabItem or ControlType.ListItem or
        ControlType.TreeItem or ControlType.SplitButton or ControlType.Thumb => "control",
        _ => element.GetCurrentPropertyValue(UIA_PropertyIds.UIA_IsInvokePatternAvailablePropertyId) is true
            ? "control" : null
    };

    private static InvalidOperationException Stale() => new("The target changed or is protected. Scan again.");

    // Control type IDs are the native UI Automation IDs.
    private enum ControlType
    {
        Button = 50000, CheckBox = 50002, ComboBox = 50003, Edit = 50004, Hyperlink = 50005,
        ListItem = 50007, List = 50008, MenuItem = 50011, RadioButton = 50013, ScrollBar = 50014,
        Slider = 50015, Spinner = 50016, TabItem = 50019, Thumb = 50027, TreeItem = 50024, SplitButton = 50031
    }
}
