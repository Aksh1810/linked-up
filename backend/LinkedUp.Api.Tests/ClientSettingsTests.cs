using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class ClientSettingsTests
{
    [Fact]
    public void Saved_settings_are_validated_and_camera_preferences_are_applied()
    {
        var settings = ClientSettings.Read("{\"cameraSensitivity\":\"high\",\"invertY\":true,\"reducedMotion\":true}");
        Assert.Equal(new CameraSettings(650, -650, true), settings.Camera);
        foreach (var invalid in new[] { "bad json", "[]", "null", "{\"cameraSensitivity\":\"unknown\"}", "{\"invertY\":\"yes\"}" })
            Assert.Equal(new CameraSettings(1000, 1000, false), ClientSettings.Read(invalid).Camera);
    }
}
