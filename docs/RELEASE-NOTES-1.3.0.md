## ShotRef 1.3.0

**The Windows app now updates itself.**

- About 8 seconds after launch, ShotRef checks this page for a newer version and asks whether to download it. Then choose **Restart now**, or **Later** to install when you next close ShotRef. It asks about unsaved work before it closes.
- **Help, Check for updates…** checks on demand. **Help, Check for updates automatically** turns the launch check off.
- The portable version can't update itself, so it offers to open the download page.

If you are on 1.2.0 or older, install this version by hand once (below). After that, updates arrive in the app.

### Download

| You want | File |
|---|---|
| Windows app with installer (updates itself) | `ShotRef-Setup-1.3.0.exe` |
| Windows app, no install | `ShotRef-1.3.0-portable.exe` |
| Any computer with Chrome or Edge | `ShotRef.html` |

The Windows builds are not code-signed yet, so SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.

`latest.yml` and the `.blockmap` file are what the in-app updater reads. You can ignore them.

Guide: [docs/GUIDE.md](https://github.com/alistotleLB/ShotRef/blob/main/docs/GUIDE.md)
