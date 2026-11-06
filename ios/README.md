# Sniffnet Downloads iOS widget

This Scriptable widget mirrors the image currently displayed by a TRMNL device. The TRMNL Device API key is stored in Scriptable's encrypted Keychain and is not included in this repository or the script source.

## Requirements

- an iPhone with [Scriptable](https://scriptable.app/) installed;
- a TRMNL device with Developer Edition enabled, or a TRMNL BYOD license;
- Sniffnet Downloads installed on the selected device.

TRMNL's current-screen endpoint mirrors the current item rather than rendering a chosen plugin on demand. To keep the iOS widget permanently on Sniffnet Downloads, use a dedicated device/BYOD profile whose playlist contains only this plugin.

## Install

1. On the iPhone, download or copy `Sniffnet Downloads.js` into Scriptable.
2. In TRMNL, open **Devices**, edit the device to mirror, and copy the key under **Developer perks → Device API key**.
3. Run **Sniffnet Downloads** once inside Scriptable.
4. Paste the Device API key when prompted. A medium-widget preview should appear.
5. Long-press the iPhone Home Screen, tap **+**, select **Scriptable**, and add the **medium** widget.
6. Long-press the new widget, choose **Edit Widget**, and select the **Sniffnet Downloads** script.

The widget follows the refresh interval returned by TRMNL, subject to iOS deciding when widgets may update. If a refresh fails, a cached screen from the previous 24 hours remains visible. Tap the widget to open TRMNL. Run the script inside Scriptable again to preview it, validate and replace the key, or remove the key.

## Security

Use the device-specific API key, not an Account API key or the optional GitHub token configured for the plugin. Do not paste any credential into the script source or commit one to Git.
