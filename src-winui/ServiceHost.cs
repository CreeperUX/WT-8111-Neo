using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace WT8111Neo_Control;

public sealed class ServiceHost : IDisposable
{
    public const string LocalWebGuiUrl = "http://127.0.0.1:17711";

    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(2)
    };

    private Process? _serviceProcess;
    private bool _ownsProcess;
    private readonly SemaphoreSlim _startLock = new(1, 1);

    public string StatusMessage { get; private set; } = "Service has not been checked.";
    public bool IsOnline { get; private set; }

    public async Task StartAsync()
    {
        await _startLock.WaitAsync();
        try
        {
            if (await IsServiceOnlineAsync())
            {
                IsOnline = true;
                StatusMessage = "WT 8111 Neo service is already running.";
                return;
            }

            var servicePath = FindServiceExecutable();
            if (servicePath is null)
            {
                IsOnline = false;
                StatusMessage = "Could not find wt-8111-neo.exe next to the WinUI control client.";
                return;
            }

            var startInfo = new ProcessStartInfo(servicePath)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(servicePath) ?? AppContext.BaseDirectory
            };

            try
            {
                _serviceProcess = Process.Start(startInfo);
                _ownsProcess = _serviceProcess is not null;
            }
            catch (Exception error)
            {
                IsOnline = false;
                StatusMessage = $"Could not start wt-8111-neo.exe: {error.Message}";
                return;
            }

            for (var attempt = 0; attempt < 20; attempt++)
            {
                await Task.Delay(250);
                if (await IsServiceOnlineAsync())
                {
                    IsOnline = true;
                    StatusMessage = "WT 8111 Neo service started automatically.";
                    return;
                }
            }

            IsOnline = false;
            StatusMessage = "Started wt-8111-neo.exe, but the local service did not answer on port 17711.";
        }
        finally
        {
            _startLock.Release();
        }
    }

    public async Task<bool> IsServiceOnlineAsync()
    {
        try
        {
            using var response = await Http.GetAsync($"{LocalWebGuiUrl}/api/health");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        if (!_ownsProcess || _serviceProcess is null)
        {
            return;
        }

        try
        {
            if (!_serviceProcess.HasExited)
            {
                _serviceProcess.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // The process may already be gone during app shutdown.
        }
        finally
        {
            _serviceProcess.Dispose();
            _serviceProcess = null;
            _ownsProcess = false;
        }
    }

    private static string? FindServiceExecutable()
    {
        var bundledPath = Path.Combine(AppContext.BaseDirectory, "wt-8111-neo.exe");
        if (File.Exists(bundledPath))
        {
            return bundledPath;
        }

        var repoPath = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..",
            "..",
            "..",
            "..",
            "..",
            "..",
            "src-tauri",
            "target",
            "release",
            "wt-8111-neo.exe"));

        return File.Exists(repoPath) ? repoPath : null;
    }
}
