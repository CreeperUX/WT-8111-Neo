using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WT8111Neo_Control;

public sealed class AppConfig
{
    public RelayConfig Relay { get; set; } = new();

    [JsonIgnore]
    public static string SettingsPath => Path.Combine(
        AppContext.BaseDirectory,
        "config",
        "settings.json");

    public static AppConfig Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
            {
                return new AppConfig();
            }

            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize(json, AppConfigJsonContext.Default.AppConfig) ?? new AppConfig();
        }
        catch
        {
            return new AppConfig();
        }
    }

    public void Save()
    {
        var directory = Path.GetDirectoryName(SettingsPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(this, AppConfigJsonContext.Default.AppConfig));
    }
}

public sealed class RelayConfig
{
    public bool Enabled { get; set; }
    public string ServerUrl { get; set; } = string.Empty;
    public string PlayerName { get; set; } = string.Empty;
    public string AccessPassword { get; set; } = string.Empty;
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true)]
[JsonSerializable(typeof(AppConfig))]
internal sealed partial class AppConfigJsonContext : JsonSerializerContext;
