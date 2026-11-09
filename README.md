# YouTube Studio Manager

A local dashboard for running several YouTube channels at once: stats, content performance, release
schedule, comments, API quota and sign-ins, all in one place. It runs entirely on your own computer
(http://127.0.0.1:8765) and talks only to Google's APIs.

## Features

- **Overview**: subscribers, views, watch hours and 28-day trends across all channels, plus actionable notes.
- **Channel Comparison**: channels side by side, with traffic sources and top viewer countries.
- **Content Performance**: every video in one sortable, filterable table with retention curves.
- **Calendar & Queue**: weekly release calendar, upload slots and clash warnings between channels.
- **Comments**: latest comments from every channel; reply from the dashboard (always confirmed first).
- **API Quota**: today's YouTube Data API usage per channel (10,000 units/day per Google Cloud project).
- **Channels & Sign-in**: sign-in health, one separate Chrome session per channel and a one-click renew.
- Times are shown in your own time zone; the interface is in English.

## Requirements

- Windows 10/11 (tokens are encrypted with Windows DPAPI)
- Python 3.10 or newer (https://www.python.org/downloads/, tick "Add python.exe to PATH")
- Google Chrome
- The Google account that owns each YouTube channel

## Getting started

1. Download the code (green **Code** button -> **Download ZIP**, or `git clone`) and extract it anywhere,
   for example `Documents\YouTube-Studio-Manager`.
2. Double-click `YouTubeStudioManager.cmd`. The first time, it creates a Python environment and installs
   the dependencies (needs internet, 1-3 minutes). The dashboard then opens in your browser.
3. On the welcome screen click **Add Channel**, then follow the **Google Cloud guide** in Account info:
   create a project, enable YouTube Data API v3 and YouTube Analytics API, add your email as a Test user
   and create a "Desktop app" OAuth client. The `client_secret_....json` file you download is picked up
   from your Downloads folder automatically.
4. Click **Sign in with Google**, choose the account that owns the channel, then click **Allow**.

Keep the black YouTube Studio Manager window open while you use the dashboard; close it to stop.
The full guide and FAQ are in the **Guide** page inside the dashboard.

## Your data

- OAuth client files are kept in `Secrets\`; sign-in tokens and API keys are encrypted with Windows DPAPI,
  so only your Windows account can read them.
- Quota stats and the audit log live in `Data\`, each channel's video folders in `Channels\`.
- Each channel's Chrome session lives in `%LOCALAPPDATA%\YouTubeStudioManager\chrome\`.
- Never share the `Secrets\` and `Data\` folders. They are listed in `.gitignore`.

## Troubleshooting

- **"Access blocked" when signing in**: your Google email is not in the project's Test users list.
- **"Google hasn't verified this app"**: normal for your own app; click Continue.
- **Signing in again every 7 days**: the Google Cloud app is still in Testing mode. Switch it to
  In production under Google Auth Platform -> Audience.
- **Dependencies fail to install**: delete `Tools\youtube\.venv`, then run `YouTubeStudioManager.cmd` again.

## For developers

```
Tools/dashboard/server.py      local HTTP server (stdlib, 127.0.0.1 only) + JSON API
Tools/dashboard/accounts.py    add/remove channels, masked credentials, audit log
Tools/dashboard/launcher.py    opens YouTube Studio in each channel's own Chrome session
Tools/dashboard/static/        plain JS/CSS front end, no build step
Tools/youtube/yt.py            YouTube Data/Analytics API + CLI (yt.cmd --ch KEY ...)
Tools/youtube/vault.py         DPAPI-encrypted token storage
```

- Tests: `Tools\youtube\.venv\Scripts\python.exe -I Tools\dashboard\test_release.py`
  (also `Tools\dashboard\test_accounts.py` and `Tools\youtube\test_vault.py`).
- Release zip: `Tools\youtube\.venv\Scripts\python.exe -I Tools\dashboard\build_release.py` (output in `dist\`).
  The build fails automatically if any credential file or pattern slips in.
- `channels.json`, `Secrets\`, `Data\` and `Channels\` are user data and are git-ignored.
- Change the port with the `YSM_PORT` environment variable.

## Disclaimer

YouTube Studio Manager is an independent open-source project. It is not affiliated with, endorsed or
sponsored by Google LLC or YouTube. YouTube is a trademark of Google LLC.

## License

Copyright (C) 2026 FenomanSKY.

YouTube Studio Manager is free software under the **GNU General Public License v3** (or any later version);
the full text is in `LICENSE`. You may use, modify and redistribute it, including commercially, as long as
any version you distribute (original or modified) is also released as source under the same GPL license and
keeps the original author's credit. It comes as is, WITHOUT ANY WARRANTY.
