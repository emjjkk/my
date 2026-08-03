Having an image as a wallpaper is not enough for me. And yes I've tried Wallpaper Engine and Lively Wallpaper, but those aren't exactly resource efficient, and I feel like that's important, especially in a RAM-limited world. The idea for this project is to create a wallpaper engine that's lightweight enough for me to run on a 8GB RAM laptop while still being able to do other things. I used Tauri 2, which is a useful framework built on Rust that allows anyone with web development experience to build a native PC app, as well as React, TypeScript, and a small pile of plugins doing things Tauri doesn't do out of the box. 

Every live wallpaper app on Windows is doing the same illegal-feeling trick under the hood. There's no public API for "render something behind my desktop icons." You have to go find the hidden window that Explorer creates for exactly this purpose, and stick your own window inside it. That's the whole game. Everything else — the wallpaper types, the settings UI, the battery awareness — is just product work bolted onto that one hack.

## The Progman/WorkerW Trick

Windows has had a semi-documented mechanism for "behind the icons" rendering since the Windows 7 era — it's how Wallpaper Engine, Lively, and basically every other live wallpaper tool works. The short version:

1. `Progman` (Program Manager) is the hidden window class that owns the desktop.
2. Sending it an undocumented message (`0x052C`) makes it spawn a `WorkerW` window as a sibling of the desktop icon layer (`SHELLDLL_DefView`).
3. Whatever HWND you parent into that `WorkerW` renders behind the icons, in front of the actual desktop background.

Rather than reimplementing this by hand with raw `FindWindowEx`/`SendMessage` calls, I reached for [`tauri-plugin-wallpaper`](https://crates.io/crates/tauri-plugin-wallpaper), which wraps the whole dance behind two calls:

```rust
use tauri_plugin_wallpaper::{AttachRequest, PinRequest, WallpaperExt};

// Attach main window to desktop wallpaper layer (behind icons)
let _ = handle.wallpaper().attach(AttachRequest::new("main"));
let _ = handle.wallpaper().pin(PinRequest::new("main"));
```

`attach` does the `Progman`/`WorkerW` reparenting. `pin` keeps the window locked to that position instead of letting it get pulled back to the foreground the next time focus changes. Both take a window label, which is how Tauri's multi-window API scopes everything — more on that below.

The window itself has to be configured to actually look like a wallpaper once it's in place, which happens declaratively in `tauri.conf.json`:

```json
{
  "label": "main",
  "title": "main",
  "fullscreen": true,
  "decorations": false,
  "resizable": false,
  "transparent": true,
  "skipTaskbar": true
}
```

`fullscreen` covers the whole monitor, `decorations: false` strips the titlebar so there's no chrome floating over your desktop icons, `transparent: true` matters if the wallpaper content itself has transparent regions, and `skipTaskbar` keeps it from cluttering alt-tab since as far as the user's concerned this window doesn't exist as an app.

There's one gotcha that isn't obvious until you've had the wallpaper randomly die on you: Windows doesn't create `WorkerW` once and leave it alone. It gets torn down and recreated on sleep/wake, resolution or DPI changes, and any time `explorer.exe` restarts. If you attach once at startup and never again, your live wallpaper will silently detach itself at some point and just... stop being behind the icons. The fix is a dumb watchdog thread that keeps re-asserting the attachment:

```rust
let watchdog_handle = handle.clone();
std::thread::spawn(move || loop {
    std::thread::sleep(std::time::Duration::from_secs(30));
    let _ = watchdog_handle.wallpaper().attach(AttachRequest::new("main"));
    let _ = watchdog_handle.wallpaper().pin(PinRequest::new("main"));
});
```

Re-attaching to an already-correctly-attached window is a no-op in practice, so there's no visible flicker from doing this every 30 seconds — it's just cheap insurance against a class of bug that's otherwise very annoying to reproduce on demand.

## You now already have a wallpaper engine

Once that window is sitting behind the icons and rendering full-screen, something clicks: it's a WebView. It's not a special "wallpaper surface" with a restricted content model — it's the same Chromium-based WebView2 runtime Tauri always gives you, just parented somewhere unusual. Which means the render target for your wallpaper is a normal React tree. At this point, anything you can write in React can already be rendered as your wallpaper.

```tsx
function WallpaperView({ settings }: { settings: AppSettings }) {
  return (
    <main className="w-screen h-screen overflow-hidden bg-black select-none pointer-events-none">
      {settings.wallpaper_type === 'webpage' ? (
        <iframe src={settings.wallpaper_src} className="w-full h-full border-0" />
      ) : settings.wallpaper_type === 'video' ? (
        <video src={settings.wallpaper_src} autoPlay loop muted playsInline className="w-full h-full object-cover" />
      ) : (
        <img src={settings.wallpaper_src} alt="Wallpaper" className="w-full h-full object-cover" />
      )}
    </main>
  );
}
```

I decided to take this a step further and build this out into an application more versatile for non-technical users by allowing file uploads and URL inputs. Thus moving it from just a wallpaper to a "wallpaper engine" if you will.

The wallpaper could be an `<img>`, a `<video>`, or — and this is the part I actually got excited about — an `<iframe>` pointed at an arbitrary URL. Any React app, any Shadertoy sketch, any Three.js scene, any canvas-based generative art site, any dashboard you feel like staring at all day: if it runs in a browser, it runs behind your desktop icons now. `pointer-events-none` on the container keeps clicks passing through to the actual desktop underneath instead of getting swallowed by the wallpaper content, and `select-none` stops you from accidentally text-selecting your own wallpaper while double-clicking icons near it.

Everything past this point in the project is really just "how do I turn this one trick into something that behaves like a product."

## Getting a Settings Window Without a Second App

A live wallpaper tool needs configuration UI, but that UI obviously can't live inside the wallpaper window itself — it's borderless, full-screen, click-through, and has no taskbar presence. Tauri's answer is that a single app can own multiple `WebviewWindow`s, each an independent HWND with its own URL and its own config, all sharing one Rust backend. The settings window is spawned lazily from a tray menu handler rather than declared upfront, since most of the time nobody needs it open:

```rust
"settings" => {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = WebviewWindowBuilder::new(
            app,
            "settings",
            WebviewUrl::App("index.html?settings=true".into()),
        )
        .title("Wallpaper Settings")
        .inner_size(420.0, 560.0)
        .resizable(false)
        .center()
        .build();
    }
}
```

Both windows load the same `index.html` — same Vite bundle, same React tree — and branch at the root based on a query string:

```tsx
const params = new URLSearchParams(window.location.search);
const isSettingsWindow = params.has('settings');

// ...

if (isSettingsWindow) {
  return <SettingsView settings={settings} onUpdate={handleUpdateSettings} />;
}
return <WallpaperView settings={settings} />;
```

One Vite multi-page-style build, two windows, no duplicated bundle to maintain. The capability file has to explicitly allow both labels or the settings window won't get permission to call any commands:

```json
{
  "identifier": "default",
  "windows": ["main", "settings"],
  "permissions": ["core:default", "wallpaper:default", "store:allow-get", "store:allow-set", "..."]
}
```

## Keeping Two Windows in Sync

Settings live in one place (`settings.json`, via `tauri-plugin-store`) but get read and mutated from two different windows that have no direct connection to each other — they're separate webviews, separate JS contexts, no shared memory. The sync mechanism is Tauri's event system: the settings window calls a command, the backend persists it and re-broadcasts it, and the wallpaper window (which is just listening, not polling) picks it up.

```rust
#[tauri::command]
fn update_settings(app: AppHandle, new_settings: AppSettings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;

    let autostart_mgr = app.autolaunch();
    if new_settings.autostart {
        let _ = autostart_mgr.enable();
    } else {
        let _ = autostart_mgr.disable();
    }

    store.set("config", serde_json::to_value(&new_settings).unwrap());
    let _ = store.save();

    let _ = app.emit("settings-changed", new_settings);
    Ok(())
}
```

`app.emit` without a target broadcasts to every window in the app, which is exactly what's wanted here — both the wallpaper and settings windows subscribe:

```tsx
useEffect(() => {
  invoke<AppSettings>('get_settings').then(setSettings).catch(console.error);

  const unlisten = listen<AppSettings>('settings-changed', (event) => {
    setSettings(event.payload);
  });

  return () => { unlisten.then((fn) => fn()); };
}, []);
```

Toggling "pause on battery" in the settings window updates state locally for instant UI feedback, fires the command, and the wallpaper window a few milliseconds later gets the same payload over the event bus and re-renders with the new value — no polling, no manual refresh button.

## Local Files Need Their Own Protocol Scope

Pointing the wallpaper at a URL is trivial — an `<iframe src>` or `<video src>` just works. Pointing it at a file on the user's disk is not, because WebView2 doesn't let arbitrary local paths load into a webview for fairly obvious security reasons. Tauri's answer is the asset protocol: a `asset://` scheme that's allowed to serve files, but only from paths you explicitly whitelist.

```json
"security": {
  "assetProtocol": {
    "enable": true,
    "scope": ["$APPDATA/wallpapers/**"]
  }
}
```

That scope is deliberately narrow — only the app's own wallpapers directory, nothing else on the filesystem is reachable through it. On the frontend, an uploaded file first gets copied into that directory server-side (never referenced from its original location, since that could be anywhere and might not persist), and the returned path gets converted to something the webview can actually load:

```rust
#[tauri::command]
fn save_wallpaper_file(app: AppHandle, source_path: String) -> Result<String, String> {
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("wallpapers");
    std::fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let source = std::path::Path::new(&source_path);
    let filename = source.file_name().ok_or("Invalid filename")?.to_string_lossy();
    let destination = base_dir.join(filename.as_ref());

    std::fs::copy(source, &destination).map_err(|e| e.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}
```

```tsx
const savedPath = await invoke<string>('save_wallpaper_file', { sourcePath: selected });
onUpdate({
  ...settings,
  wallpaper_type: isVideo ? 'video' : 'image',
  wallpaper_src: convertFileSrc(savedPath),
});
```

`convertFileSrc` is the piece that actually matters — it turns a raw filesystem path into the `asset://` URL the scoped protocol will serve, which is what ends up in `<video src>` or `<img src>`.

One bug this setup makes easy to hit, and worth calling out because it's the kind of thing that only shows up after a reboot: I originally let the file picker's `blob:` object URL get saved straight into the persisted settings for instant preview. That works fine in the moment — but a `blob:` URL is scoped to the browser session that created it. Save it to disk, restart the app days later, and it points at nothing. The wallpaper would silently fail to load with no error, forever, on every future launch, even though nothing else about the config was wrong. The fix is a self-heal check on load rather than trying to prevent it at the source:

```rust
if settings.wallpaper_src.starts_with("blob:") {
    let defaults = AppSettings::default();
    settings.wallpaper_type = defaults.wallpaper_type;
    settings.wallpaper_src = defaults.wallpaper_src;
    store.set("config", serde_json::to_value(&settings).unwrap());
    let _ = store.save();
}
```

Cheap, and it means a corrupted config from an old build heals itself on next launch instead of leaving someone staring at a black screen with no idea why.

## WebView2 Doesn't Know It's Supposed to Be a Wallpaper

This one took a while to track down. Video wallpapers would play fine for a bit and then just... stop, with no error and no obvious trigger. The cause: Chromium (and by extension WebView2) aggressively throttles timers and can suspend media playback on windows it judges to be backgrounded or occluded, to save battery and CPU on normal browser tabs you're not looking at. Our wallpaper window is *permanently* backgrounded and occluded from Chromium's point of view — it sits behind the desktop icons and gets covered by every other window on the screen, by design. WebView2 has no idea it's rendering a wallpaper; it just sees a window that's never focused and mostly hidden, and throttles it like any other background tab.

The fix is telling WebView2 not to apply that throttling at all, via an environment variable read at process startup:

```rust
#[cfg(target_os = "windows")]
std::env::set_var(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
);
```

That closes most of it, but not all of it — some media pauses still slip through in practice, so there's a belt-and-suspenders watchdog on the React side that notices when a video has stopped on its own (without the app having asked it to pause) and resumes it:

```tsx
const resumeIfNeeded = () => {
  if (!isPaused && video.paused) {
    video.play().catch(() => {});
  }
};

video.addEventListener('pause', resumeIfNeeded);
video.addEventListener('suspend', resumeIfNeeded);
video.addEventListener('stalled', resumeIfNeeded);
document.addEventListener('visibilitychange', resumeIfNeeded);

const watchdog = setInterval(resumeIfNeeded, 4000);
```

The check against local `isPaused` state matters here — the app *does* intentionally pause playback under some conditions (see below), and this watchdog needs to leave those alone. It only fights back against playback stopping for reasons the app didn't ask for.

## Making It Behave Like a Real Wallpaper Engine

The trick and the plumbing get you a webview behind your icons. Turning that into something that feels like Wallpaper Engine rather than a tech demo is mostly about power and attention awareness.

**Pausing on battery** checks actual AC line status through the Win32 API rather than relying on the browser's Battery Status API, which reports charge level fine but is unreliable about signaling AC-vs-battery transitions promptly:

```rust
#[tauri::command]
fn check_is_on_battery() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        let mut status = MaybeUninit::<SYSTEM_POWER_STATUS>::uninit();
        if GetSystemPowerStatus(status.as_mut_ptr()) != 0 {
            let status = status.assume_init();
            return status.ACLineStatus == 0;
        }
    }
    false
}
```

`ACLineStatus == 0` means running on battery power. The frontend polls this every four seconds and falls back to `navigator.getBattery()` if the native call ever fails, so the feature degrades instead of breaking outright on a platform quirk.

**Pausing when unfocused** is cheaper — no native call needed, just `document.hasFocus()` checked whenever the window gains or loses focus — though "focus" is a slightly fuzzy concept for a window that's deliberately behind everything and never meant to be interacted with directly; in practice it tracks whether the desktop itself currently has focus versus some other app being active.

Both conditions feed into one `evaluatePauseConditions` function that sets a single `isPaused` boolean, which every media type respects in its own way — `<video>` gets `.pause()` called on it directly, and the webpage type gets told via `postMessage` since there's no DOM element on this side of the iframe boundary to control directly:

```tsx
iframeRef.current.contentWindow.postMessage(
  { type: 'SET_AUDIO', volume: settings.is_muted ? 0 : settings.volume, isPaused },
  '*'
);
```

That's a contract the embedded page has to opt into listening for — it's not something we can force on arbitrary third-party content, but it means a wallpaper page built to be LiveWall-aware can respect mute and pause state instead of just playing audio into the void whenever the user's on a call.

**Autostart** goes through `tauri-plugin-autostart` rather than hand-rolling a registry `Run` key entry, mainly because it already handles the cross-platform cases (LaunchAgent on macOS, a `.desktop` autostart entry on Linux) even though the only platform this actually ships on today is Windows:

```rust
.plugin(tauri_plugin_autostart::init(
    MacosLauncher::LaunchAgent,
    Some(vec!["--autostart"]),
))
```

**The tray icon** is the whole entry point once the app's running — the wallpaper window has no titlebar and no taskbar presence by design, so `TrayIconBuilder` with a two-item menu (Settings, Quit) is the only UI surface the user interacts with day to day:

```rust
TrayIconBuilder::new()
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(move |app, event| match event.id.as_ref() {
        "settings" => { /* show or spawn settings window */ }
        "quit" => { std::process::exit(0); }
        _ => {}
    })
    .build(app)?;
```

## In conclusion

The entire reason this project exists is because I wanted a live wallpaper without feeling like I had another full desktop application permanently running in the background.

The stack helps here. Tauri ships a tiny Rust backend instead of embedding another Chromium instance like Electron, so the installed application ends up being surprisingly small. A production build installs in well under a minute on my machine, and the final installed size is only around **10 MB**.

Memory usage was the metric I cared about most. With a one-minute MP4 video set as the wallpaper, the application settles at roughly **85.2 MB of RAM** during normal playback. That's not "free" by any means, because decoding video and rendering it through WebView2 still costs memory, but it's small enough that I can comfortably leave it running all day on an **8 GB laptop** without feeling like I've sacrificed a meaningful chunk of my available RAM.

That was really the design target from day one. Existing wallpaper applications are feature-rich and support everything from particle systems to game engine scenes, but I wasn't trying to compete with that ecosystem. I wanted something focused: images, videos, and webpages, packaged into an application that starts quickly, stays out of the way, and doesn't make me think twice about leaving it running.

Because the wallpaper is ultimately just a normal React application running inside a WebView2 instance, there's also very little framework-specific magic once everything is attached to the desktop. Most of the engineering effort went into making the application disappear: keeping itself attached after Explorer restarts, synchronizing multiple windows, recovering from invalid configuration, respecting battery state, and generally behaving like a native part of Windows instead of another application sitting on top of it.

The result is exactly what I set out to build: a lightweight, open-source wallpaper engine that does the essentials well. It isn't trying to replace Wallpaper Engine, and it isn't trying to render an Unreal Engine scene behind your desktop icons. It's simply a small application that lets me have a live desktop without paying a large resource cost for it.

It's open-source, MIT licensed. Repo's here if you want to look closer or throw a PR at it: **https://github.com/emjjkk/livewall**.

You can even just... use it. I would be flattered.

Thank you for reading :)
