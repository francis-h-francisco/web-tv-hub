# Web TV Hub — Android app

A light native shell around the web app (https://webtv-hub.pages.dev/), built with
[Capacitor](https://capacitorjs.com) (MIT). It adds:

- **Reminders as real phone notifications**, which fire even when the app is closed (`@capacitor/local-notifications`).
- **Phone remote**: My TV → *Use this phone as a TV remote*, then scan or type the code shown on the TV.
- Everything else is the same web app, so it updates without reinstalling.

Built, malware-scanned (ClamAV) and published by `.github/workflows/android.yml` on every change to `app/`.
The download page (`site/download.html`) shows the scan result, SHA-256 checksum and a VirusTotal link for each build.

## Signing

Without signing secrets, builds are signed with a temporary debug key, so installing a newer version means
uninstalling the old one first. To sign every build with the same key, add these repository secrets
(Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | base64 of a `.jks` keystore |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Optional: `VIRUSTOTAL_API_KEY` (free account) uploads each APK to VirusTotal automatically.

## Chromecast

`native/` holds a small Capacitor plugin (`WthCastPlugin`, exposed to the web app as `Capacitor.Plugins.WthCast`)
built on Google's official Cast SDK (`play-services-cast-framework`). The workflow copies it into the generated
Android project, adds the SDK dependencies and registers `CastOptionsProvider` in the manifest. It uses Google's
free Default Media Receiver, so only channels whose streams allow it (CORS) can be cast; the app dims the others
while casting. While casting, the phone's volume buttons control the TV.

## Signing

One GitHub secret, `ANDROID_SIGNING` = `<password>:<keystore as base64>` (key alias `webtvhub`). Without it the
workflow still builds and scans the app as a test build but publishes nothing, so no one installs a build that
would later need uninstalling.
