using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System;
using System.Threading.Tasks;
using WT8111Neo_Control.Pages;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace WT8111Neo_Control;

public sealed partial class MainWindow : Window
{
    private readonly DispatcherTimer _connectionTimer = new()
    {
        Interval = TimeSpan.FromSeconds(10)
    };

    private ConnectionCheckResult? _localServiceResult;
    private ConnectionCheckResult? _cloudServiceResult;
    private bool _checkingConnections;

    public MainWindow()
    {
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        AppWindow.SetIcon("Assets/AppIcon.ico");
        Closed += MainWindow_Closed;

        NavFrame.Navigate(typeof(HomePage));
        _connectionTimer.Tick += ConnectionTimer_Tick;
        _connectionTimer.Start();
        _ = InitializeConnectionsAsync();
    }

    private void MainWindow_Closed(object sender, WindowEventArgs args)
    {
        _connectionTimer.Stop();
        App.ServiceHost.Dispose();
    }

    private void TitleBar_PaneToggleRequested(TitleBar sender, object args)
    {
        NavView.IsPaneOpen = !NavView.IsPaneOpen;
    }

    private void TitleBar_BackRequested(TitleBar sender, object args)
    {
        NavFrame.GoBack();
    }

    private void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.IsSettingsSelected)
        {
            NavFrame.Navigate(typeof(SettingsPage));
        }
        else if (args.SelectedItem is NavigationViewItem item)
        {
            switch (item.Tag)
            {
                case "home":
                    NavFrame.Navigate(typeof(HomePage));
                    break;
                case "sync":
                    NavFrame.Navigate(typeof(SettingsPage));
                    break;
                case "capture":
                    NavFrame.Navigate(typeof(CapturePage));
                    break;
                case "about":
                    NavFrame.Navigate(typeof(AboutPage));
                    break;
                default:
                    throw new InvalidOperationException($"Unknown navigation item tag: {item.Tag}");
            }
        }
    }

    private async Task InitializeConnectionsAsync()
    {
        _localServiceResult = new ConnectionCheckResult
        {
            Health = ConnectionHealth.Warning,
            Title = "Starting local service",
            Message = "Checking wt-8111-neo.exe and port 17711.",
            Detail = ServiceHost.LocalWebGuiUrl,
            CheckedAt = DateTimeOffset.Now
        };
        UpdateConnectionUi();

        _localServiceResult = await App.ServiceHost.CheckLocalServiceAsync(startIfMissing: true);
        UpdateConnectionUi();
        await RefreshConnectionsAsync(includeLocalStart: false);
    }

    private async void ConnectionTimer_Tick(object? sender, object e)
    {
        await RefreshConnectionsAsync(includeLocalStart: false);
    }

    private async void RefreshConnections_Click(object sender, RoutedEventArgs e)
    {
        await RefreshConnectionsAsync(includeLocalStart: true);
    }

    private async void ConnectionStatusButton_Click(object sender, RoutedEventArgs e)
    {
        if (_localServiceResult is null || _cloudServiceResult is null)
        {
            await RefreshConnectionsAsync(includeLocalStart: false);
        }
    }

    private void OpenSyncSettings_Click(object sender, RoutedEventArgs e)
    {
        NavFrame.Navigate(typeof(SettingsPage));
        foreach (var menuItem in NavView.MenuItems)
        {
            if (menuItem is NavigationViewItem item && item.Tag?.ToString() == "sync")
            {
                NavView.SelectedItem = item;
                break;
            }
        }
    }

    private async Task RefreshConnectionsAsync(bool includeLocalStart)
    {
        if (_checkingConnections)
        {
            return;
        }

        _checkingConnections = true;
        try
        {
            _localServiceResult ??= new ConnectionCheckResult
            {
                Health = ConnectionHealth.Warning,
                Title = "Checking local service",
                Message = "Checking wt-8111-neo.exe and port 17711.",
                Detail = ServiceHost.LocalWebGuiUrl,
                CheckedAt = DateTimeOffset.Now
            };
            _cloudServiceResult = new ConnectionCheckResult
            {
                Health = ConnectionHealth.Warning,
                Title = "Checking cloud service",
                Message = "Checking cloud relay configuration.",
                Detail = string.Empty,
                CheckedAt = DateTimeOffset.Now
            };
            UpdateConnectionUi();

            _localServiceResult = await App.ServiceHost.CheckLocalServiceAsync(includeLocalStart);
            _cloudServiceResult = await App.ServiceHost.CheckCloudServerAsync(ensureRoom: false);
            UpdateConnectionUi();
        }
        finally
        {
            _checkingConnections = false;
        }
    }

    private void UpdateConnectionUi()
    {
        var local = _localServiceResult;
        var cloud = _cloudServiceResult;
        var aggregate = AggregateHealth(local?.Health ?? ConnectionHealth.Warning, cloud?.Health ?? ConnectionHealth.Warning);

        ConnectionStatusGlyph.Glyph = GlyphForHealth(aggregate);
        ConnectionStatusText.Text = TextForAggregate(local, cloud, aggregate);

        if (local is not null)
        {
            LocalServiceGlyph.Glyph = GlyphForHealth(local.Health);
            LocalServiceTitle.Text = local.Title;
            LocalServiceMessage.Text = $"{local.Message} - {local.CheckedAt.ToLocalTime():T}";
        }

        if (cloud is not null)
        {
            CloudServiceGlyph.Glyph = GlyphForHealth(cloud.Health);
            CloudServiceTitle.Text = cloud.Title;
            CloudServiceMessage.Text = $"{cloud.Message} - {cloud.CheckedAt.ToLocalTime():T}";
            CloudServiceDetail.Text = cloud.Detail;
        }
    }

    private static ConnectionHealth AggregateHealth(ConnectionHealth local, ConnectionHealth cloud)
    {
        if (local == ConnectionHealth.Offline || cloud == ConnectionHealth.Offline)
        {
            return ConnectionHealth.Offline;
        }

        if (local == ConnectionHealth.Warning || cloud == ConnectionHealth.Warning)
        {
            return ConnectionHealth.Warning;
        }

        if (local == ConnectionHealth.Online && (cloud == ConnectionHealth.Online || cloud == ConnectionHealth.Disabled))
        {
            return ConnectionHealth.Online;
        }

        return ConnectionHealth.Disabled;
    }

    private static string TextForAggregate(
        ConnectionCheckResult? local,
        ConnectionCheckResult? cloud,
        ConnectionHealth aggregate)
    {
        if (local?.Health == ConnectionHealth.Online && cloud?.Health == ConnectionHealth.Online)
        {
            return "Local + cloud online";
        }

        if (local?.Health == ConnectionHealth.Online && cloud?.Health == ConnectionHealth.Disabled)
        {
            return "Local online";
        }

        return aggregate switch
        {
            ConnectionHealth.Online => "Connected",
            ConnectionHealth.Warning => "Connection warning",
            ConnectionHealth.Offline => "Connection offline",
            _ => "Cloud disabled"
        };
    }

    private static string GlyphForHealth(ConnectionHealth health)
    {
        return health switch
        {
            ConnectionHealth.Online => "\uE930",
            ConnectionHealth.Warning => "\uE7BA",
            ConnectionHealth.Offline => "\uEA39",
            _ => "\uE968"
        };
    }
}
