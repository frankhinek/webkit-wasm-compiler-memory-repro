# WebKit WebAssembly compiler memory repro

A reduced test case for [WebKit bug 304810](https://bugs.webkit.org/show_bug.cgi?id=304810), "High memory usage in WASM compilation thread".

**Try it:** open https://frankhinek.github.io/webkit-wasm-compiler-memory-repro/ in Safari on a Mac or an iPhone and tap **Asyncify build**.

The page runs a small in-memory SQLite workload in four instances of the unmodified `@journeyapps/wa-sqlite` 2.0.4 Asyncify build. The JavaScript work finishes in about one second. In Safari 26.6.1 on macOS, the tab's web content process then climbs to about 4 GiB over the next several seconds, with threads in JavaScriptCore's optimizing WebAssembly compiler (OMG) and its greedy register allocator. The allocation is transient.

Two controls use the same page and workload:

- **Padded:** the same Asyncify module with its three function bodies over 40 KB made too large for OMG. Nothing added executes. The peak stays under 1 GiB.
- **Non-Asyncify:** the synchronous build from the same package. The peak stays under 0.5 GiB.

On an iPhone 16 Pro with iOS 26.6.2, jetsam killed the Asyncify tab at the per-process memory limit in 4 of 4 runs, 5 to 6 seconds after the work, and Safari reloaded it. The padded and non-Asyncify builds were not killed in two runs each.

## What the page does

- Runs on the main thread, with no worker, no persistent storage and no asynchronous VFS. SQLite uses wa-sqlite's example `MemoryVFS`.
- Creates four module instances one after another. Each one:
  - creates a table with two indexes;
  - inserts 5,000 rows of about 512 bytes in 250-row transactions;
  - runs 200 rounds of two indexed queries and one update;
  - checks the row count.
- Keeps every instance referenced after the work, so nothing is collected during the observation window.

## Results

Measured on 2026-09-14:

| Item | Value |
| --- | --- |
| Browser | Safari 26.6.1 (20624.5.1.18.3) |
| System | macOS 15.7.9 (24G830) |
| Hardware | Mac16,7, 48 GB |
| Measurement | `tools/measure-safari.mjs`: one SafariDriver automation session per run; physical footprint of that run's web content process, sampled every 100 ms |

### Controlled comparison

Four module instances; three runs per build, interleaved.

| Build | Peak footprint | Peak time after the JavaScript work finished |
| --- | ---: | ---: |
| Asyncify, unmodified | 4,082 / 4,176 / 4,004 MiB | 3.9 to 6.9 s |
| Asyncify, three bodies over 40 KB padded | 880 / 783 / 843 MiB | 0.1 to 0.2 s |
| Non-Asyncify, unmodified | 368 / 362 / 440 MiB | 0 to 0.1 s |

### iPhone 16 Pro, iOS 26.6.2

The phone ran iOS 26.6.2 (23G90); Safari's user agent reports version 26.6.1. Runs used the same page and defaults, opened from the phone over HTTPS, one fresh tab per run. They came in two sessions. A device log was collected over USB after each session, and together the logs cover all eight runs.

| Build | Runs | JavaScript work | Web content process killed | Kill time after the work |
| --- | ---: | ---: | --- | ---: |
| Asyncify, unmodified | 4 | 1.95, 3.10, 1.57, 2.35 s | 4 of 4, jetsam `per-process-limit` | 5.9, 4.9, 5.9, 5.0 s |
| Asyncify, three bodies over 40 KB padded | 2 | 2.23, 2.45 s | 0 of 2 | none |
| Non-Asyncify, unmodified | 2 | 0.96, 1.12 s | 0 of 2 | none |

Each kill shows the same sequence in the device log:

1. RunningBoard reports exit status `domain:jetsam(1) code:per-process-limit(7)` for the tab's `com.apple.WebKit.WebContent` process.
2. `ReportSystemMemory` logs `killed by jetsam reason per-process-limit`.
3. MobileSafari logs `WebPageProxy::dispatchProcessDidTerminate: reason=Crash`.
4. The recovery reload reaches the server within 0.3 s.

Background processes were also jetsammed with code 17 within about 3 seconds of each Asyncify kill. No such kills were logged during the padded and non-Asyncify runs.

Kill times compare the page's "done" event, as received by the server, with the device log timestamps. Both clocks agree to within about 0.1 s.

After the fourth kill, the reloaded page reported loading again 5.3 s after the work finished, as a `back_forward` navigation.

### Module instances

Asyncify build.

| Instances | Rounds per instance | Peak footprint |
| ---: | ---: | ---: |
| 1 | 1 | 1,117 MiB |
| 2 | 1 | 2,105 MiB |
| 4 | 1 | 4,004 to 4,176 MiB (the three runs above) |
| 1 | 3 | 1,183 MiB |

The peak grows with the number of module instances, not with the amount of SQL work. Each instance appears to compile its own optimized code.

### Padding only the two largest bodies

Padding only the two largest bodies left peaks of 2,191, 2,279 and 2,214 MiB. The third body over 40 KB also had to be padded. These three runs used an earlier version of the runner that opened background tabs instead of automation sessions. That runner's other results matched the table above to within about 0.2 GiB.

### Where the memory goes

A `sample` and a `footprint` capture were taken when a run's process had grown by 768 MiB.

- **Asyncify runs:** every capture shows threads in `JSC::Wasm::OMGPlan::work`, `JSC::Wasm::parseAndCompileOMG` and `JSC::B3::Air::allocateRegistersByGreedy`. `footprint` assigned most of the process to `WebKit malloc`, for example 1,092 MB of 1,183 MB at capture time.
- **Padded runs:** two of the three crossed the capture threshold. One capture shows some OMG work on other functions and the other shows none. Neither run's memory peaked after the work.
- **Non-Asyncify runs:** none grew enough to be captured.

### Which functions

The package ships no name section, so the padded functions are identified by index and size only:

| Defined function | Module index (69 imports first) | Body size |
| ---: | ---: | ---: |
| 2818 | 2887 | 75,912 bytes |
| 2607 | 2676 | 54,057 bytes |
| 775 | 844 | 48,012 bytes |

## Running it

### Serve locally

```sh
node serve.mjs
```

Open http://127.0.0.1:8471/ in a new Safari tab. Click one build, then watch that tab's web content process in Activity Monitor for about 20 seconds. Use a fresh tab for each build.

### Measure on a Mac

One-time setup in Safari: Settings > Advanced > "Show features for web developers", then Develop > "Allow Remote Automation".

```sh
node tools/measure-safari.mjs --reps=3
```

- Each trial runs in its own Safari automation session through SafariDriver, which opens a window and closes it afterwards. Avoid using Safari during a run.
- Safari allows one automation session at a time, so the runner refuses to start while another `safaridriver` is running.
- Results go to `results/`, which is not committed. They include per-process samples and, for large rises, `sample` and `footprint` captures.

### Run on an iPhone or iPad

Host this directory on any static web host, or run `node serve.mjs --host=0.0.0.0` on the same network. Open the page in Safari and tap **Asyncify build**.

If the web content process is killed during the work or within a minute after it, Safari reloads the tab. The page then reports how long after the work it loaded again.

iPhone results are under Results above. To attribute a reload, collect the device's unified log afterwards, for example with `log collect --device-name`. Then look for the RunningBoard exit status of the `com.apple.WebKit.WebContent` process.

### Page options

URL query parameters:

| Parameter | Values | Default |
| --- | --- | --- |
| `build` | `asyncify`, `asyncify-padded`, `sync` | none |
| `modules` | number of instances | 4 |
| `rows` | rows per instance | 5000 |
| `rounds` | workload rounds per instance | 1 |
| `autostart` | `1` starts the chosen build on load | off |

## How the padded control is built

```sh
node tools/pad-wasm.mjs inspect vendor/wa-sqlite/dist/wa-sqlite-async.wasm --count=10
node tools/pad-wasm.mjs pad vendor/wa-sqlite/dist/wa-sqlite-async.wasm variants/asyncify-padded/wa-sqlite-async.wasm --top=3
```

- **Change:** each chosen body gets `block; br 0; nop x N; end` after its locals, growing it to 160,000 bytes. The branch skips the nops, so no added instruction executes.
- **Effect:** JavaScriptCore does not OMG-compile bodies larger than `maximumOMGCandidateCost`, which has been 100,000 bytes since [WebKit commit b34d02f4bcef](https://github.com/WebKit/WebKit/commit/b34d02f4bcef).
- **Validation:** the tool checks that the result validates and that imports and exports are unchanged. `variants/asyncify-padded/manifest.json` records the hashes.
- **Scope:** padding is a diagnostic control, not a recommended mitigation.

## Related reports

- **[WebKit bug 309251](https://bugs.webkit.org/show_bug.cgi?id=309251):** wa-sqlite IndexedDB page reloads on iOS 26. It was closed as a duplicate of 304810, and its reporter saw it fixed in the iOS 26.5 beta. This test case still reaches about 4 GiB in Safari 26.6.1.
- **Greedy register allocator fixes:** several were resolved in March 2026, for example [307107](https://bugs.webkit.org/show_bug.cgi?id=307107) and [309992](https://bugs.webkit.org/show_bug.cgi?id=309992).
- **[Emscripten issue 26027](https://github.com/emscripten-core/emscripten/issues/26027):** an earlier Asyncify report for Safari.
- **Not yet tested:** Safari Technology Preview.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `repro.js` | The test page |
| `serve.mjs` | Local static server that prints page events |
| `vendor/wa-sqlite/` | Unmodified files from `@journeyapps/wa-sqlite` 2.0.4; `PROVENANCE.json` has hashes |
| `variants/asyncify-padded/` | Padded Asyncify module, unmodified loader, manifest |
| `tools/pad-wasm.mjs` | Inspects and pads function bodies |
| `tools/measure-safari.mjs`, `tools/sample-footprint.py` | macOS measurement |
| `THIRD-PARTY-NOTICES.md` | Licenses for wa-sqlite, SQLite and Emscripten |
| `LICENSE` | MIT License for this repository's own files |

## License

This repository's own files are available under the MIT License; see `LICENSE`.

The files in `vendor/wa-sqlite/`, and the padded module derived from them in `variants/`, keep their original licenses: wa-sqlite under MIT, SQLite in the public domain, and Emscripten's runtime under MIT or the University of Illinois/NCSA Open Source License. See `THIRD-PARTY-NOTICES.md`.
