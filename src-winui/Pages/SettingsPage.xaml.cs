// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.UI.Xaml.Controls;
using System;
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
    }

    private void SaveSettings_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        try
        {
            var config = new AppConfig
            {
                Relay = new RelayConfig
                {
                    Enabled = RelayEnabledSwitch.IsOn,
                    ServerUrl = ServerUrlBox.Text.Trim(),
                    PlayerName = PlayerNameBox.Text.Trim(),
                    AccessPassword = AccessPasswordBox.Password
                }
            };

            config.Save();
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
        PlayerNameBox.Text = string.Empty;
        AccessPasswordBox.Password = string.Empty;
    }

    private void LoadSettings()
    {
        var config = AppConfig.Load();
        RelayEnabledSwitch.IsOn = config.Relay.Enabled;
        ServerUrlBox.Text = config.Relay.ServerUrl;
        PlayerNameBox.Text = config.Relay.PlayerName;
        AccessPasswordBox.Password = config.Relay.AccessPassword;
    }
}
