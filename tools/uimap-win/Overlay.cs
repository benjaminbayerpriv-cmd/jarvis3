using System.Drawing.Drawing2D;
using System.Globalization;
using System.Runtime.InteropServices;

namespace UiMap;

internal sealed class Overlay : Form
{
    private readonly Target[] targets;
    private static readonly Color Transparent = Color.Magenta;

    private Overlay(Target[] targets)
    {
        this.targets = targets;
        Text = "uimap debug overlay";
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen;
        BackColor = Transparent;
        TransparencyKey = Transparent;
        ShowInTaskbar = false;
        TopMost = true;
        DoubleBuffered = true;
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var style = base.CreateParams;
            style.ExStyle |= 0x08000000 | 0x00080000 | 0x00000020 | 0x00000080;
            return style;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetWindowDisplayAffinity(Handle, 0x11);
    }

    public static void ShowTargets(Target[] targets)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                using var form = new Overlay(targets);
                using var timer = new System.Windows.Forms.Timer { Interval = 20_000 };
                timer.Tick += (_, _) => form.Close();
                form.Shown += (_, _) => timer.Start();
                Application.Run(form);
            }
            catch (Exception e) { failure = e; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) throw new InvalidOperationException("Could not show the debug overlay.", failure);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        DrawMarks(e.Graphics, targets, new Point(Left, Top), ClientRectangle);
    }

    internal static void DrawMarks(Graphics graphics, Target[] targets, Point origin, Rectangle canvas)
    {
        using var font = new Font(SystemFonts.MessageBoxFont?.FontFamily ?? FontFamily.GenericSansSerif, 10, FontStyle.Bold);
        using var shadow = new Pen(Color.FromArgb(16, 22, 29), 3f);
        using var background = new SolidBrush(shadow.Color);
        var badges = new List<Rectangle>();
        foreach (var target in targets)
        {
            var rect = target.Rect.Bounds;
            rect.Offset(-origin.X, -origin.Y);
            if (!rect.IntersectsWith(canvas)) continue;
            Color color = !target.Enabled ? Color.LightGray : target.Role switch
            {
                "field" => Color.FromArgb(255, 203, 89),
                "link" => Color.FromArgb(193, 181, 255),
                "visual" => Color.FromArgb(255, 173, 209),
                _ => Color.FromArgb(92, 240, 203)
            };
            using var pen = new Pen(color, 1.5f);
            if (target.Source == "visual") pen.DashStyle = DashStyle.Dash;
            graphics.DrawRectangle(shadow, rect);
            graphics.DrawRectangle(pen, rect);

            string number = target.Id.ToString(CultureInfo.InvariantCulture);
            Size size = TextRenderer.MeasureText(number, font);
            int x = Math.Clamp(rect.Left, 0, Math.Max(0, canvas.Width - size.Width));
            Rectangle[] positions =
            [
                new(x, rect.Top - size.Height - 2, size.Width, size.Height),
                new(x, rect.Bottom + 2, size.Width, size.Height),
                new(rect.Right + 2, rect.Top, size.Width, size.Height),
                new(x, rect.Top + 2, size.Width, size.Height)
            ];
            var badge = positions.FirstOrDefault(place => canvas.Contains(place) && !badges.Any(place.IntersectsWith));
            if (badge.IsEmpty) continue;
            badges.Add(badge);
            graphics.FillRectangle(background, badge);
            TextRenderer.DrawText(graphics, number, font, badge, color, TextFormatFlags.NoPadding |
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    [DllImport("user32")]
    private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
}
