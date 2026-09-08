# Getting started

The WordPress Contributor Toolkit is a desktop application for macOS (Apple Silicon), Windows, and Linux that sets up a full WordPress core development environment with zero prerequisites.

You install it, choose a directory for `wordpress-develop`, click a button, and you have:

- A cloned `wordpress-develop` repository
- A running WordPress dev server
- The ability to make code changes and turn them into a patch or pull request

No Git, no Node.js, no npm, no Docker needed. Everything is bundled inside the application as JavaScript/WASM, powered by [WordPress Playground](https://wordpress.github.io/wordpress-playground/).

::: tip Prepare at home before Contributor Day
Creating your first site downloads the full `wordpress-develop` repository, installs its dependencies, and runs the first build. That means downloading a lot of files, so we recommend having at least one site fully set up a day or a few days before the event.

On Contributor Day, open that site and run [**Update to latest trunk**](./trunk-updates). The app fetches the changes made since your initial setup and only reinstalls dependencies if they changed. Most packages will already be cached, which uses far less of the venue's shared bandwidth than starting from scratch.
:::

## Install the app

<DownloadButton />

Download the latest build for your platform with the button above, then open the app.

### If macOS blocks the app

The app is signed and notarized by Automattic, so macOS should open it without issues. If Gatekeeper still blocks it (this can happen when the file was downloaded via a browser), try either of these:

- Right-click the `.app` file and choose **Open**, then confirm in the dialog that appears.
- Or remove the quarantine attribute from the `.app` bundle itself:

  ```sh
  xattr -d com.apple.quarantine "WordPress Contributor Toolkit.app"
  ```

  ::: warning Use `-d`, not `-dr`
  The app is code-signed. The recursive flag (`-r`) tries to strip attributes from files inside the sealed bundle, which macOS rejects with permission errors. Removing the attribute from the top-level bundle is sufficient.
  :::

## Your first contribution, in seven steps

1. Click **Create WordPress Core site** and choose a destination folder for your site.
2. Wait. The app downloads `wordpress-develop`, then installs the dependencies and runs the first build on its own — go and get a coffee. See [The setup wizard](./setup-wizard).
3. Click **Start dev server**.
4. A browser window opens automatically. If not, open it by clicking the site URL — or the **wp-admin** link beside it, to go straight to the dashboard.
5. Make changes to the code — [open the site in your editor](./editors) straight from the app.
6. Click **Review & submit changes** to see a diff of everything you changed.
7. Pick where the patch goes: [a pull request](./submit-github-pr), [a Trac ticket](./submit-trac), or [a file for your mentor](./submit-mentor).

That's it — you've contributed to WordPress core.

::: tip You are not left guessing what to do next
When a site has something pending — a setup step to run, a warning to act on, work in flight — that one block is ringed in amber and scrolls itself into view, and is announced to screen readers as *Next step: …*. A site that is set up, running and clean has nothing pending, so nothing is ringed. And when an action finishes — a patch saved, trunk updated, a pull request opened — a brief notice says so out loud rather than leaving you to check.
:::

![A site ready for work: Start dev server, Start build watch, Review & submit changes, the Trac ticket panel and the patch panel](/screenshots/site-view.png)

The rest of this guide walks through each of these screens in detail, starting with [creating a site](./creating-a-site).

::: tip A second ticket does not need a second site
Every ticket you link gets its own branch inside the site and keeps its own work, so moving between two of them takes seconds instead of another clone and another install. See [Working on several tickets](./ticket-branches).
:::

::: tip You never need a new site to get newer code
**Update to latest trunk**, in the ☰ menu at the top right of any site, is available at any time on any site, however old: it fetches the latest trunk, reinstalls dependencies if they changed, and rebuilds. See [Staying up to date with trunk](./trunk-updates).
:::

## How it works under the hood

- Git operations run on a Git binary bundled inside the app (never one installed on your machine): cloning, switching tickets, updating trunk, applying patches. Reading a patch and generating one are done by the app itself.
- Node scripts and npm commands run on the Node.js runtime bundled with the Electron app. A small shim directory is injected into the `PATH` so subprocesses find `node`, `npm`, and `npx` without a system install.
- The WordPress server runs on `@wp-playground/cli` from [WordPress Playground](https://wordpress.github.io/wordpress-playground/), backed by SQLite.
- Patches are generated with the `diff` npm package.
