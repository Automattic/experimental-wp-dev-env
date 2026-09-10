# Keeping a site up to date with trunk

A site is a clone of `wordpress-develop` frozen at the moment it was created, so it starts drifting behind trunk immediately. You never have to create a new site to get newer code.

The header of each site shows which snapshot it currently holds — for example `trunk as of 5 Aug 2026`.

## Update to latest trunk

**Update to latest trunk** lives in the ☰ **More** menu at the top right of any site. It brings an existing site up to the current trunk: it fetches the newest commits, reinstalls dependencies if `package-lock.json` moved, and rebuilds.

![The More menu with Update to latest trunk](/screenshots/site-menu.png)

This option is always there — on every site, at any time, no matter how old or new the snapshot is and whether or not the app has flagged it as stale. If nothing has moved, you simply get "Already up to date." in the terminal.

The update fetches from the site's own `origin` remote. A site the app created points at `WordPress/wordpress-develop`; a site you added from an existing checkout of a fork keeps fetching from that fork. A checkout with no `origin` remote cannot be updated; the terminal says so and how to add one.

You no longer have to stop the dev server first. The update pauses the [build watch](./running-the-site#the-build-watch) for the rebuild and resumes it afterwards, and the PHP server keeps serving throughout.

What it will not run alongside is another install or build. The **Update to latest trunk** button in the staleness notice is disabled while one is running — but the ☰ menu entry is not, and clicking it in that state simply does nothing, with no message to say why.

## What an update runs

The update always shows the same three steps in a progress card, with a "step N of 3" counter:

1. **Fetch and reset to trunk** — pull the newest commits and reset the checkout to them. If you have uncommitted changes the app stops and asks first, offering **Save them as a patch first (as a local file)** or **Discard them** — the second loses the work and cannot be undone. When you choose to save, the summary afterwards tells you where the patch went. If a merge started outside the app is waiting in the checkout, the update is refused before anything moves, because the reset would erase it; finish or abandon that merge from a terminal first, as described in [If a merge is in progress](ticket-branches#if-a-merge-is-in-progress).
2. **Install dependencies** — runs only if `package-lock.json` changed between the old and new trunk; otherwise the step is shown as "Dependencies unchanged — skipping npm install". When it does run, most packages are already cached, so it downloads the difference, not the whole tree.
3. **Rebuild** — rebuild the `build/` directory so it matches the new source.

![The Updating to latest trunk card at step 1 of 3, fetching and resetting to trunk before install and rebuild](/screenshots/trunk-update-progress.png)

When the chain finishes, a green summary reads **Up to date with trunk as of today.**, along with whether dependencies changed, how long the rebuild took, and the path of any saved patch. Updating typically takes a few minutes.

## Updating while you are on a ticket

An update moves trunk, and your ticket's work is not on trunk — so the app steps around it. The terminal says *Parking your work on ticket/59234 before updating…*, the three steps run against trunk, and then *Returning to your work on ticket/59234…* puts you back where you were, with the ticket still linked and its changes still in the tree.

The dialog in step 1 only ever concerns edits that are loose in the working tree. Work already parked on a ticket branch is never what it is offering to save or discard.

What an update does not move is the snapshot your ticket branch was created on. That is deliberate — it is what keeps your patch free of the upstream changes the update just brought in — but it means an old ticket's patch does not get any newer by updating the site. The same is true for every other ticket stored on the site: updating trunk does not rebase any of them.

After the update, the **Trac ticket** card may say **Trunk has moved since this ticket started**. That is not an incomplete update: trunk is current and the ticket is still safely on its original base. To move the work forward, click **Update this ticket to the current trunk** in that notice, or save its patch, unlink it, delete its branch, link the ticket again, and apply the saved patch. The app never changes a ticket's base without one of those explicit actions. See [When trunk has moved since the ticket started](./ticket-branches#when-trunk-has-moved-since-the-ticket-started).

## Staleness dots and notices

The app flags sites that have fallen behind with a coloured dot next to the site name in the sidebar:

- **Amber** — the snapshot is more than 14 days old. The site view also shows a notice — "This site's WordPress code is N days old" — warning that patches you create now may not apply on Trac, with an **Update to latest trunk** button.
- **Red** — a previous update moved the code but never finished installing or rebuilding, so the built assets no longer match the source. Run the update again.

![The stale-site notice with its Update to latest trunk button](/screenshots/stale-site-notice.png)

## When an update does not finish

If the fetch succeeds but install or build fails, the site view shows a red banner: **Update incomplete** — the code is new but the built assets are old, and the site may not run correctly until install and build succeed. Click **Retry install & build** to run only the missing steps; the fetch is not repeated. The sidebar dot stays red until this succeeds.

![The Update incomplete notice with its Retry install and build button](/screenshots/update-incomplete.png)

## Staleness is judged locally

Staleness is judged locally, from the date of the commit your site is sitting on, and never by asking GitHub what the tip of trunk is. That keeps the app working offline and stops it from making a network request every time it launches. Two consequences worth knowing:

- A site created today is never marked out of date, even though trunk gets commits several times a day and yours is already behind by a few. Flagging that would mark every site stale within hours of creation, which makes the warning worthless.
- The only way to find out exactly how far behind you are is to run the update.
