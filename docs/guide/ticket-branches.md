# Working on several tickets

You do not need a second site to work on a second ticket.

A site is the expensive part: a clone of `wordpress-develop`, an `npm install`, and a first build — minutes of work, and the thing this app exists to spare you. A ticket is the cheap part. Each ticket you link gets its own branch inside the site, so moving between them is a file swap that takes seconds rather than another clone and another install.

Each ticket keeps its own work. What you edited for one ticket is not in the tree while you are on another, and the patch you submit for a ticket contains only that ticket's changes.

![A site with two tickets: the Trac ticket card for the one in hand, and an Other tickets on this site card under it](/screenshots/site-with-tickets.png)

## Starting a second ticket

While a ticket is linked, the **Trac ticket** panel shows that ticket rather than a field to type another one into. So starting a second ticket is two steps:

1. Click **Unlink**. Your work on the first ticket is parked on its branch and the site returns to trunk — nothing is lost, and the ticket appears under **Your tickets on this site**.
2. Type the second ticket's number into the field that is now back, and click **Link ticket**.

Nothing is installed and nothing is rebuilt: `node_modules` and the database belong to the site, and both stay exactly as they are.

The `build/` directory belongs to the site too, which has a consequence. A switch changes the source under `src/`, but it does not rebuild — so a dev server that is running keeps serving the assets built for the ticket you just left. Run `npm run build` in the [Terminal](./terminal) after switching if you want to see the other ticket's changes in the browser. The site view says the same thing: *Edited files in `src/`? Run `npm run build` so the site picks them up.*

## Your tickets on this site

The site's tickets get their own card, between the **Trac ticket** card and **Apply a patch or PR**. Like those two, it appears once the [setup checklist](./setup-wizard) is finished or skipped, and only when the site has work on a ticket other than the one you are on — a site with nothing else to offer does not get an empty card.

With a ticket linked, the card is headed **Other tickets on this site**, and each row offers to **switch**:

![The Other tickets on this site card: "You also have work on #61002 — switch", with "Delete this ticket's work" beside it](/screenshots/ticket-list-card.png)

With no ticket linked, the same card is headed **Your tickets on this site**, and each row is a **Continue working on #NNNNN** link. This is how you come back to a ticket without having to remember its number:

![The Your tickets on this site card, listing two tickets to continue working on, most recently used first](/screenshots/ticket-list-unlinked.png)

Rows are listed most recently used first, with **edited 2 days ago** underneath — and after a week, the date itself. Every control on the card is disabled while an install, a build or a [trunk update](./trunk-updates) is running, because all three are writing to the same working directory a switch would swap.

## What a switch says while it runs

A switch is a scan of the working tree followed by a checkout. On a real `wordpress-develop` that is seconds, not minutes, but it is long enough that a silent window looks like a hung one — so the panel narrates it, under a spinner:

- **Saving your work on #59234…** — the ticket you are leaving is being committed to its branch. This is the part worth waiting out: it is the stretch where your edits are written down.
- **Checking which files change…**
- **Swapping files for #61002… 63%**
- **Ready to work on #61002**

If the file swap itself fails part-way — an editor or an antivirus holding a file open is the usual cause — the app marks the site and refuses every further ticket action with *A previous switch from … to … did not finish. Retry it before making other changes*. Two actions get through: retrying the same switch (**Continue working on** the ticket it was heading for, or linking it again), and **Unlink**, which puts you back on trunk. Both finish the file swap and nothing else; neither saves the half-swapped files as work. Your work on the ticket you were leaving is not at risk; it was committed to its branch before any file moved.

Do not force-quit during a switch. A killed process writes no such marker, so the half-swapped tree is left behind with nothing saying so.

## Deleting a ticket's work

**Delete this ticket's work**, on each row, throws that ticket's branch away — every change you made for it, whether or not you ever submitted it. It asks first: *Delete all work on #61002 on this site? This cannot be undone.* There is no undo afterwards.

The card only lists tickets you are not on, so this is never offered for the ticket in hand. To throw away the one you are working on, **Unlink** it first; its row then appears with the rest.

Deleting is deliberately a different gesture from switching, and from unlinking. **Unlink** on the **Trac ticket** panel only puts the site back on trunk: the ticket's work stays on its branch, and the ticket reappears under **Your tickets on this site**, ready to continue.

## Edits you made before picking a ticket

If you started editing before you linked a ticket, those edits are on trunk, which the app never commits to. So when you link a ticket, it stops and asks what should happen to them:

![The question panel: "You have 1 uncommitted change on this site, not on any ticket yet. What should happen to them?" with four choices](/screenshots/trunk-work-question.png)

- **Take these edits into #NNNNN** — the edits come along and become part of that ticket's work. This is the answer for *I started editing, then realised which ticket this is*.
- **Save them as a patch, then start clean…** — the app asks where to save a `.diff`, then discards the edits and links the ticket. Cancelling the save dialog cancels the whole option and leaves everything as it was.
- **Discard them and start clean** — the edits are lost; this cannot be undone, and it asks again before doing it.
- **Cancel** — nothing happens. No branch is created and no ticket is linked.

**Take these edits into #NNNNN** is offered only for a ticket this site has not worked on yet. A ticket that already has a branch has its own work waiting to be restored, so loose edits cannot ride into it; the panel says so, and the other three choices stay.

When the edits do come along, the panel says where they went: *Your 1 uncommitted change came along into #62281, and will go into its patch.*

![The Trac ticket card after the carry, with a blue notice confirming the edits came along into the ticket](/screenshots/carried-work-notice.png)

If you saved them instead, the confirmation names the file — *Your edits were saved to … and are no longer in the working tree* — and stays on screen after the switch, so the path does not vanish with the panel that offered it.

Linking a ticket from a clean tree asks nothing and shows nothing. There is a standing line under the **Link ticket** field to say the question exists: *If you have edited anything already, you will be asked what should happen to those edits.*

## Unsubmitted work for the ticket you are on

Once a ticket has changes that have not been submitted anywhere, the **Trac ticket** card says so:

> You have 1 unsubmitted change for ticket #29798. You can **review and submit** or **discard your changes**.

This counts the ticket's whole work — including everything parked when you last switched away, which is most of it if you move between tickets. It is measured the same way [the patch](./submitting-changes) is, so the note and the diff are two readings of one walk rather than two answers. The count is of everything the patch speaks about, which includes the files it can only [name rather than carry](./submitting-changes#what-a-patch-can-and-cannot-carry): change nothing but an image and the note still says one unsubmitted change, while the diff itself is empty.

Under it is the reassurance that matters here: unlinking the ticket does not touch those changes. They stay attached to the ticket in this site, ready for when you link it again.

Returning to a ticket does not make it clean or measure it from wherever trunk happens to be now. The same count and the same files return because the ticket is still measured from the trunk snapshot where its branch started. That baseline also drives the warning before applying another patch: work committed when you switched away is still named as work on this ticket.

## When trunk has moved since the ticket started

Updating the site moves its copy of trunk, but deliberately does not move existing ticket branches. When the app can see that the linked ticket started on an older trunk, the **Trac ticket** card says:

> **Trunk has moved since this ticket started.** Newer patches may not apply cleanly. Move your work onto the current trunk here, or save a copy of it and start the ticket again.

Nothing moves on its own. The notice carries a button, **Update this ticket to the current trunk**, that replays the ticket's work onto the trunk the site now has: the same lines you changed, on top of the new code, in one step. Edits you have not parked yet come along. It is all or nothing: if trunk changed the same lines as your work, the app refuses, names the files, and moves nothing. The button waits while an update, an install, a build or the dev server is running, for the same reason the discard link does.

When the move is refused, or when you would rather see the work land on fresh code yourself, the manual path is still there:

1. Use **Review & submit changes** to save a patch of the ticket's work.
2. Click **Unlink** so the ticket appears under **Your tickets on this site**.
3. Click **Delete this ticket's work** on its row. This deletes the branch, not the patch you saved outside the site.
4. Link the same ticket again. Its new branch starts from current trunk.
5. Apply the saved patch and check that the work still fits.

The app stays silent when it cannot identify a ticket's original base; it does not substitute the current trunk and pretend the ticket is current, and the button is not offered.

## What a patch contains

A patch is everything on the ticket's branch since the point it was created — only that ticket's work, never another's, and never a change that arrived from a trunk update.

That last point has a consequence worth knowing. A ticket branch keeps the snapshot of trunk it was born on, even after you [update the site to the latest trunk](./trunk-updates). The patch stays correct against that snapshot, which is what keeps it free of upstream changes you did not write — but a branch you started weeks ago produces a patch that may no longer apply to today's trunk. Use **Update this ticket to the current trunk** when you need a fresh base, or the copy-and-restart path above; the app does not replay the branch onto it silently.

## Next steps

- [Working on a Trac ticket](./trac-tickets)
- [Submitting your changes](./submitting-changes)
- [Staying up to date with trunk](./trunk-updates)
