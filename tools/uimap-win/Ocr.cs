using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace UiMap;

internal static class Ocr
{
    public static string Recognize(byte[] bytes, int width, int height)
    {
        try { return RecognizeWinRt(bytes, width, height); }
        catch (Exception e) when (e is COMException or UnauthorizedAccessException or TypeLoadException)
        {
            // Windows may deny this WinRT class to an unpackaged .NET process.
            return RecognizeInWindowsPowerShell(bytes, width, height).GetAwaiter().GetResult();
        }
    }

    private static string RecognizeWinRt(byte[] bytes, int width, int height)
    {
        var engine = OcrEngine.TryCreateFromUserProfileLanguages() ??
            OcrEngine.TryCreateFromLanguage(new Language("de-DE")) ??
            OcrEngine.TryCreateFromLanguage(new Language("en-US")) ??
            throw new InvalidOperationException("Install a Windows OCR language for the current user.");
        using var writer = new DataWriter();
        writer.WriteBytes(bytes);
        using var bitmap = SoftwareBitmap.CreateCopyFromBuffer(writer.DetachBuffer(),
            BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Ignore);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        try
        {
            var result = engine.RecognizeAsync(bitmap).AsTask(timeout.Token).GetAwaiter().GetResult();
            return string.Join("\n", result.Lines.Select(line => line.Text));
        }
        catch (OperationCanceledException) { throw new TimeoutException("Windows OCR timed out."); }
    }

    private static async Task<string> RecognizeInWindowsPowerShell(byte[] bytes, int width, int height)
    {
        // Only the crop that has already passed the password checks is piped to this process.
        var command = FormattableString.Invariant($$"""
            $ErrorActionPreference = 'Stop'
            [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
            try {
                Add-Type -AssemblyName System.Runtime.WindowsRuntime
                $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
                $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
                $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
                $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
                $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
                $inputBytes = New-Object byte[] {{bytes.Length}}
                $stdin = [Console]::OpenStandardInput()
                $read = 0
                while ($read -lt $inputBytes.Length) {
                    $count = $stdin.Read($inputBytes, $read, $inputBytes.Length - $read)
                    if ($count -eq 0) { throw 'Incomplete OCR crop.' }
                    $read += $count
                }
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
                if (!$engine) {
                    foreach ($locale in @('de-DE', 'en-US')) {
                        $language = New-Object Windows.Globalization.Language -ArgumentList $locale
                        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
                        if ($engine) { break }
                    }
                }
                if (!$engine) { exit 3 }
                $writer = New-Object Windows.Storage.Streams.DataWriter
                $writer.WriteBytes($inputBytes)
                $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer(
                    $writer.DetachBuffer(), 'Bgra8', {{width}}, {{height}}, 'Ignore')
                try {
                    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
                        $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
                    } | Select-Object -First 1
                    $task = $asTask.MakeGenericMethod([Windows.Media.Ocr.OcrResult]).Invoke(
                        $null, @($engine.RecognizeAsync($bitmap)))
                    $result = $task.GetAwaiter().GetResult()
                    [Console]::Write([string]::Join([string][char]10, [string[]]@($result.Lines | ForEach-Object { $_.Text })))
                } finally {
                    $bitmap.Dispose()
                    $writer.Dispose()
                }
            } catch {
                exit 1
            }
            """);
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,
            "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8
        };
        foreach (string argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                     Convert.ToBase64String(Encoding.Unicode.GetBytes(command)) })
            start.ArgumentList.Add(argument);

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start Windows PowerShell OCR.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.StandardInput.BaseStream.WriteAsync(bytes, timeout.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            await error;
            return process.ExitCode switch
            {
                0 => await output,
                3 => throw new InvalidOperationException("Install a Windows OCR language for the current user."),
                _ => throw new InvalidOperationException("Windows.Media.Ocr failed in Windows PowerShell.")
            };
        }
        catch (OperationCanceledException) { throw new TimeoutException("Windows PowerShell OCR timed out."); }
        finally
        {
            if (!process.HasExited) process.Kill();
        }
    }
}
