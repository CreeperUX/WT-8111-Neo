using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace WT8111Neo_Control;

public sealed class ServiceHost : IDisposable
{
    public const string LocalWebGuiUrl = "http://127.0.0.1:17711";
    public const int CloudProtocolVersion = 1;

    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(2)
    };

    private Process? _serviceProcess;
    private bool _ownsProcess;
    private readonly SemaphoreSlim _startLock = new(1, 1);

    public string StatusMessage { get; private set; } = "Service has not been checked.";
    public bool IsOnline { get; private set; }

    public static string GetConfiguredWebGuiUrl()
    {
        var config = AppConfig.Load().Relay;
        if (!config.Enabled || string.IsNullOrWhiteSpace(config.ServerUrl) || string.IsNullOrWhiteSpace(config.RoomId))
        {
            return LocalWebGuiUrl;
        }

        var query = new List<string>
        {
            "cloud=both",
            $"server={Uri.EscapeDataString(NormalizeCloudServerUrl(config.ServerUrl))}",
            $"room={Uri.EscapeDataString(config.RoomId)}"
        };

        if (!string.IsNullOrWhiteSpace(config.PlayerName))
        {
            query.Add($"player={Uri.EscapeDataString(config.PlayerName)}");
        }

        if (!string.IsNullOrEmpty(config.AccessPassword))
        {
            query.Add($"password={Uri.EscapeDataString(config.AccessPassword)}");
        }

        return $"{LocalWebGuiUrl}?{string.Join("&", query)}";
    }

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

    public async Task<ConnectionCheckResult> CheckLocalServiceAsync(bool startIfMissing = false)
    {
        if (startIfMissing)
        {
            await StartAsync();
        }
        else
        {
            IsOnline = await IsServiceOnlineAsync();
            StatusMessage = IsOnline
                ? "WT 8111 Neo local service answered /api/health."
                : "WT 8111 Neo local service did not answer on port 17711.";
        }

        return new ConnectionCheckResult
        {
            Health = IsOnline ? ConnectionHealth.Online : ConnectionHealth.Offline,
            Title = IsOnline ? "Local service online" : "Local service offline",
            Message = StatusMessage,
            Detail = LocalWebGuiUrl,
            CheckedAt = DateTimeOffset.Now
        };
    }

    public async Task<ConnectionCheckResult> CheckCloudServerAsync(bool ensureRoom = false)
    {
        return await CheckCloudRoomAsync(ensureRoom, requireRelayEnabled: true);
    }

    public async Task<ConnectionCheckResult> CheckCloudEndpointAsync()
    {
        var config = AppConfig.Load().Relay;
        var serverValidation = ValidateCloudServer(config.ServerUrl);
        if (serverValidation is not null)
        {
            return serverValidation;
        }

        try
        {
            var version = await FetchCloudVersionAsync(config.ServerUrl);
            if (version.ProtocolVersion != CloudProtocolVersion)
            {
                return new ConnectionCheckResult
                {
                    Health = ConnectionHealth.Offline,
                    Title = "Cloud protocol mismatch",
                    Message = $"Client protocol v{CloudProtocolVersion}, server protocol v{version.ProtocolVersion}.",
                    Detail = $"{version.Service} {version.Version}",
                    CheckedAt = DateTimeOffset.Now
                };
            }

            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Online,
                Title = "Cloud server reachable",
                Message = "Server version endpoint matches the client protocol.",
                Detail = $"{version.Service} {version.Version} - {NormalizeCloudServerUrl(config.ServerUrl)}",
                CheckedAt = DateTimeOffset.Now
            };
        }
        catch (Exception error)
        {
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Offline,
                Title = "Cloud connection failed",
                Message = error.Message,
                Detail = NormalizeCloudServerUrl(config.ServerUrl),
                CheckedAt = DateTimeOffset.Now
            };
        }
    }

    public async Task<ConnectionCheckResult> CheckCloudRoomAsync(bool ensureRoom = false)
    {
        return await CheckCloudRoomAsync(ensureRoom, requireRelayEnabled: false);
    }

    public async Task<IReadOnlyList<CloudRoomSummary>> ListCloudRoomsAsync()
    {
        var config = AppConfig.Load().Relay;
        var serverValidation = ValidateCloudServer(config.ServerUrl);
        if (serverValidation is not null)
        {
            throw new InvalidOperationException(serverValidation.Message);
        }

        using var response = await Http.GetAsync(CombineCloudUrl(config.ServerUrl, "api/rooms"));
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(await ReadCloudErrorAsync(response, $"Cloud room list returned {(int)response.StatusCode}."));
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync(stream, AppConfigJsonContext.Default.ListCloudRoomSummary)
            ?? new List<CloudRoomSummary>();
    }

    public static CloudConnectionInput NormalizeCloudConnectionInput(string serverInput, string roomId)
    {
        var parsed = ParseCloudConnectionInput(serverInput);
        return new CloudConnectionInput
        {
            ServerUrl = parsed.ServerUrl,
            RoomId = !string.IsNullOrWhiteSpace(parsed.RoomId) ? parsed.RoomId : roomId.Trim()
        };
    }

    public static CloudConnectionInput ParseCloudConnectionInput(string input)
    {
        var trimmed = input.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return new CloudConnectionInput();
        }

        var candidate = HasUriScheme(trimmed) ? trimmed : $"http://{trimmed}";
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri))
        {
            return new CloudConnectionInput
            {
                ServerUrl = trimmed
            };
        }

        var scheme = uri.Scheme switch
        {
            "wss" => Uri.UriSchemeHttps,
            "ws" => Uri.UriSchemeHttp,
            _ => uri.Scheme
        };
        var serverUrl = new UriBuilder(uri)
        {
            Scheme = scheme,
            Path = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty
        }.Uri.ToString().TrimEnd('/');

        return new CloudConnectionInput
        {
            ServerUrl = serverUrl,
            RoomId = ExtractRoomIdFromPath(uri.AbsolutePath)
        };
    }

    public static string NormalizeCloudServerUrl(string serverUrl)
    {
        return ParseCloudConnectionInput(serverUrl).ServerUrl;
    }

    public static string BuildCloudWebSocketUrl(string serverUrl, string roomId, string role)
    {
        var normalized = NormalizeCloudServerUrl(serverUrl);
        if (string.IsNullOrWhiteSpace(normalized) || string.IsNullOrWhiteSpace(roomId))
        {
            return string.Empty;
        }

        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
        {
            return string.Empty;
        }

        var scheme = uri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws";
        var builder = new UriBuilder(uri)
        {
            Scheme = scheme,
            Path = $"ws/rooms/{Uri.EscapeDataString(roomId.Trim())}/{role}",
            Query = string.Empty,
            Fragment = string.Empty
        };
        return builder.Uri.ToString();
    }

    private async Task<ConnectionCheckResult> CheckCloudRoomAsync(bool ensureRoom, bool requireRelayEnabled)
    {
        var config = AppConfig.Load().Relay;
        if (requireRelayEnabled && !config.Enabled)
        {
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Disabled,
                Title = "Cloud relay disabled",
                Message = "Enable relay upload in Sync settings to connect to the cloud tactical server.",
                Detail = "Relay upload is off.",
                CheckedAt = DateTimeOffset.Now
            };
        }

        if (string.IsNullOrWhiteSpace(config.RoomId))
        {
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Warning,
                Title = "Relay URL incomplete",
                Message = "Paste the full Relay URL, for example ws://host:17712/ws/rooms/room-id/relay.",
                Detail = NormalizeCloudServerUrl(config.ServerUrl),
                CheckedAt = DateTimeOffset.Now
            };
        }

        var serverValidation = ValidateCloudServer(config.ServerUrl);
        if (serverValidation is not null)
        {
            return serverValidation;
        }

        try
        {
            var version = await FetchCloudVersionAsync(config.ServerUrl);
            if (version.ProtocolVersion != CloudProtocolVersion)
            {
                return new ConnectionCheckResult
                {
                    Health = ConnectionHealth.Offline,
                    Title = "Cloud protocol mismatch",
                    Message = $"Client protocol v{CloudProtocolVersion}, server protocol v{version.ProtocolVersion}.",
                    Detail = $"{version.Service} {version.Version}",
                    CheckedAt = DateTimeOffset.Now
                };
            }

            if (ensureRoom)
            {
                await CreateCloudRoomAsync(config);
            }

            var join = await JoinCloudRoomAsync(config);
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Online,
                Title = ensureRoom ? "Cloud room ready" : "Cloud connected",
                Message = $"Room {join.RoomId} accepted relay/viewer connections.",
                Detail = $"{version.Service} {version.Version} - {BuildCloudWebSocketUrl(config.ServerUrl, join.RoomId, "relay")}",
                CheckedAt = DateTimeOffset.Now
            };
        }
        catch (Exception error)
        {
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Offline,
                Title = "Cloud connection failed",
                Message = error.Message,
                Detail = NormalizeCloudServerUrl(config.ServerUrl),
                CheckedAt = DateTimeOffset.Now
            };
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

    private static async Task<CloudVersionResponse> FetchCloudVersionAsync(string serverUrl)
    {
        using var response = await Http.GetAsync(CombineCloudUrl(serverUrl, "version"));
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(await ReadCloudErrorAsync(response, $"Cloud version check returned {(int)response.StatusCode}."));
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        var version = await JsonSerializer.DeserializeAsync(stream, AppConfigJsonContext.Default.CloudVersionResponse);
        if (version is null)
        {
            throw new InvalidOperationException("Cloud version response was empty.");
        }

        return version;
    }

    private static async Task CreateCloudRoomAsync(RelayConfig config)
    {
        var request = new CloudCreateRoomRequest
        {
            RoomId = config.RoomId,
            Password = config.AccessPassword,
            PlayerName = config.PlayerName
        };
        var json = JsonSerializer.Serialize(request, AppConfigJsonContext.Default.CloudCreateRoomRequest);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await Http.PostAsync(CombineCloudUrl(config.ServerUrl, "api/rooms"), content);
        if (response.IsSuccessStatusCode || response.StatusCode == System.Net.HttpStatusCode.Conflict)
        {
            return;
        }

        throw new InvalidOperationException(await ReadCloudErrorAsync(response, $"Cloud room create returned {(int)response.StatusCode}."));
    }

    private static async Task<CloudJoinResponse> JoinCloudRoomAsync(RelayConfig config)
    {
        var request = new CloudJoinRoomRequest
        {
            Password = config.AccessPassword
        };
        var json = JsonSerializer.Serialize(request, AppConfigJsonContext.Default.CloudJoinRoomRequest);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await Http.PostAsync(
            CombineCloudUrl(config.ServerUrl, $"api/rooms/{Uri.EscapeDataString(config.RoomId)}/join"),
            content);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(await ReadCloudErrorAsync(response, $"Cloud room join returned {(int)response.StatusCode}."));
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        var join = await JsonSerializer.DeserializeAsync(stream, AppConfigJsonContext.Default.CloudJoinResponse);
        if (join is null || string.IsNullOrWhiteSpace(join.RoomId))
        {
            throw new InvalidOperationException("Cloud room join response was empty.");
        }

        return join;
    }

    private static string CombineCloudUrl(string serverUrl, string path)
    {
        return $"{NormalizeCloudServerUrl(serverUrl).TrimEnd('/')}/{path.TrimStart('/')}";
    }

    private static ConnectionCheckResult? ValidateCloudServer(string serverUrl)
    {
        if (string.IsNullOrWhiteSpace(serverUrl))
        {
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Warning,
                Title = "Cloud server missing",
                Message = "Paste the full Relay URL from Room Management.",
                Detail = "Relay URL is required.",
                CheckedAt = DateTimeOffset.Now
            };
        }

        var normalized = NormalizeCloudServerUrl(serverUrl);
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var serverUri) ||
            (serverUri.Scheme != Uri.UriSchemeHttp && serverUri.Scheme != Uri.UriSchemeHttps))
        {
            return new ConnectionCheckResult
            {
                Health = ConnectionHealth.Offline,
                Title = "Relay URL invalid",
                Message = "Use the full ws:// or wss:// Relay URL from Room Management.",
                Detail = serverUrl,
                CheckedAt = DateTimeOffset.Now
            };
        }

        return null;
    }

    private static bool HasUriScheme(string value)
    {
        var separator = value.IndexOf("://", StringComparison.Ordinal);
        return separator > 0;
    }

    private static string ExtractRoomIdFromPath(string path)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length >= 3 &&
            string.Equals(segments[0], "ws", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(segments[1], "rooms", StringComparison.OrdinalIgnoreCase))
        {
            return Uri.UnescapeDataString(segments[2]);
        }

        return string.Empty;
    }

    private static async Task<string> ReadCloudErrorAsync(HttpResponseMessage response, string fallback)
    {
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            if (document.RootElement.TryGetProperty("error", out var error) &&
                error.ValueKind == JsonValueKind.String)
            {
                return error.GetString() ?? fallback;
            }
        }
        catch
        {
            // Keep the original status message if the server did not return JSON.
        }

        return fallback;
    }
}

public enum ConnectionHealth
{
    Disabled,
    Online,
    Warning,
    Offline
}

public sealed class ConnectionCheckResult
{
    public ConnectionHealth Health { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string Detail { get; set; } = string.Empty;
    public DateTimeOffset CheckedAt { get; set; }
}

public sealed class CloudVersionResponse
{
    public string Service { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;

    [JsonPropertyName("protocol_version")]
    public int ProtocolVersion { get; set; }
}

public sealed class CloudCreateRoomRequest
{
    [JsonPropertyName("room_id")]
    public string RoomId { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;

    [JsonPropertyName("player_name")]
    public string PlayerName { get; set; } = string.Empty;
}

public sealed class CloudJoinRoomRequest
{
    public string Password { get; set; } = string.Empty;
}

public sealed class CloudJoinResponse
{
    public bool Ok { get; set; }

    [JsonPropertyName("room_id")]
    public string RoomId { get; set; } = string.Empty;

    [JsonPropertyName("relay_url")]
    public string RelayUrl { get; set; } = string.Empty;

    [JsonPropertyName("viewer_url")]
    public string ViewerUrl { get; set; } = string.Empty;
}

public sealed class CloudRoomSummary
{
    [JsonPropertyName("room_id")]
    public string RoomId { get; set; } = string.Empty;

    [JsonPropertyName("has_password")]
    public bool HasPassword { get; set; }

    [JsonPropertyName("created_secs_ago")]
    public int CreatedSecsAgo { get; set; }

    [JsonPropertyName("relay_count")]
    public int RelayCount { get; set; }

    [JsonPropertyName("viewer_count")]
    public int ViewerCount { get; set; }
}

public sealed class CloudConnectionInput
{
    public string ServerUrl { get; set; } = string.Empty;
    public string RoomId { get; set; } = string.Empty;
}
