using Microsoft.UI.Xaml;

namespace WT8111Neo_Control;

public partial class App : Application
{
    public static ServiceHost ServiceHost { get; } = new();

    private Window? _window;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}
