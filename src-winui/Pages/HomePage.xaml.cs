using Microsoft.UI.Xaml.Controls;
using System;
using Windows.ApplicationModel.DataTransfer;
using Windows.System;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace WT8111Neo_Control.Pages;

public sealed partial class HomePage : Page
{
    public HomePage()
    {
        InitializeComponent();
    }

    private async void OpenWebGui_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        await App.ServiceHost.StartAsync();
        await Launcher.LaunchUriAsync(new Uri(ServiceHost.LocalWebGuiUrl));
    }

    private async void CheckService_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        await App.ServiceHost.StartAsync();

        ServiceStatusBar.Severity = App.ServiceHost.IsOnline
            ? InfoBarSeverity.Success
            : InfoBarSeverity.Error;
        ServiceStatusBar.Title = App.ServiceHost.IsOnline ? "Online" : "Offline";
        ServiceStatusBar.Message = App.ServiceHost.StatusMessage;
    }

    private void CopyLocalUrl_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        var package = new DataPackage();
        package.SetText(ServiceHost.LocalWebGuiUrl);
        Clipboard.SetContent(package);
    }
}
