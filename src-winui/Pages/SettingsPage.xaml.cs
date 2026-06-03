// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.UI.Xaml.Controls;
using System;
using System.Linq;
using System.Threading.Tasks;
using WT8111Neo_Control;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace WT8111Neo_Control.Pages;

public sealed partial class SettingsPage : Page
{
    public SettingsPage()
    {
        InitializeComponent();
        LoadSettings();
        UpdateDerivedUrls();
    }

    private void SaveSettings_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        try
        {
            SaveForm();
            SettingsStatusBar.Severity = InfoBarSeverity.Success;
            SettingsStatusBar.Title = "Saved";
            SettingsStatusBar.Message = $"Settings saved to {AppConfig.SettingsPath}";
            SettingsStatusBar.IsOpen = true;
        }
        catch (Exception error)
        {
            SettingsStatusBar.Severity = InfoBarSeverity.Error;
            SettingsStatusBar.Title = "Save failed";
            SettingsStatusBar.Message = error.Message;
            SettingsStatusBar.IsOpen = true;
        }
    }

    private void ResetSettings_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        RelayEnabledSwitch.IsOn = false;
        ServerUrlBox.Text = string.Empty;
        RoomIdBox.Text = string.Empty;
        PlayerNameBox.Text = string.Empty;
        AccessPasswordBox.Password = string.Empty;
        ActiveRoomsList.ItemsSource = null;
        UpdateDerivedUrls();
        ApplyCloudResult(new ConnectionCheckResult
        {
            Health = ConnectionHealth.Disabled,
            Title = "Cloud status not checked",
            Message = "Paste Relay URL, then test or join the room.",
            Detail = string.Empty,
            CheckedAt = DateTimeOffset.Now
        });
    }

    private async void TestServer_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        await SaveAndCheckCloudAsync(CloudCheckAction.TestServer);
    }

    private async void JoinRoom_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        await SaveAndCheckCloudAsync(CloudCheckAction.JoinRoom);
    }

    private async void RefreshRooms_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        try
        {
            SaveForm();
            var rooms = await App.ServiceHost.ListCloudRoomsAsync();
            ActiveRoomsList.ItemsSource = rooms
                .Select(room =>
                    $"{(room.HasPassword ? "[locked]" : "[open]")} {room.RoomId} - {room.RelayCount} relays, {room.ViewerCount} viewers, {room.CreatedSecsAgo}s ago")
                .ToList();

            ApplyCloudResult(new ConnectionCheckResult
            {
                Health = ConnectionHealth.Online,
                Title = "Active rooms refreshed",
                Message = rooms.Count == 0 ? "Server is reachable, but no rooms are active." : $"Loaded {rooms.Count} active room(s).",
                Detail = ServiceHost.NormalizeCloudServerUrl(ServerUrlBox.Text),
                CheckedAt = DateTimeOffset.Now
            });
        }
        catch (Exception error)
        {
            SettingsStatusBar.Severity = InfoBarSeverity.Error;
            SettingsStatusBar.Title = "Room refresh failed";
            SettingsStatusBar.Message = error.Message;
            SettingsStatusBar.IsOpen = true;
        }
    }

    private void ConnectionField_TextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateDerivedUrls();
    }

    private void LoadSettings()
    {
        var config = AppConfig.Load();
        RelayEnabledSwitch.IsOn = config.Relay.Enabled;
        ServerUrlBox.Text = ServiceHost.BuildCloudWebSocketUrl(config.Relay.ServerUrl, config.Relay.RoomId, "relay");
        RoomIdBox.Text = config.Relay.RoomId;
        PlayerNameBox.Text = config.Relay.PlayerName;
        AccessPasswordBox.Password = config.Relay.AccessPassword;
    }

    private void SaveForm()
    {
        var normalized = ServiceHost.NormalizeCloudConnectionInput(ServerUrlBox.Text, string.Empty);
        ServerUrlBox.Text = ServiceHost.BuildCloudWebSocketUrl(normalized.ServerUrl, normalized.RoomId, "relay");
        RoomIdBox.Text = normalized.RoomId;
        UpdateDerivedUrls();

        var config = new AppConfig
        {
            Relay = new RelayConfig
            {
                Enabled = RelayEnabledSwitch.IsOn,
                ServerUrl = normalized.ServerUrl,
                RoomId = normalized.RoomId,
                PlayerName = PlayerNameBox.Text.Trim(),
                AccessPassword = AccessPasswordBox.Password
            }
        };

        config.Save();
    }

    private async Task SaveAndCheckCloudAsync(CloudCheckAction action)
    {
        try
        {
            SaveForm();
            ApplyCloudResult(new ConnectionCheckResult
            {
                Health = ConnectionHealth.Warning,
                Title = action switch
                {
                    CloudCheckAction.JoinRoom => "Joining room",
                    _ => "Testing cloud server"
                },
                Message = action switch
                {
                    CloudCheckAction.JoinRoom => "POST /api/rooms/{room_id}/join with the saved password.",
                    _ => "GET /version and protocol compatibility check."
                },
                Detail = ServiceHost.NormalizeCloudServerUrl(ServerUrlBox.Text),
                CheckedAt = DateTimeOffset.Now
            });

            var result = action switch
            {
                CloudCheckAction.TestServer => await App.ServiceHost.CheckCloudEndpointAsync(),
                _ => await App.ServiceHost.CheckCloudRoomAsync(ensureRoom: false)
            };
            ApplyCloudResult(result);

            SettingsStatusBar.Severity = ToInfoBarSeverity(result.Health);
            SettingsStatusBar.Title = result.Title;
            SettingsStatusBar.Message = result.Message;
            SettingsStatusBar.IsOpen = true;
        }
        catch (Exception error)
        {
            SettingsStatusBar.Severity = InfoBarSeverity.Error;
            SettingsStatusBar.Title = "Cloud check failed";
            SettingsStatusBar.Message = error.Message;
            SettingsStatusBar.IsOpen = true;
        }
    }

    private void UpdateDerivedUrls()
    {
        var normalized = ServiceHost.NormalizeCloudConnectionInput(ServerUrlBox.Text, string.Empty);
        var relayUrl = ServiceHost.BuildCloudWebSocketUrl(normalized.ServerUrl, normalized.RoomId, "relay");
        var viewerUrl = ServiceHost.BuildCloudWebSocketUrl(normalized.ServerUrl, normalized.RoomId, "viewer");
        RoomIdBox.Text = normalized.RoomId;
        RelayUrlText.Text = string.IsNullOrWhiteSpace(normalized.ServerUrl) ? "--" : normalized.ServerUrl;
        ViewerUrlText.Text = string.IsNullOrWhiteSpace(viewerUrl) ? "--" : viewerUrl;
        WebGuiUrlText.Text =
            string.IsNullOrWhiteSpace(normalized.ServerUrl) || string.IsNullOrWhiteSpace(normalized.RoomId)
                ? "--"
                : $"{ServiceHost.LocalWebGuiUrl}?cloud=both&server={Uri.EscapeDataString(normalized.ServerUrl)}&room={Uri.EscapeDataString(normalized.RoomId)}";
    }

    private void ApplyCloudResult(ConnectionCheckResult result)
    {
        CloudStatusTitle.Text = result.Title;
        CloudStatusMessage.Text = result.Message;
        CloudStatusDetail.Text = string.IsNullOrWhiteSpace(result.Detail)
            ? result.CheckedAt.ToLocalTime().ToString("T")
            : $"{result.Detail} - {result.CheckedAt.ToLocalTime():T}";

        CloudStatusIcon.Glyph = result.Health switch
        {
            ConnectionHealth.Online => "\uE930",
            ConnectionHealth.Warning => "\uE7BA",
            ConnectionHealth.Offline => "\uEA39",
            _ => "\uE968"
        };
    }

    private static InfoBarSeverity ToInfoBarSeverity(ConnectionHealth health)
    {
        return health switch
        {
            ConnectionHealth.Online => InfoBarSeverity.Success,
            ConnectionHealth.Warning => InfoBarSeverity.Warning,
            ConnectionHealth.Offline => InfoBarSeverity.Error,
            _ => InfoBarSeverity.Informational
        };
    }

    private enum CloudCheckAction
    {
        TestServer,
        JoinRoom
    }
}
