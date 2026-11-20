using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

namespace UiMap;

internal static class Capture
{
    private static readonly Guid CaptureItemId = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid DxgiDeviceId = new("54EC77FA-1377-44E6-8C32-88FD5F44C84C");

    public static IReadOnlyList<Rectangle> Detect(IntPtr handle, bool monitor, Rectangle region,
        IReadOnlyList<Rectangle> passwords)
    {
        var bytes = Frame(handle, monitor, region);
        Redact(bytes, region, passwords);
        return VisualEdges.Detect(bytes, region);
    }

    public static string ReadText(Rectangle rect, Accessibility automation)
    {
        var bytes = DesktopPixels(rect, automation, rejectProtected: true);
        int width = rect.Width, height = rect.Height;
        const int ocrMaxDimension = 2048;
        if (Math.Max(width, height) > ocrMaxDimension)
        {
            using var full = ToBitmap(bytes, rect);
            double scale = (double)ocrMaxDimension / Math.Max(width, height);
            width = Math.Max(1, (int)(width * scale));
            height = Math.Max(1, (int)(height * scale));
            using var resized = new Bitmap(full, width, height);
            bytes = new byte[checked(width * height * 4)];
            var data = resized.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < height; y++)
                    Marshal.Copy(data.Scan0 + y * data.Stride, bytes, y * width * 4, width * 4);
            }
            finally { resized.UnlockBits(data); }
        }
        return Ocr.Recognize(bytes, width, height);
    }

    public static string Screenshot(Rectangle rect, Accessibility automation, Target[] marks)
    {
        var bytes = DesktopPixels(rect, automation, rejectProtected: false);
        using var bitmap = ToBitmap(bytes, rect);
        if (marks.Length > 0)
        {
            using var graphics = Graphics.FromImage(bitmap);
            Overlay.DrawMarks(graphics, marks, rect.Location, new Rectangle(Point.Empty, rect.Size));
        }
        string path = Path.Combine(Path.GetTempPath(), $"uimap-{Guid.NewGuid():N}.png");
        try
        {
            bitmap.Save(path, ImageFormat.Png);
            return path;
        }
        catch
        {
            File.Delete(path);
            throw;
        }
    }

    private static Bitmap ToBitmap(byte[] bytes, Rectangle rect)
    {
        var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppRgb);
        try
        {
            var data = bitmap.LockBits(new Rectangle(Point.Empty, rect.Size), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < rect.Height; y++)
                    Marshal.Copy(bytes, y * rect.Width * 4, data.Scan0 + y * data.Stride, rect.Width * 4);
            }
            finally { bitmap.UnlockBits(data); }
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    private static byte[] DesktopPixels(Rectangle region, Accessibility automation, bool rejectProtected)
    {
        if (region.Width <= 0 || region.Height <= 0 || (long)region.Width * region.Height > 64_000_000)
            throw new ArgumentException("Invalid or oversized capture rectangle.");
        var displays = Native.Displays();
        if (!displays.Any(d => d.Bounds.IntersectsWith(region)))
            throw new ArgumentException("The capture rectangle is outside the desktop.");

        var passwords = automation.ProtectedRegions(region);
        CheckProtection();
        var pixels = new byte[checked(region.Width * region.Height * 4)];
        foreach (var display in displays)
        {
            var part = Rectangle.Intersect(region, display.Bounds);
            if (part.Width <= 0 || part.Height <= 0) continue;
            var monitor = Frame(display.Handle, true, display.Bounds);
            for (int y = part.Y; y < part.Bottom; y++)
            {
                int source = ((y - display.Bounds.Y) * display.Bounds.Width + part.X - display.Bounds.X) * 4;
                int target = ((y - region.Y) * region.Width + part.X - region.X) * 4;
                System.Buffer.BlockCopy(monitor, source, pixels, target, part.Width * 4);
            }
        }

        // Recheck after capture to catch protection and geometry changes during frame acquisition.
        passwords.AddRange(automation.ProtectedRegions(region));
        CheckProtection();
        Redact(pixels, region, passwords);
        return pixels;

        void CheckProtection()
        {
            if (rejectProtected && passwords.Any(region.IntersectsWith))
                throw new InvalidOperationException("Passwortfelder sind gesperrt.");
        }
    }

    private static void Redact(byte[] bytes, Rectangle region, IReadOnlyList<Rectangle> masks)
    {
        foreach (var mask in masks)
        {
            var rect = Rectangle.Intersect(mask, region);
            if (rect.Width <= 0 || rect.Height <= 0) continue;
            int startX = rect.X - region.X, startY = rect.Y - region.Y;
            for (int y = startY; y < startY + rect.Height; y++)
                Array.Clear(bytes, (y * region.Width + startX) * 4, rect.Width * 4);
        }
    }

    private static byte[] Frame(IntPtr handle, bool monitor, Rectangle region)
    {
        if (!GraphicsCaptureSession.IsSupported())
            throw new NotSupportedException("Graphics capture is unavailable in this desktop session.");
        var factory = GraphicsCaptureItem.As<ICaptureItemInterop>();
        IntPtr itemPointer;
        if (monitor) factory.CreateForMonitor(handle, CaptureItemId, out itemPointer);
        else factory.CreateForWindow(handle, CaptureItemId, out itemPointer);
        GraphicsCaptureItem item;
        try { item = GraphicsCaptureItem.FromAbi(itemPointer); }
        finally { Marshal.Release(itemPointer); }
        var size = item.Size;
        if (size.Width != region.Width || size.Height != region.Height)
            throw new InvalidOperationException("Capture dimensions do not match the desktop bounds. Scan again.");

        using var device = CreateDevice();
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        session.StartCapture();
        using var frame = GetFrame(pool);
        if (frame.ContentSize.Width != size.Width || frame.ContentSize.Height != size.Height)
            throw new InvalidOperationException("Capture dimensions changed. Scan again.");

        // Copy outside FrameArrived so the capture dispatcher remains free to complete the copy.
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        SoftwareBitmap bitmap;
        try
        {
            bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore)
                .AsTask(timeout.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            throw new TimeoutException("Timed out copying the captured frame.");
        }
        using (bitmap)
        {
            if (bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8 ||
                bitmap.PixelWidth != size.Width || bitmap.PixelHeight != size.Height)
                throw new InvalidOperationException("Unexpected capture pixel format or dimensions.");
            var bytes = new byte[checked(size.Width * size.Height * 4)];
            var buffer = new Windows.Storage.Streams.Buffer((uint)bytes.Length) { Length = (uint)bytes.Length };
            bitmap.CopyToBuffer(buffer);
            using var reader = DataReader.FromBuffer(buffer);
            reader.ReadBytes(bytes);

            return bytes;
        }
    }

    private static Direct3D11CaptureFrame GetFrame(Direct3D11CaptureFramePool pool)
    {
        var watch = Stopwatch.StartNew();
        do
        {
            if (pool.TryGetNextFrame() is { } frame) return frame;
            Thread.Sleep(15);
        } while (watch.Elapsed < TimeSpan.FromSeconds(3));
        throw new TimeoutException("No frame arrived from the Windows compositor.");
    }

    private static IDirect3DDevice CreateDevice()
    {
        const uint bgraSupport = 0x20;
        int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, bgraSupport, IntPtr.Zero, 0, 7,
            out var native, IntPtr.Zero, IntPtr.Zero);
        if (hr < 0)
            hr = D3D11CreateDevice(IntPtr.Zero, 5, IntPtr.Zero, bgraSupport, IntPtr.Zero, 0, 7,
                out native, IntPtr.Zero, IntPtr.Zero);
        Marshal.ThrowExceptionForHR(hr);
        try
        {
            var iid = DxgiDeviceId;
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native, ref iid, out var dxgi));
            try
            {
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var device));
                try { return MarshalInterface<IDirect3DDevice>.FromAbi(device); }
                finally { Marshal.Release(device); }
            }
            finally { Marshal.Release(dxgi); }
        }
        finally { Marshal.Release(native); }
    }

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICaptureItemInterop
    {
        void CreateForWindow(IntPtr window, in Guid iid, out IntPtr item);
        void CreateForMonitor(IntPtr monitor, in Guid iid, out IntPtr item);
    }

    [DllImport("d3d11")]
    private static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags,
        IntPtr featureLevels, uint featureLevelCount, uint sdkVersion, out IntPtr device,
        IntPtr selectedFeatureLevel, IntPtr immediateContext);

    [DllImport("d3d11")]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr device);
}
