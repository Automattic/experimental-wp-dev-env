# Testing

Everything about tests in this repository: what to run, what the suite is made of, and where a new test belongs. [CONTRIBUTING.md](CONTRIBUTING.md) points here rather than repeating any of it.

## What to run

```
npm test                    # the fast suite — layers 1–3, under three seconds
npm run test:e2e            # the app, driven — layer 4, seconds
npm run lint                # ESLint over the whole repo
```

`npm test` is the one to run without thinking about it. It touches no network: the single suite that needs a Git remote starts a loopback server and serves the repository to itself.

Two more, for when you need them:

```
npm run test:electron       # the fast suite again, on the Node that Electron bundles
npm run test:e2e:packaged   # the built artifact — needs a build first, see below
```

To run one file: `node --test tests/unit/azure-sign.test.cjs`. To run one journey: `npx playwright test --project=journeys -g "switching back"`. A journey opens and closes the app as it goes; there is no headless mode and nothing to turn off. To advance a journey a step at a time instead of letting it run, see [Stepping through a journey by hand](#stepping-through-a-journey-by-hand).

## The five layers

"Add a test" is not a single instruction here. There are five places a test can go, and putting one in the wrong place is how a suite gets slow without getting better. All five are under `tests/`:

```
tests/
  unit/            layers 1-3 — npm test — under three seconds
    fixtures/      package.json trees the integration tests copy; not tests themselves
    helpers/       the bundled-Git driver the Git suites share; not a test either
  e2e/
    journeys/      layer 4 — npm run test:e2e
    packaged/      layer 5 — npm run test:e2e:packaged, and it needs a build first
    helpers/       the app session fixture and the Git site builder; not tests either
```

Two directories, because the split that matters is what a test costs to run, not what it covers: everything in `unit/` is a function call, and everything in `e2e/` launches the app. The layers below subdivide that, and the file name says which — a layer-2 test is `*.integration.test.cjs`, and anything under `e2e/` is `*.spec.js`.

They are listed cheapest first, and that ordering is the rule: **write a test at the highest layer that can still see the failure.** What each layer is blind to is the part worth reading — it is what sends a test one layer up, or down.

**1. Unit** — `tests/unit/`. Starts nothing; calls plain functions. Pure logic: parsing a ticket reference, deriving a status, building a command line. Blind to anything touching disk, a process or a window.

**2. Integration** — the files named `*.integration.test.cjs`. Runs the real modules against real Git repositories in a temporary directory. Proves Git does what the code assumes when it switches a branch, applies a patch or updates trunk. Blind to everything above the module boundary.

**3. IPC wiring** — one file, `tests/unit/ipc-wiring.test.cjs`. Loads the real `src/main.js` with `electron` replaced by a double, and exercises every handler: what each returns, what it rejects, what error it gives. Blind to the window, and its store is a stand-in rather than the real one.

**4. Journeys** — `tests/e2e/journeys/`. Starts the whole app, built from the source tree, and drives it. Asks the only question the other three cannot: can a contributor do their work without losing it. Blind to anything about packaging.

**5. Packaged smoke** — `tests/e2e/packaged/`. Starts the built artifact — the `.app` or `.exe` a user downloads — and asks whether it is whole. Blind to behaviour: it never gets as far as a flow.

Layers 1–3 are `npm test`. Layers 4 and 5 are the two `test:e2e` commands. That proportion — a great many cheap tests to a handful of expensive ones, orders of magnitude apart in what each costs — is the shape to keep.

## Where to put a new test

- **A pure function, a derived string, a decision with branches** → layer 1. If it lives inside `src/renderer/index.jsx` today, move it to a `src/renderer/*.cjs` module first: that component mounts at module scope and nothing in the suite can load it, so a decision made there is untestable by construction.
- **Anything that asks Git a question** → layer 2, against a real repository. There is a local Git server fixture in `tests/unit/trunk-update-fetch.integration.test.cjs` for cases that need a remote, because `isomorphic-git` has no `file://` transport.
- **A new IPC handler** → layer 3, plus the `contextBridge` entry in `src/preload.js`, which layer 5 checks is actually exposed.
- **A flow that spans the interface, the main process, Git and the store at once** → layer 4.
- **Something that can only break during packaging** → layer 5.

Keep layer 4 small on purpose. Every test there costs an app launch, and any assertion that does not need a window belongs one layer down.

The failures worth layer 4 are the ones that fall *between* the other layers, where every piece works and the whole does not. One example, found while writing the first journeys: the integration tests prove branch switching restores work correctly, and the wiring tests prove the delete handler returns the checkout to trunk when the deleted branch was the current one — but the interface leaves the currently linked ticket out of the list it offers delete controls for, so that branch of the handler cannot be reached by a contributor at all. Three layers passing, one path dead.

## The two end-to-end layers, and why they are separate

They run **the same source code in two different containers**, and each container has failures the other cannot have.

Layer 4 runs the code the way `npm start` does: `src/main.js` on disk, `node_modules` beside it. Layer 5 runs what `electron-builder` produces, where all of `src/` and every production dependency is compressed into a single `app.asar`, and native modules are pulled back out beside it because the operating system cannot load a binary from inside an archive. A path that resolves from a directory may not resolve from inside that archive; a native binary can be selected for the wrong runtime while `npm ci` and the packaging both exit 0 and the app still starts. Those failures do not exist in the source tree, because there is nothing packaged to get wrong.

So layer 5 asks only whether the container is intact, and **writes no state at all**.

That last part is a constraint, not minimalism. The app only honours a redirected application-data directory in development builds (`!app.isPackaged` in `src/main.js`); the packaged app always writes to the real site registry of whoever runs it. So a test that drives a flow cannot run against the artifact without writing to somebody's actual sites.

Layer 4 gets a throwaway application-data directory per test, and the harness reads back the path the app chose and **refuses to run** if it is not the throwaway one. Nothing a journey does can reach the sites you work on.

**The gap this leaves**, stated plainly: a flow that behaves differently *because* of packaging is caught by neither layer. Layer 5 covers it only indirectly — if the container is intact, the code inside it is the same code. Closing it properly would mean letting the packaged app accept a redirected data directory under a test-only condition, which is a seam in shipped software and is not worth opening until a failure of that shape actually escapes.

## Running the packaged smoke test

It needs an artifact, so build one first:

```
npm run build:once && CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:dir
npm run test:e2e:packaged
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` is mandatory on macOS — electron-builder signs during `--dir` without it — and harmless everywhere else. The test tells you if you forgot the build.

Neither end-to-end command downloads a browser. The only thing they launch is the Electron already in the tree, which is why CI has no `playwright install` step. The one exception is the Inspector, and it is opt-in — see above.

## Auditing an end-to-end test

A test that asserts nothing passes. For a suite whose entire content is tests, that is the risk that matters, and neither a green run nor a recording of one will tell you: both look identical whether the assertion is load-bearing or decorative.

**The way to audit a journey is to break what it claims and confirm it goes red.** One assertion at a time. Worked example — "switching back to a ticket restores its work byte for byte" says the contributor's edit comes back, so make that false and see whether the test notices:

```
# in tests/e2e/journeys/ticket-branches.spec.js, find the line asserting the edit came
# back — it ends `.toBe( MY_EDIT );` — and swap MY_EDIT for any other string:
#     .toBe( 'anything else' );

npx playwright test --project=journeys -g "switching back"   # must FAIL, on that line
git checkout tests/e2e/journeys/ticket-branches.spec.js      # put it back
```

If it stays green, the assertion is not reaching what it says it is, and the test is decoration. Every invariant in these journeys was checked this way before its pull request was opened; each is worth rechecking after a change to the code beneath it.

Two mistakes to avoid when doing this. Break **one** assertion per run, or a failure tells you nothing about which. And run the **single** test by name — the same expression often appears in more than one journey, and a mutation applied to the first occurrence while running a different test reports a green that means nothing.

**The second half of an audit is reading the test.** Roughly half of each journey happens on disk with no interface: the test edits a file, deletes another, and then reads the working tree back. None of that is on screen, and none of it can be watched. The twenty lines of the test are the description of what it does; there is no substitute for them.

<details>
<summary>Watching one run, and when that helps</summary>

Recording a run answers one narrow question — **is this driving the app, or passing through a shell that happens to satisfy its assertions?** — and helps with a CI failure on a platform you cannot reach. It does not tell you what a test does, for the reason above.

```
E2E_VIDEO=/tmp/e2e-video npm run test:e2e
open /tmp/e2e-video/switching-back-to-a-ticket-restores-its-work-byte-for-byte.webm
```

One `.webm` per test, named after it; a test that closes and reopens the app records both launches as `-1` and `-2`. They run about a second and a half at 25 frames per second, so step through them rather than pressing play.

To drive a run yourself rather than watch a recording of one, see [Stepping through a journey by hand](#stepping-through-a-journey-by-hand), below.

</details>

## Stepping through a journey by hand

To advance a journey one action at a time, driving each step yourself:

```
npx playwright test --project=journeys -g "switching back" --debug
```

That opens the Playwright Inspector and pauses before the first action. `--debug` is a shorthand for `--headed --timeout=0 --workers=1 --max-failures=1` with `PWDEBUG=1` set, and **`--headed` is the load-bearing part here**: without it the Inspector never attaches to an Electron test and the run finishes at full speed, unpaused. `PWDEBUG=1` on its own — the incantation the Playwright documentation gives, and the one this file used to give — does nothing at all to a journey. Checked against Playwright 1.62.1 by running it both ways.

To stop somewhere other than the first action, put a pause in the spec at the point you care about and run headed:

```
# in the spec:
await page.pause();

npx playwright test --project=journeys -g "switching back" --headed --timeout=0
```

Everything before the pause runs at full speed. `--headed` is required for the same reason as above, and `--timeout=0` because `playwright.config.js` sets a 60 second `timeout` that would otherwise end the session while you are reading it.

Three things worth knowing before you do either:

- **Name a single test.** With no `-g` you are hand-stepping every journey in the project, one after another.
- **The Inspector is a browser window**, so it needs `npx playwright install chromium` once — the only browser this repository ever wants, and nothing else here uses it. Without it the run pauses with nothing to drive it from, which reads as a hang.
- **The app window is real and yours to poke**, which cuts both ways: a click you make is a click the remaining assertions did not expect. Once you have driven it by hand, end the run rather than reading anything into what it does next.

The Inspector has the same blind spot as a recording, and it is the one from the audit above: it knows Playwright's actions and nothing about the filesystem steps between them. A journey that edits a file, deletes another and reads the working tree back steps straight past all of it. Read the spec alongside.

## Reading a failure

Every end-to-end failure keeps a Playwright trace:

```
npx playwright show-trace test-results/<the failing test>/trace.zip
```

For an Electron test that trace is an action log rather than a replay: each step, its timing and the line of source it came from.

A failing journey also attaches the screen at the moment it failed and the state the app had persisted, because the interesting half of a failure in this app is usually on disk rather than on screen. In CI both come back as a workflow artifact.

## What CI runs

Three workflows, on every pull request and on push to `trunk`. None needs a secret.

**[`lint.yml`](.github/workflows/lint.yml)** — `eslint . --max-warnings=0` over the whole repo. It installs with `npm ci --ignore-scripts`, so linting never executes the pull request's code.

**[`unit-tests.yml`](.github/workflows/unit-tests.yml)** — layers 1–3 on macOS and Windows, and on each platform **twice**: once on the system Node pinned in `.nvmrc`, once on the Node that Electron bundles. That second pass is not redundant. Child processes in this app run on Electron's own Node, and the two versions are set independently and have drifted before (#37/#46).

**[`e2e.yml`](.github/workflows/e2e.yml)** — layers 4 and 5 on macOS and Windows, as two jobs for every pull request that is not a draft. They are separate because they cost very different amounts: the journeys take seconds, and packaging takes several minutes per platform.

Every matrix uses `fail-fast: false`, so a Windows failure never hides the macOS result.

## Conventions

- **`npm test` is separated from the end-to-end suite by filename, not by directory.** `node --test` is run with no path at all, so it walks the whole repository and collects by name: `*.test.cjs` and four other shapes Node treats as test files — `*-test.cjs`, `*_test.cjs`, `test-*.cjs`, `test.cjs`. The journeys are `*.spec.js`, which matches none of them. Now that both suites live under `tests/`, that naming is the only thing keeping them apart, and a file under `tests/e2e/` named any of the five would silently join the fast suite and cost it an app launch. **End-to-end files are `.spec.js`.** The separation is worth defending: the fast suite has to stay something you run without thinking.
- End-to-end selectors read the text and roles already on screen. No `data-testid` — the visible copy is the contract, and renaming a button is a change worth noticing.
- Journeys mark each assertion as an **invariant** (must hold under any model of how work is stored) or a **characterisation** (true because of how the app stores things today). A red invariant is a bug; a red characterisation is a prompt to read it and update it deliberately.
- A bugfix's test must fail on the old code. A test written after the fix pins whatever the current behaviour is, rather than the correction.
- No test counts in this document. A number here is wrong the moment somebody adds a test, and nothing makes it go red — this file already carried a stale one. Say what a layer covers and roughly what it costs; `npm test` prints the total, and it is the only place that can be trusted to.

The full review standard, including what counts as a test-shaped finding, is in [`.github/instructions/code-review.instructions.md`](.github/instructions/code-review.instructions.md).
