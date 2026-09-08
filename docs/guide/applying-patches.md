# Applying patches and PRs

The **Apply a patch or PR** panel applies a pull request or a `.diff`/`.patch` file to your site's checkout and rebuilds, so you can test someone else's work before adding your own. Your own changes are left alone.

![The Apply a patch or PR panel, with a field for a pull request URL and a link to choose a patch file](/screenshots/apply-patch-panel.png)

## Choose what to apply

There are three ways to get a patch into the panel:

- Paste a pull request URL or number into the field and click **Apply PR**.
- Click **or choose a .diff / .patch file…** and pick a file from disk.
- Click **Apply…** next to a pull request or attachment in the [Trac ticket panel](trac-tickets).

## The preview

Nothing is changed yet. The panel first shows what the patch would do:

- The list of files it changes.
- A warning if this ticket already has work in any of those files, measured from the trunk snapshot the ticket started on. The warning names your own edits and changes from an applied patch separately; a file from an applied patch may contain your edits too. The new patch is applied on top of that work: it succeeds if the changes do not overlap, and fails without touching anything if they do. Save a patch of your work first if you want a copy — see [Submitting your changes](submitting-changes).
- Which files are binary and will be skipped: a patch that carries a binary file's data (a pull request's `.diff` does) applies it; one that only says the file differs cannot, and names it instead.
- Whether it changes `package-lock.json`, in which case dependencies will be installed before the rebuild.

Click **Apply and rebuild** to go ahead, or **Cancel** to back out.

The apply itself is Git's own `git apply`, the same command whoever receives your patch will run, so "does it fit" means the same thing on both ends. It is all or nothing: when any part of the patch does not fit, nothing is written, and the panel says which files and, inside each, which regions. Files the patch adds stay unstaged, as they always did.

## Apply and rebuild

The panel shows each step as it runs: applying the patch, installing dependencies if needed, and rebuilding. When it finishes, the panel reports what is applied — the patch's name, how many files it changed, and when.

If the [build watch](running-the-site#the-build-watch) is running and the patch does not move `package-lock.json`, there is no build step: the patch is applied and left for the watch to compile, and the checklist says so. A patch that does move the lockfile has to install and build, so it pauses the watch for the duration and resumes it after — the dev server stays up throughout.

## When a patch will not apply

The apply is all-or-nothing. If anything fails, nothing is written to your checkout — but the panel now tells you *how much* failed, because one region of twenty missing and all twenty missing are opposite decisions for you.

![A pull request that does not fit this checkout, with the affected file named and confirmation that the checkout was not changed](/screenshots/apply-patch-conflict.png)

The headline is a count, not an adjective: *4 of this patch's 20 changes across 3 files no longer fit — the other 16 do.* When every change is already in your checkout — which is what a patch that has since been committed to core looks like — it says that instead, rather than reporting the patch as dead.

### For a patch file or a Trac attachment

You get the full breakdown, because you are the only one who can rescue it. Each file lists its failing regions, and each region says **why**:

- **the code around it has changed** — the patch was written against an older trunk and the lines it expected have moved.
- **looks like it is already in your checkout** — that change is present. The app tells the two apart by testing whether the region's reverse fits.

Every region carries an **anchor line taken from your own file** to search for. A hunk's line numbers are coordinates in the file as its author had it, so on an old patch they miss by exactly the drift that made it fail; a line you can search for does not. The first few regions of each file also show the lines the patch wanted to add and remove — enough to recognise the change without turning the panel into the diff itself.

### For a pull request

The panel first separates two situations that need different next steps.

If the failures are only in files this ticket has not changed, the pull request was written against an older trunk. The notice names the situation and its scale — *this pull request was written against an older trunk and no longer fits it: 4 of its 20 changes, in 3 files, would need rework* — without the line-level detail. Bringing it up to date is its author's work, so the useful contribution is to leave a comment asking for a rebase or for trunk to be merged in.

If your ticket already has work in a failing file, the app does not blame the pull request's author. A file-level overlap cannot prove which exact lines caused the failure, so the notice says your work *may* be involved. Save a patch of your work, try the pull request on a clean ticket, and ask its author to update it only if it still fails there. When the file includes changes from a patch you already applied, the notice names that patch too rather than calling all of the file your own writing.

A **closed** pull request is read differently, because on `wordpress-develop` "closed" is also what landing looks like — core commits go through SVN and the pull request is closed, never merged. If all its changes read back as already in trunk, the panel says it was likely committed to core and there is nothing left to apply. Otherwise it says nobody is coming back to update it, and offers **See why it was closed**.

### The way out

When the ticket has other patches on it — another pull request, another attachment — the panel offers them. It only does so when there is genuinely one to try: a way out that lands you back at the same dead end costs a click to discover.

## Applied patches belong to a ticket

What is applied is recorded as a named layer on the ticket you are on, separate from your own edits. Switch to another ticket and the green "applied" box goes with the first one; switch back and it is there again, naming the patch, how many files it changed, and when it was applied. The preview and failure notices continue to distinguish that layer from your writing.

A ticket holds one applied patch or pull request at a time. Revert it, or discard the ticket back to its base, before applying another. See [Working on several tickets](ticket-branches).

## Reverting an applied patch

While the saved patch can still be removed cleanly, the panel shows it in a green box with a **Revert this patch** button. Reverting removes the patch's changes and rebuilds, again leaving your own edits alone.

If you edit lines the patch brought in, it can no longer be lifted back out without also disturbing your work. A failed Revert changes the explanation accordingly: the patch is part of your changes now. Undo your edits on the named regions to make **Revert this patch** work again, or **Save a copy of your work** and **Discard this ticket to its base**.

For very large patches, the app does not keep the copy it would need for an undo, so they never offer Revert. The amber box says so and offers the same copy-and-discard route. Until the ticket is reverted or discarded, the patch still occupies its one applied-patch slot.

**Update to latest trunk** is not an escape hatch for a patch on a ticket. It parks the ticket branch, updates trunk, and checks the same branch back out afterwards — applied patch and all — so it leaves you where you were. See [Staying up to date with trunk](trunk-updates).

## Your own changes

Applying and reverting patches never discards your own edits. The only risk is overlap: if a patch touches the same lines you changed, the apply fails cleanly rather than mixing the two. The preview names the files where you both have changes, so you see this before pressing anything.

## Next steps

- [Link the ticket you are testing](trac-tickets)
- [Submit your own changes](submitting-changes)
