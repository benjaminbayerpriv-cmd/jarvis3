using System.Drawing;

namespace UiMap;

internal static class VisualEdges
{
    public static IReadOnlyList<Rectangle> Detect(byte[] bgra, Rectangle region)
    {
        double scale = Math.Min(1, 2300.0 / Math.Max(region.Width, region.Height));
        int width = Math.Max(1, (int)(region.Width * scale));
        int height = Math.Max(1, (int)(region.Height * scale));
        double stepX = (double)region.Width / width, stepY = (double)region.Height / height;
        var gray = new byte[width * height];
        var edges = new bool[gray.Length];

        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            int pixel = ((int)(y * stepY) * region.Width + (int)(x * stepX)) * 4;
            gray[y * width + x] = (byte)((29 * bgra[pixel] + 150 * bgra[pixel + 1] + 77 * bgra[pixel + 2]) >> 8);
        }

        for (int y = 1; y < height - 1; y++)
        for (int x = 1; x < width - 1; x++)
        {
            int i = y * width + x;
            edges[i] = Math.Abs(gray[i - 1] - gray[i + 1]) >= 16 ||
                Math.Abs(gray[i - width] - gray[i + width]) >= 16;
        }

        var results = new List<Rectangle>();
        var pending = new Stack<int>();
        for (int start = 0; start < edges.Length && results.Count < 160; start++)
        {
            if (!edges[start]) continue;
            int minX = width, maxX = 0, minY = height, maxY = 0;
            int count = 0;
            edges[start] = false;
            pending.Push(start);
            while (pending.TryPop(out int index))
            {
                int x = index % width, y = index / width;
                minX = Math.Min(minX, x); maxX = Math.Max(maxX, x);
                minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
                count++;
                // The outermost row and column are never marked as edges.
                for (int dy = -1; dy <= 1; dy++)
                for (int dx = -1; dx <= 1; dx++)
                {
                    int neighbor = index + dy * width + dx;
                    if (!edges[neighbor]) continue;
                    edges[neighbor] = false;
                    pending.Push(neighbor);
                }
            }

            int left = minX + 1, top = minY + 1, right = maxX, bottom = maxY;
            var rect = Rectangle.FromLTRB(region.X + (int)Math.Round(left * stepX),
                region.Y + (int)Math.Round(top * stepY), region.X + (int)Math.Round(right * stepX),
                region.Y + (int)Math.Round(bottom * stepY));
            if (rect.Width is < 18 or > 310 || rect.Height is < 15 or > 68 || rect.Width < rect.Height * 0.75)
                continue;
            if (count < 1.5 * (right - left + bottom - top) || results.Any(other => Similar(rect, other)))
                continue;

            // VisualScanner.swift samples 18% inside/outside each edge and expects
            // a 16-level jump with the same polarity on three of four sides.
            int insetX = Math.Max(1, (int)Math.Round((right - left) * 0.18));
            int insetY = Math.Max(1, (int)Math.Round((bottom - top) * 0.18));
            int midX = (left + right) / 2, midY = (top + bottom) / 2;
            int Tone(int x, int y) => gray[Math.Clamp(y, 0, height - 1) * width + Math.Clamp(x, 0, width - 1)];
            int[] jumps =
            [
                Tone(midX, top + insetY) - Tone(midX, top - insetY),
                Tone(midX, bottom - insetY) - Tone(midX, bottom + insetY),
                Tone(left + insetX, midY) - Tone(left - insetX, midY),
                Tone(right - insetX, midY) - Tone(right + insetX, midY)
            ];
            // Without OCR, require all four sides for wider candidates and short outlines.
            int sides = rect.Width <= 72 && rect.Height >= 18 ? 3 : 4;
            if (jumps.Count(jump => jump >= 16) >= sides || jumps.Count(jump => jump <= -16) >= sides)
                results.Add(rect);
        }

        return results;
    }

    public static bool Similar(Rectangle a, Rectangle b)
    {
        var overlap = Rectangle.Intersect(a, b);
        double area = (double)overlap.Width * overlap.Height;
        return area >= (double)a.Width * a.Height * 0.60 && area >= (double)b.Width * b.Height * 0.60;
    }
}
