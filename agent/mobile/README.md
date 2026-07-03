# finch Android SDK (`finch.aar`)

Embed the finch relay in an Android app so the app can **publish a local service**
— an MCP server, a web app, any HTTP/WS endpoint it runs on `127.0.0.1` — through
the finch hub, with **no inbound ports** (the device dials out). It's a thin
[gomobile](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile) wrapper over the
same Go relay engine the `finch` CLI uses (`agent/core`), so the protocol, auth,
and SSRF confinement are identical.

## Build

```sh
cd agent
./scripts/build-aar.sh        # -> agent/build/finch.aar (+ finch-sources.jar)
```

Requires Go + an Android SDK/NDK (the script defaults `ANDROID_HOME` to
`~/Library/Android/sdk` and auto-picks the newest NDK; override via env). The
first build installs `gomobile`/`gobind` and adds `golang.org/x/mobile` to
`go.mod` (expected — the CLI binary never imports `./mobile`, so it's unaffected).

Drop `finch.aar` into your app's `app/libs/` and add:

```gradle
dependencies {
    implementation files("libs/finch.aar")
}
```

## Use (Kotlin)

```kotlin
import com.finchmcp.finch.Config
import com.finchmcp.finch.Finch
import com.finchmcp.finch.Listener
import com.finchmcp.finch.Service

// 1. Your app runs some local server first, e.g. an MCP server on 127.0.0.1:8080.

// 2. Configure finch. CredentialPath must be writable (use filesDir).
val cfg = Config().apply {
    hub = "https://finchmcp.com"
    appPath = "myapp"                       // the service the ticket was minted for
    upstream = "http://127.0.0.1:8080"      // your local server
    credentialPath = "${filesDir}/finch.json"
    machine = "pixel-" + Build.SERIAL        // a stable box name
    forwardAll = false                       // true to host a website / arbitrary HTTP
}

val svc: Service = Finch.newService(cfg, object : Listener {
    override fun onState(state: String, detail: String) {
        // background thread — marshal to the UI thread yourself.
        Log.i("finch", "$state: $detail")
    }
})

// 3. ONCE per box: trade a dashboard ticket ("Add box") for a saved
//    credential. Do this off the main thread (it does network I/O).
svc.enroll(ticketFromDashboard)   // throws on a bad/expired ticket

// 4. Start/stop the relay. Start returns immediately; the relay runs in the
//    background and reconnects on its own.
svc.start()
// ... later, e.g. in onDestroy:
svc.stop()
```

After `enroll`, subsequent app launches just call `start()` — it resumes from the
saved credential, no ticket needed.

## API

| Member | Description |
| --- | --- |
| `Finch.newService(cfg, listener)` | Create a relay. `listener` may be null. |
| `Service.enroll(ticket)` | One-time: ticket → saved credential. Throws on failure. |
| `Service.start()` | Begin relaying in the background (non-blocking, auto-reconnect). |
| `Service.stop()` | Cancel the relay. Idempotent. |
| `Service.running` | Whether the relay loop is active. |
| `Config` | `hub, machine, appPath, upstream, credentialPath, forwardAll`. |
| `Listener.onState(state, detail)` | `connecting / enrolled / live / connected / reconnecting / warn / stopped`. |
| `Finch.version()` | The agent version this SDK was built from. |

> The Java package is `com.finchmcp` (set via `-javapkg`); gomobile nests the Go
> package, so classes live in `com.finchmcp.finch`. The constructor/free funcs
> (`newService`, `version`) are static methods on the generated `Finch` class.
