using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace UiMap;

internal sealed record DisplayRef(IntPtr Handle, string Name, Rectangle Bounds, bool Primary);

internal static class Native
{
    private const int Root = 2;
    private const int DwmExtendedFrameBounds = 9;
    private const int DwmCloaked = 14;

    public static void UsePhysicalPixels()
    {
        var perMonitorV2 = new IntPtr(-4);
        if (!SetProcessDpiAwarenessContext(perMonitorV2) &&
            !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), perMonitorV2))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not enable per-monitor physical coordinates.");
    }

    public static List<WindowRef> Windows(bool requireIdentity = true)
    {
        var result = new List<WindowRef>();
        if (!EnumWindows((window, _) =>
        {
            if (Describe(window, requireIdentity) is { } current)
                result.Add(current);
            return true;
        }, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not enumerate desktop windows.");
        return result;
    }

    public static WindowRef SelectWindow(List<WindowRef> windows, string selector)
    {
        var foreground = GetForegroundWindow();
        var ordered = windows.OrderByDescending(w => w.Hwnd == foreground).ToArray();
        string exe = Path.GetFileName(selector);
        if (exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            exe = Path.GetFileNameWithoutExtension(exe);
        foreach (var window in ordered)
        {
            if (ProcessName(window.Pid)?.Equals(exe, StringComparison.OrdinalIgnoreCase) == true)
                return window;
        }

        var titles = ordered.Select(w => (Window: w, Title: Title(w.Hwnd))).ToArray();
        foreach (var pair in titles)
            if (pair.Title.Equals(selector, StringComparison.OrdinalIgnoreCase)) return pair.Window;
        foreach (var pair in titles)
            if (pair.Title.Contains(selector, StringComparison.OrdinalIgnoreCase)) return pair.Window;
        throw new InvalidOperationException("No visible window matches the requested app or title.");
    }

    public static WindowRef? Describe(IntPtr hwnd, bool requireIdentity = true)
    {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || IsIconic(hwnd) ||
            (DwmGetWindowAttribute(hwnd, DwmCloaked, out int cloaked, sizeof(int)) == 0 && cloaked != 0))
            return null;
        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == 0 || pid == Environment.ProcessId) return null;
        if (DwmGetWindowAttribute(hwnd, DwmExtendedFrameBounds, out Rect rect, Marshal.SizeOf<Rect>()) != 0 &&
            !GetWindowRect(hwnd, out rect))
            return null;
        var bounds = rect.Rectangle;
        if (bounds.Width <= 2 || bounds.Height <= 2 ||
            !SystemInformation.VirtualScreen.IntersectsWith(bounds))
            return null;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return new WindowRef(hwnd.ToInt64(), pid, process.StartTime.ToUniversalTime().Ticks, PixelRect.From(bounds));
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return requireIdentity ? null : new WindowRef(hwnd.ToInt64(), pid, 0, PixelRect.From(bounds));
        }
    }

    public static bool IsCurrent(WindowRef window) =>
        Describe(window.Hwnd) is { } current && current.Pid == window.Pid && current.Started == window.Started;

    public static IntPtr Monitor(IntPtr window) => MonitorFromWindow(window, 2);

    public static DisplayRef[] Displays()
    {
        var result = new List<DisplayRef>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, _, _, _) =>
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(monitor, ref info))
                result.Add(new(monitor, info.Device, info.Monitor.Rectangle, (info.Flags & 1) != 0));
            return true;
        }, IntPtr.Zero) || result.Count == 0)
            throw new InvalidOperationException("No active Windows monitor was found.");
        return result.OrderByDescending(d => d.Primary).ThenBy(d => d.Bounds.X).ThenBy(d => d.Bounds.Y).ToArray();
    }

    public static void ScrollAtCursor(int lines)
    {
        if (!GetCursorPos(out _))
            throw new InvalidOperationException("Could not resolve the cursor on the interactive desktop.");
        if (lines != 0) SendMouse([Mouse(0x0800, WheelDelta(lines))], false);
    }

    private static uint WheelDelta(int lines)
    {
        uint perNotch = 3;
        if (SystemParametersInfo(0x0068, 0, out uint configured, 0) && configured is > 0 and < uint.MaxValue)
            perNotch = configured;
        long delta = -(long)lines * 120 / perNotch;
        if (delta == 0 && lines != 0) delta = -Math.Sign(lines);
        if (delta is < int.MinValue or > int.MaxValue)
            throw new ArgumentException("Scroll distance is too large.");
        return unchecked((uint)delta);
    }

    public static Point Center(Rectangle rect) => new(rect.X + rect.Width / 2, rect.Y + rect.Height / 2);
    public static IntPtr WindowAt(Point point) => GetAncestor(WindowFromPoint(point), Root);

    public static bool IsPasswordEdit(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        var name = new StringBuilder(128);
        GetClassName(hwnd, name, name.Capacity);
        string windowClass = name.ToString();
        return (windowClass.Equals("Edit", StringComparison.OrdinalIgnoreCase) ||
            windowClass.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) &&
            (GetWindowLong(hwnd, -16) & 0x20) != 0;
    }

    public static void AddNativePasswordRects(IntPtr owner, Rectangle region, List<Rectangle> masks)
    {
        EnumChildWindows(owner, (child, _) =>
        {
            if (IsWindowVisible(child) && IsPasswordEdit(child))
            {
                masks.Add(GetWindowRect(child, out var bounds) ?
                    Rectangle.Intersect(region, bounds.Rectangle) : region);
            }
            return true;
        }, IntPtr.Zero);
    }

    public static void FocusWindow(IntPtr hwnd)
    {
        if (GetForegroundWindow() != hwnd && !SetForegroundWindow(hwnd) && GetForegroundWindow() != hwnd)
            throw new InvalidOperationException("Windows denied foreground activation. Activate the target window and retry.");
    }

    public static void PointerAction(IntPtr owner, Point point, bool click, int dy)
    {
        if (WindowAt(point) != owner || IsPasswordEdit(WindowFromPoint(point)))
            throw new InvalidOperationException("The target point is covered or protected. Scan again.");
        if (!SetCursorPos(point.X, point.Y))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not position the pointer.");
        if (!GetCursorPos(out var cursor) || cursor != point || WindowAt(point) != owner ||
            IsPasswordEdit(WindowFromPoint(point)))
            throw new InvalidOperationException("The target point changed before input. Scan again.");
        if (!click && dy == 0) return;
        SendMouse(click ? [Mouse(0x0002), Mouse(0x0004)] : [Mouse(0x0800, WheelDelta(dy))], click);
    }

    private static void SendMouse(Input[] input, bool click)
    {
        uint sent = SendInput((uint)input.Length, input, Marshal.SizeOf<Input>());
        if (sent != input.Length)
        {
            if (click && sent == 1)
                SendInput(1, [Mouse(0x0004)], Marshal.SizeOf<Input>());
            throw new InvalidOperationException("Windows rejected mouse input. Check the desktop session and target integrity level.");
        }
    }

    private static Input Mouse(uint flags, uint data = 0) => new() { Mouse = new MouseInput { Flags = flags, Data = data } };

    private static string? ProcessName(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or Win32Exception) { return null; }
    }

    private static string Title(IntPtr hwnd)
    {
        var buffer = new StringBuilder(GetWindowTextLength(hwnd) + 1);
        GetWindowText(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
        public readonly Rectangle Rectangle => Rectangle.FromLTRB(Left, Top, Right, Bottom);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor, Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    // Only the mouse variant is used. MOUSEINPUT is the largest member of the native INPUT union.
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public MouseInput Mouse; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }

    private delegate bool MonitorVisitor(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr context);
    [DllImport("user32")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorVisitor visitor, IntPtr context);
    [DllImport("user32")] private static extern bool SystemParametersInfo(uint action, uint param, out uint value, uint flags);
    private delegate bool WindowVisitor(IntPtr window, IntPtr context);
    [DllImport("user32")] private static extern bool EnumChildWindows(IntPtr owner, WindowVisitor visitor, IntPtr context);
    [DllImport("user32", SetLastError = true)] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr context);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder buffer, int capacity);
    [DllImport("user32", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder buffer, int capacity);
    [DllImport("user32", CharSet = CharSet.Unicode)] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32")] internal static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32", SetLastError = true)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32", SetLastError = true)] private static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("dwmapi")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
    [DllImport("dwmapi")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
}
