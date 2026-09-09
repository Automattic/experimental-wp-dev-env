import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button,
  TabPanel,
  Card,
  CardBody,
  Dropdown,
  Flex,
  DropdownMenu,
  Icon,
  MenuGroup,
  MenuItem,
  Modal,
  SnackbarList,
  TextControl,
  TextareaControl,
  Spinner,
  Tooltip
} from '@wordpress/components';
import { plus, chevronLeft, chevronRight, chevronDown, copy as copyIcon, check as checkIcon, edit, download, comment } from '@wordpress/icons';
import '@wordpress/components/build-style/style.css';
// After the @wordpress/components stylesheet, deliberately: esbuild concatenates
// CSS imports in import order, so this is what lets the app's own tokens win
// against it without any build configuration. xterm's stylesheet is imported
// after these, which is harmless — it only selects inside .xterm.
import './styles/tokens.css';
import { Section } from './ui/Section.jsx';
import { ActionRow } from './ui/ActionRow.jsx';
import { MetaText } from './ui/MetaText.jsx';
import { StatusBadge } from './ui/StatusBadge.jsx';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import { computeSetupStepState, setupStepStatuses, setupStepCopy, setupAutoStartDecision, setupStepLabel } from './setup-steps.cjs';
import { deriveNextAction } from './next-action.cjs';
import { shouldShowTerminalHints, computeTerminalBusy } from './terminal-hints.cjs';
import { planDevServerStart, formatElapsed, watchTabLabel } from './dev-server-command.cjs';
import { appendBounded, countLines } from './debug-log.cjs';
import { pathBasename } from './path-basename.cjs';
import { sanitizeSiteFolder, resolveTargetDir, directoryFromFileEntry } from './site-folder.cjs';
import { noticeForOpenResult } from './open-failure.cjs';
import { describeApplyFailure, otherPatchCount } from './apply-conflict.cjs';
import { describeAppliedLayer, attributeConflicts, layerExitFailure } from './applied-layer.cjs';
import { trunkAgeInfo, planUpdateSteps, updateStepStatuses, SKIP_INSTALL_MESSAGE, planApplySteps, planWatchImpact, APPLY_STATE_TO_STEP, planSetupSteps, SETUP_STATE_TO_STEP, setupOutcome } from './update-plan.cjs';
import { pickLatest } from '../latest-patch.cjs';
import { beginSetup, adoptSetupPath, discardSetup, rowPathAfterStatus } from './pending-setup.cjs';
import { parsePrRef } from '../patch-sources.cjs';
import { prStateBadge } from './pr-state.cjs';
import { statusBadge } from '../trac-ticket-info.cjs';
import { prDateLabel } from './pr-date-label.cjs';
import { ticketUrl, attachUrl } from './trac-ticket.cjs';
import { adminUrl, adminerUrl } from './site-urls.cjs';
import { ticketBranchRows, ticketListCard } from './ticket-branch-list.cjs';
import { ticketTrunkNotice } from './ticket-trunk-notice.cjs';
import { describeSwitchProgress } from '../switch-progress.cjs';
import { highlightDiff, hasDiffLines } from './diff-highlight.cjs';
import { highlightLog } from './log-highlight.cjs';
import { carryTestMode } from './github-account.cjs';
import { changesNoteParts, discardOutcome, applyFeedbackAfterDiscard, noteAfterDiscard, noteAfterProbe, discardBlocked, discardDisabledReason, DISCARD_CONFIRM_MESSAGE } from './changes-note.cjs';
import { initialConfirmations, confirmationReducer, prConfirmationMessage, deleteFailureMessage } from './confirmations.cjs';

const TERMINAL_ALLOWED_SCRIPTS = ['build', 'build:dev', 'dev', 'test', 'watch', 'grunt'];
// One face for everything that is process output: the terminal below and every
// log pane above it. Shared rather than repeated because the panes had drifted
// into the app's sans-serif, which does not line up a stack trace and does not
// read as a console even though that is exactly what it is.
const TERMINAL_FONT = { fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace', fontSize: 13 };
// Shared by every log pane so the tabs cannot drift apart visually. The line
// height is looser than xterm's: this is wrapped text in a div, not painted rows.
const LOG_PANE_STYLE = { ...TERMINAL_FONT, lineHeight: 1.4, whiteSpace: 'pre-wrap', background: '#111', color: '#eee', padding: 12, borderRadius: 6, height: 220, overflow: 'auto' };
// The build-watch status dot, by state (#247). Keyed rather than nested
// ternaries; an unknown state falls back to the grey "stopped" colour.
const WATCH_DOT_COLORS = { watching: '#00a32a', building: '#dba617', paused: '#dba617', exited: '#d63638' };
// What the Copy button says about the press just made. Keyed rather than
// nested ternaries, so a fourth state is a line here instead of another branch
// in the middle of the JSX.
const COPY_BUTTON_LABELS = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Could not copy'
};

// One discard action, wherever it is offered. Keeping the disabled rendering
// here means the ticket note cannot lose the explanation while the review
// modal keeps it (or vice versa).
function DiscardChangesLink({ label, onClick, reason, style }) {
  if (!reason) {
    return <Button variant="link" isDestructive onClick={onClick} style={style}>{label}</Button>;
  }
  return (
    <Tooltip text={reason} placement="bottom">
      <Button
        variant="link"
        isDestructive
        onClick={onClick}
        disabled
        accessibleWhenDisabled
        description={reason}
        style={style}
      >{label}</Button>
    </Tooltip>
  );
}
// What the app is doing while a pull request is being opened (#167). Each step
// is named because they take visibly different amounts of time — forking is the
// slow one, and an unlabelled spinner there reads as a hang.
const PR_STAGE_LABELS = {
  forking: 'Creating your fork of wordpress-develop…',
  syncing: 'Bringing your fork up to date…',
  committing: 'Uploading your changes…',
  opening: 'Opening the pull request…'
};
// Why it failed, in a sentence that says what to do about it. Every one of
// these still leaves the patch file, which is what the card offers underneath.
const PR_FAILURE_MESSAGES = {
  unauthorized: 'That GitHub sign-in is no longer valid. Sign in again, or save the patch file instead.',
  'rate-limited': 'GitHub is rate-limiting this connection. It usually clears within the hour.',
  offline: 'No connection to GitHub.',
  'no-ticket': 'Link a Trac ticket to this site first — a pull request has to cite one.',
  empty: 'There are no changes to open a pull request with.'
};
// Per-status wording for the update chain card (#94), following the issue's
// mockups: the skipped install step is named, never hidden, and the build
// step points at the Terminal instead of opening a second log surface.
const UPDATE_STEP_LABELS = {
  fetch: { pending: 'Fetch and reset to trunk', current: 'Fetching and resetting to trunk…', complete: 'Fetched and reset to trunk' },
  install: { pending: 'Install dependencies', current: 'Dependencies changed — installing the difference…', complete: 'Dependencies installed', skipped: SKIP_INSTALL_MESSAGE },
  build: { pending: 'Rebuild', current: 'Rebuilding — output in the Terminal below', complete: 'Rebuilt' }
};
// Checkmark/pointer and color per step status; pending/skipped fall back to
// no symbol in muted gray.
const UPDATE_STEP_MARKS = {
  complete: { symbol: '✓', color: '#0f5132' },
  current: { symbol: '›', color: '#0b5d95' }
};
// The file manager has a name on the two platforms that have one; everywhere
// else it is whatever the desktop provides, so it is called what it is.
//
// Two forms, because it appears in two places: an instruction in a list of
// commands ("Show in Finder"), and an application named alongside the editors in
// the "Open directory in" menu, where every other row is a bare name.
const FILE_MANAGER_LABELS = { darwin: 'Show in Finder', win32: 'Show in Explorer' };
const FILE_MANAGER_NAMES = { darwin: 'Finder', win32: 'File Explorer' };
const TERMINAL_INSTALL_ALIASES = ['npm install', 'npm i', 'install'];
const RENAME_INPUT_ID = 'rename-site-name-input';
const CREATE_SITE_NAME_INPUT_ID = 'create-site-name-input';
const CREATE_SITE_LOCATION_INPUT_ID = 'create-site-location-input';
const CREATE_SITE_LOCATION_HELP_ID = 'create-site-location-help';
// Why the ticket's PR list could not be read, worded for the contributor.
const TICKET_PATCH_STATUS_MESSAGE = {
  'rate-limited': 'GitHub is rate-limiting this connection.',
  offline: 'Could not reach GitHub.',
  error: 'Could not read the pull requests from GitHub.'
};
const TRAC_TICKET_LISTS_URL = 'https://core.trac.wordpress.org/tickets/good-first-bugs';
const CREATE_SITE_MODAL_STYLE_ID = 'create-site-modal-theme';

function formatEmailDate(email) {
  if (email.sentAt) return new Date(email.sentAt).toLocaleString();
  if (email.date) return new Date(email.date).toLocaleString();
  return '';
}
const FEEDBACK_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScnMxicyDxZO2OoaS5ela8FArYWjCyLfC3hxRBBRSF7XLPzKg/viewform';

// Which applications this machine has is a fact about the machine, not about a
// site, so it is held once for the window rather than once per site. Every site
// is mounted at all times (the inactive ones are hidden), so per-row state here
// would mean N copies of the same answer and N filesystem sweeps.
//
// Detection is deliberately not part of the load: the probe behind `editor:list`
// waits until a menu is actually opened. It is re-run on every open rather than
// cached for the session, because an editor installed while this app is running
// is one the next menu should offer. The previous answer is kept on screen in the
// meantime, so reopening the menu does not blink through an empty list.
function useDetectedEditors() {
  const [detected, setDetected] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadDetected = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.api.listEditors();
      setDetected(result?.detected || []);
    } catch (err) {
      // The menu still offers the file manager and "Other application…", which
      // is enough to finish the job — but "detection failed" and "nothing is
      // installed" must not be the same event to whoever reads the log.
      // eslint-disable-next-line no-console -- reaches the log file: logging.js initializes electron-log with spyRendererConsole, so this is how the renderer records a diagnostic.
      console.error('Could not list the editors on this machine:', err);
      setDetected([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return { detected, loading, loadDetected };
}

// Who this contributor is and where they are contributing from (#166), held
// once for the same reason the detected editors are: both are facts about the
// person or their machine, not about a checkout, so answering them in one site's
// patch modal must not leave every other site still asking.
function useContributorProvenance() {
  const [handle, setHandle] = useState(null);
  const [event, setEvent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.api.getProvenance()
      .then((res) => {
        if (cancelled) return;
        setHandle(res?.handle || null);
        setEvent(res?.event || null);
      })
      // "nothing answered yet" is an ordinary state; "the store could not be
      // read" is not, and the two must not look the same in the log. Same
      // argument as useDetectedEditors above.
      // eslint-disable-next-line no-console -- reaches the log file, see the note in useDetectedEditors.
      .catch((err) => console.error('Could not read the remembered contributor details:', err));
    return () => { cancelled = true; };
  }, []);

  // An empty ref forgets the field. A rejected invoke comes back as a refusal
  // rather than being raised: the caller shows the message next to the input.
  const rememberHandle = useCallback(async (ref) => {
    let result;
    try {
      result = await window.api.setWporgHandle(ref);
    } catch (err) {
      // eslint-disable-next-line no-console -- see the note above.
      console.error('Could not remember that WordPress.org handle:', err);
      return { ok: false, error: String(err?.message ?? err) };
    }
    if (result?.ok) setHandle(result.handle || null);
    return result;
  }, []);

  const rememberEvent = useCallback(async (ref) => {
    let result;
    try {
      result = await window.api.setContributionEvent(ref);
    } catch (err) {
      // eslint-disable-next-line no-console -- see the note above.
      console.error('Could not remember that event:', err);
      return { ok: false, error: String(err?.message ?? err) };
    }
    if (result?.ok) setEvent(result.event || null);
    return result;
  }, []);

  return { handle, event, rememberHandle, rememberEvent };
}

// Brings the block the contributor should act on next into view when it changes,
// so their one hint is never left below the fold (#252). The mark itself is
// drawn by React — the `.next-action-cue` class the render binds to this same id
// — because a className survives re-render where an imperative one would be
// reconciled away; this handles only the movement, which no className can do.
//
// Gated on `isActive` because every SiteRow stays mounted at once: without it a
// background site could yank the viewport the moment its own state changed. It
// fires on a *change* of the id (or on becoming active), not on every render, so
// a contributor reading one block is not dragged off it by an unrelated update.
function useNextActionCue(nextActionId, isActive, containerRef) {
  useEffect(() => {
    if (!isActive || !nextActionId) return;
    const root = containerRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-next-action="${nextActionId}"]`);
    if (!el) return;
    // `center` brings the block clearly into view rather than just nudging it to
    // the nearest edge — the cue only fires when the target *changes*, so this
    // moves the viewport to whatever is newly worth looking at (a step that just
    // became current, an operation that just started) without fighting a
    // contributor mid-read. Reduced motion drops the smooth glide to an instant
    // jump.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [nextActionId, isActive, containerRef]);
}

// The two halves are one piece of state because one change moves both: adopting
// the directory the app really created has to retire the guessed row and carry
// its metadata across, and two setters cannot do that without a render in
// between where the site has a path under one key and a label under another.
// `setSiteMeta` keeps its old signature so every other caller is untouched;
// `applySetup` is for the changes that need the pair, which is every change the
// create flow makes.
function useSites() {
  const [state, setState] = useState({ sites: [], siteMeta: {} });
  const setSiteMeta = useCallback((update) => setState((prev) => ({
    ...prev,
    siteMeta: typeof update === 'function' ? update(prev.siteMeta) : update
  })), []);
  const applySetup = useCallback((fn) => setState(fn), []);
  const refresh = useCallback(async () => {
    const { sites: list, siteMeta: meta } = await window.api.getSitesWithMeta();
    setState({ sites: list, siteMeta: meta || {} });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { sites: state.sites, siteMeta: state.siteMeta, refresh, setSiteMeta, applySetup };
}

// The one way any panel confirms a completed action (#253). `confirm(message)`
// queues a transient, screen-reader-announced notice; the provider below renders
// the queue once for the window. The default is a no-op so a component rendered
// outside the provider (a test, say) does not throw on a stray confirm.
const ConfirmationContext = createContext(() => {});

function useConfirmation() {
  return useContext(ConfirmationContext);
}

function App() {
  const { sites, siteMeta, refresh, setSiteMeta, applySetup } = useSites();
  // The confirmation queue for the whole window. It lives here, above every
  // SiteRow, because only one row is visible at a time and a per-row toast would
  // be hidden along with its inactive row. See ConfirmationContext above.
  const [confirmations, dispatchConfirmation] = useReducer(confirmationReducer, initialConfirmations);
  const confirm = useCallback((content, options = {}) => {
    dispatchConfirmation({ type: 'add', content, tone: options.tone });
  }, []);
  const removeConfirmation = useCallback((id) => {
    dispatchConfirmation({ type: 'remove', id });
  }, []);
  // One answer for the window, shared by every site row: which applications this
  // machine has is a fact about the machine, not about a site.
  const detectedApplications = useDetectedEditors();
  const wporg = useContributorProvenance();
  const [downloadPhase, setDownloadPhase] = useState('');
  // Where the row for the setup in flight currently lives. It starts as the
  // window's guess and becomes the directory the main process reports, and it
  // is a ref because the status subscription below has to read it without being
  // torn down and rebuilt every time it changes. Null when nothing is being
  // created.
  const setupRowPathRef = useRef(null);
  // Directories whose clone is still running. An array rather than a single
  // path because the main process may settle on a different (deduplicated)
  // directory than the one the renderer optimistically created a row for.
  const [pendingSites, setPendingSites] = useState([]);
  const addPendingSite = useCallback((dir) => {
    if (!dir) return;
    setPendingSites((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
  }, []);
  const clearPendingSites = useCallback(() => setPendingSites([]), []);
  const [terminalMsgs, setTerminalMsgs] = useState('');
  const termRef = useRef(null);
  const createDirInputRef = useRef(null);
  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [terminalMsgs]);
  const [webStarting, setWebStarting] = useState(false);
  const [webUrl, setWebUrl] = useState('');
  const [webLogs, setWebLogs] = useState('');
  const [webError, setWebError] = useState('');
  const webLogRef = useRef(null);
  useEffect(() => { if (webLogRef.current) webLogRef.current.scrollTop = webLogRef.current.scrollHeight; }, [webLogs]);
  const [webAvailable, setWebAvailable] = useState(false);
  useEffect(() => { (async () => { try { setWebAvailable(Boolean(await window.api.playgroundWebAvailable())); } catch {} })(); }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSite, setActiveSite] = useState(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createSiteName, setCreateSiteName] = useState('');
  const [createSiteDir, setCreateSiteDir] = useState('');
  const [createSiteError, setCreateSiteError] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [setupLogsBySite, setSetupLogsBySite] = useState({});
  const setupLogAliasRef = useRef({});
  // Where a ticket switch has got to, per site (#173). Held here rather than in
  // SiteRow because every row stays mounted — subscribing per row would open one
  // listener per registered site and wake all of them for each other's events.
  const [switchProgressBySite, setSwitchProgressBySite] = useState({});
  const [carriedWorkBySite, setCarriedWorkBySite] = useState({});

  const appendSetupLog = useCallback((siteTarget, message) => {
    const key = siteTarget ? String(siteTarget) : '';
    if (!key) return;
    const chunk = message !== null && message !== undefined ? String(message) : '';
    if (!chunk) return;
    let resolvedKey = key;
    const aliasMap = setupLogAliasRef.current;
    const seen = new Set();
    while (resolvedKey && aliasMap[resolvedKey] && !seen.has(resolvedKey)) {
      seen.add(resolvedKey);
      resolvedKey = aliasMap[resolvedKey];
    }
    if (!resolvedKey) return;
    setSetupLogsBySite((prev) => {
      const prevText = prev[resolvedKey] || '';
      return { ...prev, [resolvedKey]: prevText + chunk };
    });
  }, []);

  const removeSetupLog = useCallback((siteTarget) => {
    const key = siteTarget ? String(siteTarget) : '';
    if (!key) return;
    const aliasMap = setupLogAliasRef.current;
    delete aliasMap[key];
    Object.keys(aliasMap).forEach((aliasKey) => {
      if (aliasMap[aliasKey] === key) delete aliasMap[aliasKey];
    });
    setSetupLogsBySite((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const moveSetupLog = useCallback((from, to) => {
    const source = from ? String(from) : '';
    const target = to ? String(to) : '';
    if (!source || !target || source === target) return;
    setupLogAliasRef.current[source] = target;
    setSetupLogsBySite((prev) => {
      if (!prev[source]) return prev;
      const next = { ...prev };
      const combined = (prev[target] || '') + prev[source];
      delete next[source];
      next[target] = combined;
      return next;
    });
  }, []);

  useEffect(() => {
    let styleEl = document.getElementById(CREATE_SITE_MODAL_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = CREATE_SITE_MODAL_STYLE_ID;
      styleEl.textContent = `
.create-site-modal .components-modal__header-heading { color: #1d2327; }
.create-site-modal .components-modal__header { border-bottom: 1px solid #e2e4e7; }
.create-site-modal .components-modal__content { color: #1d2327; }
`;
      document.head.appendChild(styleEl);
    }
  }, []);

  useEffect(() => {
    if (!createModalOpen) return;
    const input = document.getElementById(CREATE_SITE_NAME_INPUT_ID);
    if (input) {
      input.focus();
      if (typeof input.select === 'function') input.select();
    }
  }, [createModalOpen]);

  useEffect(() => {
    if (createModalOpen) return;
    if (createDirInputRef.current) {
      createDirInputRef.current.value = '';
    }
  }, [createModalOpen]);

  useEffect(() => {
    const unsubProg = window.api.subscribeSetupProgress((p) => {
      if (p && p.message) {
        setTerminalMsgs((v) => v + p.message + '\n');
        appendSetupLog(p.target, `${p.message}\n`);
      }
      if (p && p.target) addPendingSite(p.target);
    });
    const unsubStat = window.api.subscribeSetupStatus((s) => {
      if (!s) return;
      // The first moment the window learns where the site is actually being
      // made. Until now the row kept the guess it was drawn with, which differs
      // whenever the folder name was taken — so it showed the wrong path and,
      // once the guards started keying on the real directory, asked about a
      // folder the app had never created (#180).
      const guess = setupRowPathRef.current;
      const adopted = rowPathAfterStatus(guess, s);
      if (adopted) {
        setupRowPathRef.current = adopted;
        moveSetupLog(guess, adopted);
        applySetup((state) => adoptSetupPath(state, { from: guess, to: adopted }));
        // The selection follows the row. Without this the panel is pointed at a
        // path that no longer exists in the list, and the contributor watches
        // their new site's checklist disappear mid-clone.
        setActiveSite((current) => (current === guess ? adopted : current));
      }
      if (s.target && s.phase !== 'done') addPendingSite(s.target);
      const key = s.sitePath || s.target;
      if (key) {
        const phaseLabel = s.phase ? `Status: ${s.phase}` : 'Status update';
        appendSetupLog(key, `${phaseLabel}\n`);
        if (s.phase === 'done') appendSetupLog(key, 'Setup finished.\n');
      }
      if (s.phase === 'cloning') setDownloadPhase('Cloning repository…');
      else if (s.phase === 'done') { setDownloadPhase(''); clearPendingSites(); setTerminalMsgs(''); }
    });
    return () => { if (unsubProg) unsubProg(); if (unsubStat) unsubStat(); };
  }, [addPendingSite, appendSetupLog, applySetup, clearPendingSites, moveSetupLog]);

  // Dropped when a switch begins, so a failed switch's last sentence is not the
  // next one's first frame.
  const clearSwitchNotices = useCallback((sitePath) => {
    setSwitchProgressBySite((prev) => (prev[sitePath] ? { ...prev, [sitePath]: null } : prev));
    setCarriedWorkBySite((prev) => (prev[sitePath] ? { ...prev, [sitePath]: null } : prev));
  }, []);

  // One subscription for every site; the payload says which one (#173).
  useEffect(() => {
    const unsub = window.api.subscribeSwitchProgress((p) => {
      if (!p || !p.sitePath) return;
      setSwitchProgressBySite((prev) => ({ ...prev, [p.sitePath]: p.stage === 'done' ? null : p }));
    });
    return () => { if (unsub) unsub(); };
  }, []);

  // Arrives after the link has already answered (#108), so it is its own
  // subscription rather than a stage of the switch.
  useEffect(() => {
    const unsub = window.api.subscribeCarriedWork((p) => {
      if (!p || !p.sitePath) return;
      setCarriedWorkBySite((prev) => ({ ...prev, [p.sitePath]: p }));
    });
    return () => { if (unsub) unsub(); };
  }, []);

  // Refused while one is already running. Everything about this flow is
  // single-file and always has been — one pending card, one terminal, one
  // `clearPendingSites()` that clears them all — and `setupRowPathRef` is one
  // slot for the row being created. The button was the only door left open on a
  // second setup, and a second setup does not half-work: it adopts the other
  // one's row. Until the flow is genuinely per-site, saying no is the honest
  // shape.
  const chooseAndSetup = useCallback(() => {
    if (createSubmitting) return;
    setCreateSiteName('');
    setCreateSiteDir('');
    setCreateSiteError('');
    setCreateModalOpen(true);
  }, [createSubmitting]);

  const openDirectoryPicker = useCallback(async () => {
    try {
      const dir = await window.api.chooseDirectory();
      if (dir) {
        setCreateSiteDir(dir);
        setCreateSiteError('');
      }
    } catch {}
  }, []);

  const handleCreateDirInputChange = useCallback((event) => {
    const inputEl = event.target;
    createDirInputRef.current = inputEl;
    const files = inputEl.files;
    if (!files || files.length === 0) {
      inputEl.value = '';
      return;
    }

    const resolved = directoryFromFileEntry(files[0], inputEl.value);
    setCreateSiteDir(resolved);
    // Clearing the error only when there is a directory: a selection that
    // resolved to nothing has not fixed anything the message was about.
    if (resolved) setCreateSiteError('');
    inputEl.value = '';
  }, [setCreateSiteDir, setCreateSiteError]);

  const handleCreateSiteSubmit = useCallback(async () => {
    const nameTrimmed = createSiteName.trim();
    if (!nameTrimmed) {
      setCreateSiteError('Please provide a site name.');
      return;
    }
    if (!createSiteDir) {
      setCreateSiteError('Please choose where to create the site.');
      return;
    }

    const cleanFolder = sanitizeSiteFolder(nameTrimmed);
    const targetDir = resolveTargetDir(createSiteDir, cleanFolder);
    let finalSitePath = targetDir;
    const placeholderCreatedAt = new Date().toISOString();

    setupRowPathRef.current = targetDir;
    applySetup((state) => beginSetup(state, {
      path: targetDir,
      label: nameTrimmed,
      createdAt: placeholderCreatedAt
    }));
    setActiveSite(targetDir);
    setCreateModalOpen(false);
    setCreateSiteName('');
    setCreateSiteDir('');

    try {
      setCreateSubmitting(true);
      setCreateSiteError('');
      setTerminalMsgs('');
      addPendingSite(targetDir);
      appendSetupLog(targetDir, 'Starting site setup…\n');
      const createdPath = await window.api.setupWordPress(createSiteDir, { siteName: cleanFolder, siteLabel: nameTrimmed });
      if (createdPath) {
        finalSitePath = createdPath;
        // Ordinarily already done, by the `cloning` status this handler's own
        // clone sent minutes ago. Kept because the status event is not a
        // guarantee — a missed one would otherwise leave the row on the guess
        // for good — and adopting a path the row already has is a no-op.
        const current = setupRowPathRef.current;
        if (current && current !== createdPath) {
          addPendingSite(createdPath);
          moveSetupLog(current, createdPath);
          applySetup((state) => adoptSetupPath(state, { from: current, to: createdPath }));
        }
        setupRowPathRef.current = createdPath;
      }
      await refresh();
      setActiveSite(finalSitePath);
      appendSetupLog(finalSitePath, 'Site setup request completed.\n');
    } catch (e) {
      // Whatever the row is *now*, which is not necessarily what it started as:
      // once the clone reports its directory the guess no longer exists, and
      // discarding the guess here would strand a row for a setup that failed.
      const rowPath = setupRowPathRef.current || targetDir;
      setCreateSiteError(String(e));
      appendSetupLog(rowPath, `Setup failed: ${String(e)}\n`);
      applySetup((state) => discardSetup(state, rowPath));
    } finally {
      setupRowPathRef.current = null;
      // `setupWordPress` resolving (or throwing) *is* the clone finishing, so
      // clearing here guarantees the checklist can never stay locked even if
      // the `done` status event is missed.
      clearPendingSites();
      setCreateSubmitting(false);
    }
  }, [addPendingSite, appendSetupLog, applySetup, clearPendingSites, createSiteDir, createSiteName, moveSetupLog, refresh]);

  const closeCreateModal = useCallback(() => {
    if (createSubmitting) return;
    setCreateModalOpen(false);
  }, [createSubmitting]);

  const handleCreateModalSubmit = useCallback((event) => {
    event.preventDefault();
    handleCreateSiteSubmit();
  }, [handleCreateSiteSubmit]);

  const handleCreateModalKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCreateModal();
    }
  }, [closeCreateModal]);

  const handleCreateDirInputClick = useCallback((event) => {
    event.preventDefault();
    void openDirectoryPicker();
  }, [openDirectoryPicker]);

  const togglePlaygroundWeb = useCallback(async () => {
    if (!webUrl) {
      setWebStarting(true);
      setWebError('');
      setWebLogs('');
      try {
        const res = await window.api.startPlaygroundWeb(
          ({ data }) => setWebLogs((v) => v + String(data)),
          (url) => { const u = (url || 'http://127.0.0.1:39372/').replace(/\/$/,'/'); setWebUrl(u); setWebStarting(false); },
          (payload) => { setWebUrl(''); if (payload && typeof payload.code === 'number' && payload.code !== 0) setWebError(`Server exited with code ${payload.code}`); }
        );
        if (res && res.ok && res.url) {
          const u = String(res.url).replace(/\/$/,'/');
          setWebUrl(u);
          setWebStarting(false);
        } else if (!res || !res.ok) {
          setWebStarting(false);
          if (res && res.error) { setWebError(String(res.error)); }
        }
      } catch (e) {
        setWebStarting(false);
        setWebError(String(e));
      }
    } else {
      try { await window.api.stopPlaygroundWeb(); } catch {}
      setWebUrl('');
    }
  }, [webUrl]);

  const onInitialized = useCallback((sitePath) => {
    setSiteMeta((m) => ({ ...(m || {}), [sitePath]: { ...(m?.[sitePath] || {}), initialized: true } }));
  }, [setSiteMeta]);

  // Lets a SiteRow push meta changes (trunk date, update-incomplete flag)
  // into App's copy so the sidebar staleness dots update without a restart.
  const onSiteMetaPatch = useCallback((sitePath, patch) => {
    setSiteMeta((m) => ({ ...(m || {}), [sitePath]: { ...(m?.[sitePath] || {}), ...patch } }));
  }, [setSiteMeta]);

  const onDelete = useCallback(async (sitePath) => {
    const result = await window.api.deleteSite(sitePath);
    await refresh();
    removeSetupLog(sitePath);
    // A deletion that half-happened must not look like one that worked (#381).
    // The sentence and the decision to show it live in confirmations.cjs,
    // where the suite can reach them; the error tone stays until dismissed.
    const failure = deleteFailureMessage(result);
    if (failure) {
      confirm(failure, { tone: 'error' });
    }
  }, [refresh, removeSetupLog, confirm]);

  const onRename = useCallback(async (sitePath, newLabel) => {
    try {
      await window.api.setSiteLabel(sitePath, newLabel);
      setSiteMeta((meta) => ({
        ...(meta || {}),
        [sitePath]: { ...(meta?.[sitePath] || {}), label: newLabel }
      }));
    } catch (err) {
      // Pre-existing UX convention in this file; replacing every alert()/confirm()
      // with an in-app notice is a separate, larger UX change than a lint cleanup should make.
      // eslint-disable-next-line no-alert
      alert(String(err));
    }
  }, [setSiteMeta]);

  const sortedSites = useMemo(() => {
    if (!sites || !sites.length) return [];
    const getCreatedAt = (sitePath) => {
      const value = siteMeta?.[sitePath]?.createdAt;
      if (!value) return 0;
      const timestamp = new Date(value).getTime();
      return Number.isFinite(timestamp) ? timestamp : 0;
    };
    return [...sites].sort((a, b) => getCreatedAt(b) - getCreatedAt(a));
  }, [sites, siteMeta]);

  useEffect(() => {
    if (!sortedSites.length) {
      setActiveSite(null);
      return;
    }
    setActiveSite((current) => (current && sortedSites.includes(current) ? current : sortedSites[0]));
  }, [sortedSites]);

  const handleSelectSite = useCallback((sitePath) => {
    setActiveSite(sitePath);
  }, []);

  return (
    <ConfirmationContext.Provider value={confirm}>
    <div style={{ display: 'flex', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ width: sidebarCollapsed ? 56 : 280, background: '#1f1f1f', color: '#f7f7f7', display: 'flex', flexDirection: 'column', transition: 'width 0.2s ease', borderRight: '1px solid #2b2b2b' }}>
        <div style={{ padding: sidebarCollapsed ? '12px 8px' : '16px', borderBottom: '1px solid #2b2b2b' }}>
          <Flex align="center" justify="space-between">
            {!sidebarCollapsed ? (<div style={{ fontWeight: 600 }}>WordPress Core</div>) : null}
            <Button
              icon={sidebarCollapsed ? chevronRight : chevronLeft}
              onClick={() => setSidebarCollapsed((v) => !v)}
              variant="tertiary"
              aria-label={sidebarCollapsed ? 'Expand site list' : 'Collapse site list'}
              isSmall
              style={{ color: '#f7f7f7' }}
            >
              {!sidebarCollapsed ? 'Collapse' : null}
            </Button>
          </Flex>
          <Dropdown
            popoverProps={{
              placement: sidebarCollapsed ? 'right-start' : 'bottom-start',
              offset: 8
            }}
            renderToggle={({ isOpen, onToggle }) => (
              <Button
                variant="secondary"
                onClick={onToggle}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                aria-label="Share feedback"
                icon={comment}
                isSmall
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  marginTop: 12,
                  background: '#e8e8e8',
                  color: '#1e1e1e',
                  borderColor: '#e8e8e8',
                  padding: sidebarCollapsed ? '10px 0' : '10px 12px',
                  borderRadius: 0
                }}
              >
                {!sidebarCollapsed ? 'Share feedback' : null}
              </Button>
            )}
            renderContent={({ onClose }) => (
              <div style={{ width: 320, padding: 16, color: '#1d2327' }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Share feedback</div>
                <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>Your feedback helps decide what to build next.</p>
                <p style={{ margin: '0 0 16px', lineHeight: 1.5 }}>Responses go into a shared form the team reviews regularly. Submissions are anonymous unless you add your email.</p>
                <Button
                  variant="link"
                  onClick={() => {
                    onClose();
                    window.api.openExternal(FEEDBACK_FORM_URL);
                  }}
                  style={{ padding: 0, height: 'auto' }}
                >
                  Open the feedback form ↗
                </Button>
              </div>
            )}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: sidebarCollapsed ? '12px 8px' : '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sortedSites.length === 0 && !sidebarCollapsed ? (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>No sites yet.</div>
          ) : null}
          {sortedSites.map((sitePath) => {
            const meta = siteMeta?.[sitePath] || {};
            const siteName = (meta.label && meta.label.trim()) || pathBasename(sitePath);
            const isActive = activeSite === sitePath;
            // Staleness surfaces in the sidebar before the site is even
            // opened (#94): amber = old trunk snapshot, red = an update that
            // moved trunk but never finished install/build.
            const trunkAge = trunkAgeInfo({ trunkDate: meta.trunkDate });
            let staleDotColor = null;
            if (meta.updateIncomplete) staleDotColor = '#d63638';
            else if (trunkAge.stale) staleDotColor = '#dba617';
            const staleDotTitle = meta.updateIncomplete
              ? 'Update incomplete — code is new, built assets are old'
              : `WordPress code is ${trunkAge.ageDays} days old — update to latest trunk`;
            const staleDot = staleDotColor ? (
              <span
                title={staleDotTitle}
                style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: staleDotColor, flexShrink: 0 }}
              />
            ) : null;
            return (
              <Button
                key={sitePath}
                onClick={() => handleSelectSite(sitePath)}
                variant="tertiary"
                isSmall
                isPressed={isActive}
                style={{
                  width: '100%',
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  background: isActive ? 'rgba(255,255,255,0.16)' : 'transparent',
                  border: '1px solid rgba(255,255,255,0.18)',
                  color: '#f7f7f7',
                  padding: sidebarCollapsed ? '8px 0' : '10px 12px',
                  borderRadius: 6,
                }}
              >
                {sidebarCollapsed ? (
                  <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{siteName.slice(0, 1).toUpperCase()}{staleDot}</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>{siteName}{staleDot}</span>
                  </div>
                )}
              </Button>
            );
          })}
        </div>
        <div
          style={{
            padding: sidebarCollapsed ? '12px 8px 20px' : '16px 16px 24px',
            borderTop: '1px solid #2b2b2b'
          }}
        >
          <Button
            icon={plus}
            variant="primary"
            onClick={chooseAndSetup}
            disabled={createSubmitting}
            style={{ width: '100%', justifyContent: 'center' }}
            aria-label="Create WordPress Core site"
            label={createSubmitting ? 'Finish creating the current site first' : undefined}
          >
            {!sidebarCollapsed ? 'Create WordPress Core site' : null}
          </Button>
        </div>
      </div>
      <div style={{ flex: 1, background: '#fff', color: '#1d2327', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px 32px 48px' }}>
          {/* The measure was already capped, at a hand-picked 1040px. It now
              reads from --wpct-content-max-width so the whole window agrees on
              one line length, and it is narrower: 1040px is wide enough that
              the eye loses the left spine travelling back from the end of a
              meta line. */}
          <div className="wpct-content-column">
            {webAvailable ? (
              <Flex align="center" justify="flex-end" style={{ gap: 8, marginBottom: 24 }}>
                <Button
                  isBusy={webStarting}
                  variant={webUrl ? 'secondary' : 'primary'}
                  onClick={togglePlaygroundWeb}
                >{webUrl ? 'Stop Playground web server' : 'Start Playground web server'}</Button>
                {webStarting || webUrl ? (
                  <span style={{ fontSize: 12 }}>
                    {webStarting ? 'Starting…' : (
                      <a href={webUrl || 'http://127.0.0.1:39372/'} onClick={(e) => { e.preventDefault(); window.api.openExternal(webUrl || 'http://127.0.0.1:39372/'); }}>{webUrl || 'http://127.0.0.1:39372/'}</a>
                    )}
                  </span>
                ) : null}
              </Flex>
            ) : null}

            {/* Playground web server status + logs */}
            {(webStarting || webUrl || webError || webLogs) ? (
              <Card style={{ marginBottom: 24 }}>
                <CardBody>
                  <div style={{ display:'flex', alignItems:'center', gap:8, justifyContent:'space-between' }}>
                    <div style={{ fontWeight: 600 }}>Playground web server</div>
                    <div style={{ fontSize:12, color:'#666' }}>
                      {webStarting ? 'Starting…' : null}
                      {!webStarting && webUrl ? (
                        <a href={webUrl} onClick={(e)=>{ e.preventDefault(); window.api.openExternal(webUrl); }}>{webUrl}</a>
                      ) : null}
                      {!webStarting && !webUrl ? 'Stopped' : null}
                    </div>
                  </div>
                  {webError ? (<div style={{ marginTop:6, color:'#C00', fontSize:12 }}>{webError}</div>) : null}
                  <div ref={webLogRef} style={{ ...LOG_PANE_STYLE, marginTop:8, padding:8, height:140 }}><LogText text={webLogs} /></div>
                </CardBody>
              </Card>
            ) : null}

            <div id="sites">
              {pendingSites.length > 0 && (
                <Card style={{ marginBottom: 24 }}>
                  <CardBody>
                    <div style={{ fontWeight: 600 }}>Setting up new site…</div>
                    {downloadPhase && <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>{downloadPhase}</div>}
                    <div ref={termRef} style={{ whiteSpace: 'pre-wrap', background: '#111', color: '#eee', padding: 8, borderRadius: 6, height: 140, overflow: 'auto' }}>{terminalMsgs}</div>
                  </CardBody>
                </Card>
              )}

              {sortedSites.length > 0 ? (
                sortedSites.map((s) => (
                  <div
                    key={s}
                    style={{ display: activeSite === s ? 'block' : 'none' }}
                    aria-hidden={activeSite === s ? false : true}
                  >
                    <SiteRow
                      sitePath={s}
                      initialized={Boolean(siteMeta?.[s]?.initialized)}
                      createdAt={siteMeta?.[s]?.createdAt}
                      label={siteMeta?.[s]?.label}
                      onInitialized={onInitialized}
                      onSiteMetaPatch={onSiteMetaPatch}
                      onDelete={onDelete}
                      onRename={onRename}
                      editor={detectedApplications}
                      wporg={wporg}
                      isPending={pendingSites.includes(s)}
                      setupLogs={setupLogsBySite[s] || ''}
                      switchProgress={switchProgressBySite[s] || null}
                      onClearSwitchNotices={clearSwitchNotices}
                      carriedWork={carriedWorkBySite[s] || null}
                      isActive={activeSite === s}
                    />
                  </div>
                ))
              ) : (
                <Card>
                  <CardBody>
                    <div style={{ marginBottom: 8 }}>No sites yet.</div>
                    <div>Use the sidebar to create your first site.</div>
                  </CardBody>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>
      {createModalOpen ? (
        <Modal
          className="create-site-modal"
          title="Create WordPress Core site"
          onRequestClose={closeCreateModal}
          shouldCloseOnClickOutside={!createSubmitting}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-close/Enter-to-submit on the modal form is standard, intentional behavior. */}
          <form
            onSubmit={handleCreateModalSubmit}
            onKeyDown={handleCreateModalKeyDown}
            style={{ display: 'flex', flexDirection: 'column', gap: 16, color: '#1d2327', colorScheme: 'light' }}
          >
            <TextControl
              id={CREATE_SITE_NAME_INPUT_ID}
              label="Site name"
              value={createSiteName}
              onChange={(value) => setCreateSiteName(value)}
              disabled={createSubmitting}
              placeholder="My WordPress site"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: this is the first field of a just-opened modal.
              autoFocus
            />
            <label htmlFor={CREATE_SITE_LOCATION_INPUT_ID} style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em', color: '#1d2327' }}>Site location</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <input
                ref={createDirInputRef}
                id={CREATE_SITE_LOCATION_INPUT_ID}
                type="file"
                webkitdirectory=""
                // eslint-disable-next-line react/no-unknown-property -- non-standard but required alongside webkitdirectory for cross-browser directory pickers.
                directory=""
                multiple
                onChange={handleCreateDirInputChange}
                onClick={handleCreateDirInputClick}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void openDirectoryPicker();
                  }
                }}
                disabled={createSubmitting}
                aria-describedby={CREATE_SITE_LOCATION_HELP_ID}
                style={{ height: 40, color: '#1d2327', background: '#fff', border: '1px solid #8c8f94', borderRadius: 4, padding: '6px 10px' }}
              />
              <span style={{ fontSize: 12, color: '#3c434a' }}>{createSiteDir || 'No folder selected yet.'}</span>
            </div>
            <div id={CREATE_SITE_LOCATION_HELP_ID} style={{ fontSize: 12, color: '#3c434a', marginTop: -4 }}>
              Choose the parent folder where you want this new site created. We&apos;ll add a new directory inside it for the project.
            </div>
            {createSiteError ? (
              <div style={{ color: '#d63638', fontSize: 12 }}>{createSiteError}</div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button type="button" variant="secondary" onClick={closeCreateModal} disabled={createSubmitting}>Cancel</Button>
              <Button type="submit" variant="primary" isBusy={createSubmitting} disabled={createSubmitting}>Create site</Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
    {/* One toast region for the window (#253). Anchored top-right and sized to
        its content so it never covers the rest of the UI; SnackbarList announces
        each message via aria-live. The z-index clears the modal overlay
        (components-modal__screen-overlay is 100000, and a modal is a later body
        portal that would otherwise win the tie) so a confirmation for an action
        taken inside a modal — saving a patch, opening a PR — is still seen. It
        stays below popovers/dropdowns (1000000), which should sit over it. */}
    <div style={{ position: 'fixed', right: 24, top: 24, zIndex: 100001, pointerEvents: 'none' }}>
      <SnackbarList
        className="toolkit-snackbars"
        // The icon and the tone class are added here, at render, rather than in
        // the reducer — an icon is a React element and the tone class is styling,
        // neither of which belongs in the DOM-free confirmations module.
        notices={confirmations.notices.map((n) => ({
          ...n,
          // Wrapped in <Icon> so it renders at a set size with the tone colour;
          // Snackbar drops the raw icon element straight into the DOM, where the
          // bare @wordpress/icons export has no dimensions of its own.
          icon: n.tone === 'error' ? undefined : <Icon icon={checkIcon} size={20} />,
          className: n.tone === 'error' ? 'toolkit-toast toolkit-toast--error' : 'toolkit-toast toolkit-toast--success'
        }))}
        onRemove={removeConfirmation}
      />
    </div>
    </ConfirmationContext.Provider>
  );
}

// What each kind of patch line looks like (#166). The classification is in
// diff-highlight.cjs; the colours are here because they are a property of this
// pane, not of a diff. Added and removed lines carry a wash as well as a
// foreground colour so the two are still distinguishable without colour vision
// — the sign in column 0 is the other half of that, and it is never hidden.
const DIFF_LINE_STYLES = {
  add: { color: '#7ee787', background: 'rgba(46,160,67,0.18)' },
  del: { color: '#ffa198', background: 'rgba(248,81,73,0.18)' },
  hunk: { color: '#d2a8ff' },
  meta: { color: '#79c0ff' },
  header: { color: '#8b949e', fontStyle: 'italic' },
  context: {}
};

// The patch, painted. An empty line still needs to occupy one: `\n` is appended
// per line rather than joining, so the last line of a patch that ends in a
// newline does not silently gain or lose one.
//
// Memoised on the text, because this renders inside SiteRow — which re-renders
// on every chunk a running dev server or watch task streams into its log. The
// patch has not changed; without this, each chunk re-splits it and hands React
// thousands of fresh spans to reconcile, on the same thread that has to paint
// the log.
function DiffText({ text }) {
  const lines = useMemo(() => highlightDiff(text), [text]);
  if (!lines) return text;
  return lines.map((line, index) => (
    // A diff line has no identity beyond its position, and the whole pane is
    // replaced when the patch changes.
    <span key={index} style={{ display: 'block', ...DIFF_LINE_STYLES[line.kind] }}>
      {line.text || ' '}
    </span>
  ));
}

// What each kind of log line looks like. Same split as the diff pane: the
// classification is in log-highlight.cjs, the colours are a property of this
// pane. Colour is never the only signal — the words `Fatal error`, `Warning`,
// `Deprecated` stay in the text, and the severity is a re-statement of them, so
// nothing is lost without colour vision.
const LOG_LINE_STYLES = {
  fatal: { color: '#ffa198' },
  warning: { color: '#ffb86c' },
  deprecated: { color: '#e3d16a' },
  notice: { color: '#e3d16a' },
  // Stack frames and node's "(Use `…`)" follow-ups: they belong to the line
  // above and are most of the volume in a full pane, so they recede.
  trace: { color: '#8b949e' },
  ready: { color: '#7ee787', fontWeight: 600 },
  plain: {}
};
// The `[11-Aug-2026 …]` every debug.log line opens with. It is worth keeping —
// it is how two runs of the same request are told apart — but it is the same 26
// characters on every line, so it is the last thing that should catch the eye.
const LOG_STAMP_STYLE = { color: '#6e7681' };

// A log pane, painted. Memoised on the text because a running dev server streams
// chunks into it: without this, an unrelated SiteRow re-render re-splits the
// whole buffer. Only the tail is turned into per-line spans (see
// MAX_HIGHLIGHTED_LINES); everything older is one plain string, so the element
// count stays flat however long the server runs.
function LogText({ text }) {
  const painted = useMemo(() => highlightLog(text), [text]);
  if (!painted) return null;
  return (
    <>
      {painted.head}
      {painted.lines.map((line, index) => (
        // A log line has no identity beyond its position, and lines only ever
        // arrive at the end.
        <span key={index} style={{ display: 'block', ...LOG_LINE_STYLES[line.kind] }}>
          {line.stamp ? <span style={LOG_STAMP_STYLE}>{line.stamp}</span> : null}
          {/* A blank line still has to occupy one, same as in the diff pane. */}
          {line.stamp === '' && line.text === '' ? ' ' : line.text}
        </span>
      ))}
    </>
  );
}

// One destination for a finished patch (#166): what it is, what it costs to
// use, and what happens afterwards. The costs are the point — they are what the
// app used to leave the contributor to find out on their own — so every
// destination states one, in the same place and the same shape, rather than the
// cheap one being presented as the obvious choice.
function Destination({ title, cost, after, children }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      <div style={{ fontWeight:600, fontSize:14, color:'#1d2327' }}>{title}</div>
      <div style={{ fontSize:12, color:'#3c434a', lineHeight:1.5 }}>{cost}</div>
      <div style={{ fontSize:12, color:'#6c6f72', lineHeight:1.5 }}>{after}</div>
      {/*
        The actions follow the prose rather than being pushed to the bottom of
        the row: the destinations carry different numbers of controls, so
        bottom-aligning them lines up nothing and leaves a hole above the
        shorter one's button.
      */}
      <div style={{ paddingTop:4, display:'flex', flexDirection:'column', gap:8 }}>{children}</div>
    </div>
  );
}

// The card around the destinations that ask the same thing of the contributor.
//
// Three equal cards said the three destinations were three variations on one
// choice. They are not: two of them save a file and stop, leaving the
// contributor to carry it somewhere, and the third signs them in and pushes on
// their behalf. That is the fork in the road, and a layout that hides it makes
// the reader rediscover it by reading all three in full.
//
// So the shared card is the grouping, and the hairline between destinations
// inside it says "another way to do the same kind of thing" — as against the
// gap between cards, which says "a different kind of thing". No group heading:
// the line above the grid names the split once, and a heading per card would
// say it twice while pushing the destinations themselves further down.
function DestinationGroup({ children }) {
  // Filtered because a conditional destination renders as false, and an empty
  // section would draw a divider with nothing under it.
  const destinations = React.Children.toArray(children).filter(Boolean);
  return (
    <div style={{ display:'flex', flexDirection:'column', border:'1px solid #dcdcde', borderRadius:10, background:'#fff' }}>
      {destinations.map((destination, index) => (
        // Position is the only identity a destination in a fixed list has, and
        // the list is rebuilt whole when it changes.
        <div key={index} style={{ padding:'14px 16px', borderTop: index === 0 ? 'none' : '1px solid #dcdcde' }}>
          {destination}
        </div>
      ))}
    </div>
  );
}

// A command named in the hints under the Terminal (#182). Clicking it types the
// command at the prompt and stops there — running it is the contributor's
// keypress, so the hint teaches where these commands live instead of becoming a
// second, hidden set of build buttons. Rendered as plain text while something is
// running, since prefilling then would land in the middle of live output.
function TerminalCommandLink({ command, onPrefill, disabled }) {
  if (disabled) return <code>{command}</code>;
  return (
    <Button
      variant="link"
      onClick={() => onPrefill(command)}
      style={{ fontSize: 12, fontFamily: 'monospace', height: 'auto' }}
    >{command}</Button>
  );
}

function SiteRow({ sitePath, initialized, createdAt, label, onInitialized, onSiteMetaPatch, onDelete, onRename, editor, wporg, isPending = false, setupLogs = '', isActive = false, switchProgress = null, carriedWork = null, onClearSwitchNotices = null }) {
  // The window's confirmation queue (#253): confirm(message) after an action
  // completes, so the outcome is announced rather than left silent or buried in
  // the terminal.
  const confirm = useConfirmation();
  // Kept in a ref so loadStatus's dependency list stays [sitePath] — a
  // recreated callback prop must not retrigger the status-loading effect.
  const metaPatchRef = useRef(onSiteMetaPatch);
  useEffect(() => { metaPatchRef.current = onSiteMetaPatch; }, [onSiteMetaPatch]);
  // state
  const [serverUrl, setServerUrl] = useState('');
  const [starting, setStarting] = useState(false);
  const [running, setRunning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [npmLogs, setNpmLogs] = useState('');
  const [runtimeLogs, setRuntimeLogs] = useState('');
  // WordPress's own debug.log, kept apart from the server's output: one is what
  // Playground is doing, the other is what the contributor's code is doing, and
  // interleaving them buries the second in the first.
  const [debugLogs, setDebugLogs] = useState('');
  const [debugUnread, setDebugUnread] = useState(0);
  // Kept after the dev server stops: the file is still there, and so is the
  // reason someone wants the path.
  const [debugLogPath, setDebugLogPath] = useState('');
  const [activeLogTab, setActiveLogTab] = useState('runtime');
  const activeLogTabRef = useRef('runtime');
  // The build watcher (grunt _watch) runs decoupled from the PHP server (issue
  // #247): its own output tab, its own lifecycle. `watchState` drives the tab
  // title; `watchExitCode` is only read when the state is 'exited'.
  const [watchLogs, setWatchLogs] = useState('');
  const [watchState, setWatchState] = useState('idle');
  const [watchExitCode, setWatchExitCode] = useState(null);
  // Ref mirror for the inline reads (guards, callbacks) that must not wait for a
  // re-render, the same split as terminalRunning/terminalStateRef below.
  const watchStateRef = useRef('idle');
  // Set while the watcher is (or was) live, so a pause knows whether a resume
  // has anything to bring back. Survives the process being killed for a pause.
  const watchWasActiveRef = useRef(false);
  const markWatchState = useCallback((state, code = null) => {
    watchStateRef.current = state;
    setWatchState(state);
    if (state === 'exited') setWatchExitCode(Number.isFinite(code) ? code : null);
  }, []);
  // '' | 'copied' | 'failed', on the debug.log Copy button for two seconds.
  const [debugCopied, setDebugCopied] = useState('');
  const debugCopyTimer = useRef(null);
  const [isPatchOpen, setIsPatchOpen] = useState(false);
  const [patchText, setPatchText] = useState('');
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchLoadFailed, setPatchLoadFailed] = useState(false);
  // What the last save did, reported in the modal rather than in an alert:
  // the destination panel is where the contributor is looking, and the path
  // matters — it is the file they are about to upload or hand over (#166).
  const [patchSaved, setPatchSaved] = useState(null);
  // '' | 'copied' | 'failed', shown on the Copy button for two seconds.
  const [patchCopied, setPatchCopied] = useState('');
  // Held so a second press restarts the message rather than being cut short by
  // the first press's timer, and so an unmount does not leave one running.
  const copyFeedbackTimer = useRef(null);
  const [patchSaveError, setPatchSaveError] = useState('');
  // The unsubmitted-changes note. Null until the first probe answers, so a
  // card never opens on a note that a clean tree then takes away.
  const [worktreeDirty, setWorktreeDirty] = useState(null);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState(null);
  const [handleInput, setHandleInput] = useState('');
  const [eventInput, setEventInput] = useState('');
  const [handleError, setHandleError] = useState('');
  const [handleSaving, setHandleSaving] = useState(false);
  const [editingHandle, setEditingHandle] = useState(false);
  // Opening a pull request (#167). `githubAccount` is null until the panel has
  // asked; `{ login: null }` is a real answer meaning signed out, and the two
  // must not render the same way — offering "Sign in" before the app knows
  // whether it already is signed in makes the panel flicker on every open.
  const [githubAccount, setGithubAccount] = useState(null);
  const [githubDeviceCode, setGithubDeviceCode] = useState(null);
  const [githubError, setGithubError] = useState('');
  const [githubDeclined, setGithubDeclined] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prNotes, setPrNotes] = useState('');
  const [prStage, setPrStage] = useState('');
  const [prResult, setPrResult] = useState(null);
  const [prError, setPrError] = useState(null);
  const [prLinkCopied, setPrLinkCopied] = useState(false);
  const [emails, setEmails] = useState([]);
  const [smtpPort, setSmtpPort] = useState(0);
  const newEmailUnsubRef = useRef(null);
  const smtpStartedUnsubRef = useRef(null);
  const wpDebugUnsubRef = useRef(null);
  const [isEmailOpen, setIsEmailOpen] = useState(false);
  const [activeEmail, setActiveEmail] = useState(null);
  const [, setEmailViewTab] = useState('rendered');
  const [building, setBuilding] = useState(false);
  const [hasNodeModules, setHasNodeModules] = useState(false);
  const [installFailed, setInstallFailed] = useState(false);
  // The build's counterpart to installFailed — session-local, because only the
  // install outcome is persisted (main.js records it on the site's meta). After
  // a restart a failed build reads "Ready" again, which is the honest fallback:
  // the app knows there is no build on disk, just not that the last attempt lost.
  const [buildFailed, setBuildFailed] = useState(false);
  const [hasBuilt, setHasBuilt] = useState(false);
  const [skipInit, setSkipInit] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [waitingForWatch, setWaitingForWatch] = useState(false);
  // Trac ticket association (#109)
  const [tracTicket, setTracTicket] = useState(null);
  const [ticketBehindTrunk, setTicketBehindTrunk] = useState(false);
  const [ticketInput, setTicketInput] = useState('');
  const [ticketError, setTicketError] = useState('');
  const [ticketSaving, setTicketSaving] = useState(false);
  // The site's ticket branches (#108): what branches:list reported, so the
  // panel can offer the tickets that already have work here.
  const [ticketBranches, setTicketBranches] = useState({ current: null, branches: [] });
  const [deletingBranch, setDeletingBranch] = useState(null);
  // The ticket a switch was refused for because trunk had loose edits, and
  // where those edits were saved if the contributor chose to keep them.
  const [blockedByTrunkWork, setBlockedByTrunkWork] = useState(null);
  // Where the edits went when "save them as a patch, then start clean" ran
  // to completion (#234) — the panel that showed the path is gone by then.
  const [patchSavedNotice, setPatchSavedNotice] = useState('');
  // How many loose files rode along into a ticket that had no branch yet, so
  // the panel can say where they went instead of moving them in silence.
  const [patchSavedTo, setPatchSavedTo] = useState('');
  // Patches on the linked ticket (#11): { status, items, cachedAt } or null.
  const [ticketPatches, setTicketPatches] = useState(null);
  const [ticketPatchesLoading, setTicketPatchesLoading] = useState(false);
  const [fetchingPr, setFetchingPr] = useState(null);
  // Trac attachments (#11): loaded on demand, since opening a real Trac window
  // can surface the proof-of-work challenge. null until the user asks.
  const [tracAttachments, setTracAttachments] = useState(null);
  const [tracAttachmentsLoading, setTracAttachmentsLoading] = useState(false);
  const [fetchingAttachment, setFetchingAttachment] = useState(null);
  // Trunk update path (#94)
  const [trunkDate, setTrunkDate] = useState(null);
  const [updateIncomplete, setUpdateIncomplete] = useState(false);
  const [updateState, setUpdateState] = useState('idle'); // idle | fetching | installing | building
  // Initial setup chain (#246): install then build, started by the clone
  // finishing rather than by a click. Same shape as the two chains below.
  const [setupChainState, setSetupChainState] = useState('idle'); // idle | installing | building
  // How the last chain ended, or null while one is running or none has run.
  const [setupChainEnd, setSetupChainEnd] = useState(null);
  // Applying someone else's patch (#11)
  const [applyState, setApplyState] = useState('idle'); // idle | applying | installing | building
  const [applyPreview, setApplyPreview] = useState(null);
  // Held separately from applyPreview: the preview is cleared the moment the
  // chain starts, and the step list still has to know whether install runs.
  const [applyNeedsInstall, setApplyNeedsInstall] = useState(false);
  // True when a running build watch will recompile the change, so the apply
  // chain shows its build step skipped and attributed to the watch (#262).
  const [applyBuildByWatcher, setApplyBuildByWatcher] = useState(false);
  const [applyError, setApplyError] = useState('');
  // The failure broken down: which regions of the patch no longer fit, where,
  // why, and what they were trying to change (#282, #226). Held beside
  // applyError rather than replacing it — a refusal with nothing to break down
  // (a parse error, a rolled-back write) still has only its sentence.
  const [applyConflict, setApplyConflict] = useState(null);
  // One call, because the breakdown must never outlive the sentence it belongs
  // to: every place that took the error banner down predates it, and any that
  // cleared only one would leave regions on screen describing a patch the
  // contributor has moved on from.
  const clearApplyError = () => { setApplyError(''); setApplyConflict(null); };
  // Where "try another patch" goes. The list is already on screen when a patch
  // fails — three rows above, in the case that prompted this — so the way out
  // is a scroll, not a fetch.
  const ticketPatchesRef = useRef(null);
  // Not every unhappy ending is a failure: a revert can find that the patch is
  // already gone, which resolves the situation rather than blocking it. Red
  // would read as "you broke something" when nothing is left to do.
  const [applyNotice, setApplyNotice] = useState('');
  const [appliedPatch, setAppliedPatch] = useState(null);
  const [prUrlInput, setPrUrlInput] = useState('');
  const [dirtyModalOpen, setDirtyModalOpen] = useState(false);
  const [dirtySaving, setDirtySaving] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState([]);
  const [dirtyChoice, setDirtyChoice] = useState('save'); // save | discard
  const [dirtyError, setDirtyError] = useState(null); // failure text shown inside the dirty-tree modal
  const [updateLockfileChanged, setUpdateLockfileChanged] = useState(false);
  const [lastUpdateSummary, setLastUpdateSummary] = useState(null);
  const updateStartRef = useRef(null);
  const savedPatchPathRef = useRef(null);
  const setupLogsRef = useRef('');

  // sticky refs per log
  const npmRef = useRef(null);
  const runtimeRef = useRef(null);
  const debugRef = useRef(null);
  const watchRef = useRef(null);
  const currentRunIdRef = useRef(null);
  // The watcher's own run handle, kept apart from currentRunIdRef so it can be
  // killed on its own (pause, dev-server stop) without disturbing whatever
  // one-shot the terminal is tracking.
  const watchRunIdRef = useRef(null);
  const threshold = 8;
  const [logStick, setLogStick] = useState({ npm: true, runtime: true, debug: true, watch: true });
  const updateStick = useCallback((key, value) => {
    setLogStick((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const ensureStick = useCallback((key) => {
    setLogStick((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  useEffect(() => { if (logStick.npm && npmRef.current) npmRef.current.scrollTop = npmRef.current.scrollHeight; }, [npmLogs, logStick.npm]);
  // Both log effects watch `activeLogTab` because TabPanel renders only the
  // selected tab: the pane is a fresh element every time it is switched back to,
  // scrolled to the top, and the arriving-text dependency alone would not fire
  // to put it back at the bottom. The guard is not just for the dependency — the
  // other tab's element is unmounted, so there is nothing to scroll.
  useEffect(() => {
    if (activeLogTab !== 'runtime') return;
    if (logStick.runtime && runtimeRef.current) runtimeRef.current.scrollTop = runtimeRef.current.scrollHeight;
  }, [runtimeLogs, logStick.runtime, activeLogTab]);
  useEffect(() => {
    if (activeLogTab !== 'debug') return;
    if (logStick.debug && debugRef.current) debugRef.current.scrollTop = debugRef.current.scrollHeight;
  }, [debugLogs, logStick.debug, activeLogTab]);
  useEffect(() => {
    if (activeLogTab !== 'watch') return;
    if (logStick.watch && watchRef.current) watchRef.current.scrollTop = watchRef.current.scrollHeight;
  }, [watchLogs, logStick.watch, activeLogTab]);
  // Independence has a cost: nothing else tears the watcher down now, so when
  // this site view unmounts (site switch, window teardown) its process would be
  // orphaned. Kill it on unmount / before switching sites.
  useEffect(() => () => {
    const runId = watchRunIdRef.current;
    if (runId) window.api.npmKill({ runId, directoryPath: sitePath }).catch(() => {});
  }, [sitePath]);
  const makeOnScroll = useCallback((key) => (e) => {
    const el = e.currentTarget;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    updateStick(key, atBottom);
  }, [threshold, updateStick]);

  const siteName = pathBasename(sitePath);
  const displayName = (label && label.trim()) || siteName;
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(displayName);
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setRenameValue(displayName); }, [displayName]);
  useEffect(() => {
    if (!renameModalOpen) return;
    const input = document.getElementById(RENAME_INPUT_ID);
    if (input) {
      input.focus();
      if (typeof input.select === 'function') input.select();
    }
  }, [renameModalOpen]);

  const openRenameModal = useCallback(() => {
    setRenameValue(displayName);
    setRenameError('');
    setRenameModalOpen(true);
  }, [displayName]);

  const closeRenameModal = useCallback(() => {
    if (renaming) return;
    setRenameModalOpen(false);
  }, [renaming]);

  const submitRename = useCallback(async () => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError('Site name cannot be empty.');
      return;
    }
    try {
      setRenaming(true);
      setRenameError('');
      if (onRename) await onRename(sitePath, trimmed);
      setRenameModalOpen(false);
    } catch (err) {
      setRenameError(String(err));
    } finally {
      setRenaming(false);
    }
  }, [onRename, renameValue, sitePath]);

  const handleRenameSubmit = useCallback((event) => {
    event.preventDefault();
    submitRename();
  }, [submitRename]);

  const handleRenameFormKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeRenameModal();
    }
  }, [closeRenameModal]);
  const createdLabel = createdAt ? new Date(createdAt).toLocaleString() : '';
  const [pathCopied, setPathCopied] = useState(false);
  const copyTimeoutRef = useRef(null);

  useEffect(() => () => {
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
  }, []);

  const copyPath = useCallback(async () => {
    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error('Clipboard access is not available in this environment');
      }
      await navigator.clipboard.writeText(sitePath);
      setPathCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setPathCopied(false), 1500);
    } catch (err) {
      // eslint-disable-next-line no-alert -- see the note above onRename.
      alert('Unable to copy path: ' + (err?.message ?? String(err)));
    }
  }, [sitePath]);

  // --- opening the directory ------------------------------------------------
  //
  // One menu, one intention: open this folder, in that. The application is the
  // argument to the action rather than a setting configured first, so there is
  // nothing remembered, nothing to change later, and no first-run picker.
  //
  // What the menu offers is what detection found (see editor-launch.js — a
  // convenience, not a claim about what is installed) plus the file manager and
  // "Other application…", which is what covers everything the table misses. No
  // entry is ever drawn disabled: an application this app cannot find is not one
  // it refuses to use, and the copy button above is the floor under all of it.
  const { detected: detectedEditors, loading: detectingEditors, loadDetected } = editor;
  // `{ message, offerPicker }` from open-failure.cjs, or null for nothing to
  // say. Both what it reads and whether "Choose application…" is a way out of
  // it are decided there, per reason — the two callers below deciding that
  // separately is what #180 was.
  const [editorNotice, setEditorNotice] = useState(null);

  const fileManagerLabel = FILE_MANAGER_LABELS[window.api?.platform] || 'Show in file manager';
  const fileManagerName = FILE_MANAGER_NAMES[window.api?.platform] || 'File manager';

  // `editorPath` is one of the detected applications; null asks the main process
  // for the file dialog instead.
  //
  // The invoke itself can reject — a handler that throws, a window being torn
  // down — and a rejection here would leave the notice unset: the menu item
  // would appear to do nothing, which is the one outcome this feature is not
  // allowed to produce.
  const openIn = useCallback(async (editorPath = null) => {
    let result;
    try {
      result = await window.api.openInEditor(sitePath, editorPath);
    } catch (err) {
      // eslint-disable-next-line no-console -- see the note on the first console.error above.
      console.error('Could not open the site directory:', err);
      result = { ok: false, reason: 'unavailable', error: String(err?.message ?? err) };
    }
    const notice = noticeForOpenResult(result, { picked: editorPath === null });
    setEditorNotice(notice);
    // An application that was detected and then failed is one detection should be
    // asked about again, so the next menu does not offer it as if nothing had
    // happened.
    if (notice && editorPath !== null) await loadDetected();
  }, [loadDetected, sitePath]);

  // Through the same function as `openIn` above, deliberately: this used to
  // build its own sentence out of `error` alone, so a refusal — which carries a
  // `reason` and no `error` — came out as the words "unknown error" (#180).
  const showInFileManager = useCallback(async () => {
    let result;
    try {
      result = await window.api.showSiteInFileManager(sitePath);
    } catch (err) {
      // eslint-disable-next-line no-console -- see the note on the first console.error above.
      console.error('Could not reveal the site folder:', err);
      result = { ok: false, reason: 'unavailable', error: String(err?.message ?? err) };
    }
    setEditorNotice(noticeForOpenResult(result));
  }, [sitePath]);

  const appendNpm = useCallback((s)=>setNpmLogs((v)=>v+s),[]);
  const appendRuntime = useCallback((s)=>setRuntimeLogs((v)=>v + String(s ?? '')),[]);
  const appendDebug = useCallback((s) => {
    const chunk = String(s ?? '');
    if (!chunk) return;
    setDebugLogs((v) => appendBounded(v, chunk));
    // Counted only while the tab is not the one being read. Selecting it zeroes
    // the badge, so incrementing there would flicker it straight back on.
    if (activeLogTabRef.current !== 'debug') setDebugUnread((n) => n + countLines(chunk));
  }, []);
  // Bounded like the debug pane: the watcher is long-lived and chatty, so its
  // pane cannot grow without limit the way an unrendered buffer quietly could.
  const appendWatch = useCallback((s) => {
    const chunk = String(s ?? '');
    if (!chunk) return;
    setWatchLogs((v) => appendBounded(v, chunk));
  }, []);
  const selectLogTab = useCallback((name) => {
    activeLogTabRef.current = name;
    setActiveLogTab(name);
    if (name === 'debug') setDebugUnread(0);
  }, []);
  // The count is on the tab rather than beside it because the tab is what the
  // contributor is not looking at: a notice landing while they read the server
  // output is the case this panel exists for.
  const logTabs = useMemo(() => ([
    { name: 'runtime', title: 'Server' },
    { name: 'watch', title: watchTabLabel(watchState, watchExitCode) },
    { name: 'debug', title: debugUnread ? `debug.log (${debugUnread})` : 'debug.log' }
  ]), [debugUnread, watchState, watchExitCode]);
  const clearDebugLog = useCallback(async () => {
    setDebugLogs('');
    setDebugUnread(0);
    // The file has to go with the pane. Clearing only the pane looks like it
    // worked and then hands the same lines back on the next dev-server start,
    // because the tail replays whatever is on disk when it attaches.
    let cleared;
    try {
      cleared = await window.api.clearWpDebug(sitePath);
    } catch (e) {
      cleared = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (!cleared?.ok) appendDebug(`Could not clear ${pathBasename(sitePath)}'s debug.log: ${cleared?.error || cleared?.reason || 'unknown error'}. The panel was cleared; the file was not.\n`);
  }, [appendDebug, sitePath]);
  // Same shape as copyPatch below, and for the same reason: a clipboard write
  // has no visible result, so the button has to report one. This log goes
  // straight into a Trac ticket or a pull request comment.
  const copyDebugLog = useCallback(async () => {
    if (debugCopyTimer.current) clearTimeout(debugCopyTimer.current);
    let state = 'copied';
    try {
      await navigator.clipboard.writeText(debugLogs);
    } catch {
      state = 'failed';
    }
    setDebugCopied(state);
    debugCopyTimer.current = setTimeout(() => setDebugCopied(''), 2000);
  }, [debugLogs]);
  useEffect(() => () => { if (debugCopyTimer.current) clearTimeout(debugCopyTimer.current); }, []);
  // Switching to another site unmounts this panel without going through
  // stopDevServer, so the listener has to come off here too.
  useEffect(() => () => { try { if (wpDebugUnsubRef.current) { wpDebugUnsubRef.current(); wpDebugUnsubRef.current = null; } } catch {} }, []);
  const revealDebugLog = useCallback(async () => {
    let revealed;
    try {
      revealed = await window.api.revealWpDebug(sitePath);
    } catch (e) {
      revealed = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    // Nothing on screen moves when a file manager opens behind the app, so a
    // refusal that says nothing is a button that did nothing.
    if (!revealed?.ok) appendDebug(`Could not show the log file: ${revealed?.error || revealed?.reason || 'unknown error'}\n`);
  }, [appendDebug, sitePath]);
  const sortEmails = useCallback((list)=>[...list].sort((a,b)=>new Date(b.sentAt||b.date||0)-new Date(a.sentAt||a.date||0)),[]);
  const openEmail = useCallback((m)=>{ setActiveEmail(m); setEmailViewTab('rendered'); setIsEmailOpen(true); },[]);
  const clearEmails = useCallback(async ()=>{ await window.api.clearEmails(sitePath); setEmails([]); }, [sitePath]);
  const loadStatus = useCallback(async ()=>{
    try {
      setStatusLoading(true);
      const s = await window.api.getSiteStatus(sitePath);
      setHasNodeModules(Boolean(s?.hasNodeModules));
      setInstallFailed(Boolean(s?.installFailed));
      setHasBuilt(Boolean(s?.hasBuilt));
      setSkipInit(Boolean(s?.skipInitWizard));
      setTrunkDate(s?.trunkDate || null);
      setUpdateIncomplete(Boolean(s?.updateIncomplete));
      setTracTicket(s?.tracTicket || null);
      setTicketBehindTrunk(Boolean(s?.ticketBehindTrunk));
      setAppliedPatch(s?.appliedPatch || null);
      if (metaPatchRef.current) {
        // A null trunkDate here means the git read failed (e.g. clone still
        // running) — keep whatever the sidebar already shows in that case.
        const patch = { updateIncomplete: Boolean(s?.updateIncomplete), tracTicket: s?.tracTicket || null };
        if (s?.trunkDate) patch.trunkDate = s.trunkDate;
        metaPatchRef.current(sitePath, patch);
      }
      // Returned as well as stored: the setup chain (#246) re-probes when the
      // clone finishes and has to decide from that read, not from state React
      // has not committed yet.
      return s;
    } catch {}
    finally { setStatusLoading(false); }
    return null;
  }, [sitePath]);
  useEffect(()=>{ loadStatus(); }, [loadStatus]);

  // Deliberately not part of loadStatus: that one is called after every long
  // operation, and the branch list only changes when a ticket is linked,
  // resumed or deleted — the three paths that call this themselves.
  const loadBranches = useCallback(async () => {
    try {
      const res = await window.api.listBranches(sitePath);
      if (res?.ok) setTicketBranches({ current: res.current, branches: res.branches || [] });
    } catch {}
  }, [sitePath]);
  useEffect(()=>{ loadBranches(); }, [loadBranches]);

  // The note's probe. It asks the wide question — unsubmitted work measured
  // from the ticket's branch point, the same measurement the patch makes —
  // not whether the tree has uncommitted edits (#239): under the ticket-as-
  // branch model a ticket's work is parked in a WIP commit, so the narrow
  // reading is correctly "clean" for every change that has survived a ticket
  // switch, which is exactly the work this note exists to speak about. The
  // checkout guards (startTrunkUpdate) keep asking the narrow question:
  // parked work survives a force checkout, uncommitted edits do not.
  //
  // A failed probe clears the last answer. Once the app knows it could not
  // measure this ticket, keeping an earlier count would present stale data as
  // current (#308).
  //
  // The ref guards two races the probe's cost makes real — it walks the whole
  // checkout, so it can still be in flight when the next focus fires or when
  // a discard answers the question locally. `inFlight` keeps walks from
  // stacking; `generation` lets a local answer outrank a probe that started
  // before it, so a stale "dirty" cannot resurrect the note over a tree that
  // was just reset.
  const dirtyProbeRef = useRef({ inFlight: false, generation: 0, again: false });
  // The local answer a discard supplies (#239) — what survived the reset,
  // decided by the module so the card has one rule for it and a test to hold
  // it. The generation bump is what makes it outrank a probe that started
  // before the discard did.
  const applyDiscardToNote = (outcome) => {
    dirtyProbeRef.current.generation++;
    setWorktreeDirty(noteAfterDiscard(outcome));
  };
  const refreshDirty = useCallback(async () => {
    const probe = dirtyProbeRef.current;
    // A walk already running answers for the tree as it was when it started.
    // Asking again mid-walk used to be dropped, which was safe while the
    // answer could only change behind the app's back — a branch switch
    // changes it in-app, without the window ever losing focus (#239), so the
    // request is remembered and re-run rather than lost.
    if (probe.inFlight) {
      probe.again = true;
      return;
    }
    probe.inFlight = true;
    try {
      do {
        probe.again = false;
        const generation = probe.generation;
        try {
          const res = await window.api.hasUnsubmittedWork(sitePath);
          if (probe.generation === generation) {
            setWorktreeDirty((current) => noteAfterProbe(current, res));
          }
        } catch {}
      } while (probe.again);
    } finally { probe.inFlight = false; }
  }, [sitePath]);

  // A branch change invalidates the note outright rather than staling it: the
  // count is measured from the ticket's branch point (#239), so the previous
  // ticket's answer is not an old version of this one's, it is about a
  // different body of work. Left alone it would put the outgoing ticket's
  // count and the incoming ticket's number in the same sentence, over a
  // discard link — so the note is cleared while the new walk runs, and the
  // generation bump keeps the outgoing branch's answer from landing on it.
  const reprobeAfterBranchChange = useCallback(() => {
    dirtyProbeRef.current.generation++;
    setWorktreeDirty(null);
    refreshDirty();
  }, [refreshDirty]);

  // Only the open card probes, and only while it is open: the probe walks the
  // whole checkout, which is too much to pay for every card on the shelf. The
  // edits themselves happen in an external editor, so returning focus to the
  // app is the moment the answer can have changed.
  useEffect(() => {
    if (!isActive) return undefined;
    refreshDirty();
    window.addEventListener('focus', refreshDirty);
    return () => window.removeEventListener('focus', refreshDirty);
  }, [isActive, refreshDirty]);

  // Linking and unlinking are the same write (#109): an empty ref clears the
  // association, so Unlink needs no second channel. Resuming a ticket that
  // already has a branch is also this write (#108) — main switches to the
  // existing branch instead of creating one, with the same parking rules.
  const saveTicket = useCallback(async (ref, options = undefined) => {
    setTicketSaving(true);
    setTicketError('');
    setBlockedByTrunkWork(null);
    setPatchSavedNotice('');
    // The previous switch's last sentence must not be this one's first frame.
    if (onClearSwitchNotices) onClearSwitchNotices(sitePath);
    try {
      const res = await window.api.setSiteTicket(sitePath, ref, options);
      if (!res?.ok) {
        // `dirty-trunk` is a question, not a failure (#234): main refuses it
        // on both paths — a new ticket that would carry the edits, a known
        // one that cannot — and the panel asks what happens to them. A red
        // error line over a set of choices would read as a fault, so the
        // message is kept for real failures only. `canCarry` is main's word
        // on whether the edits can ride into this ticket, and the count
        // arrives only on the path that scanned before refusing.
        if (res?.code === 'dirty-trunk') {
          setBlockedByTrunkWork({
            ref: String(ref),
            canCarry: Boolean(res.canCarry),
            files: typeof res.files === 'number' ? res.files : null,
            ticket: res.ticket || null
          });
        } else {
          setTicketError(res?.error || 'Could not save the ticket.');
        }
        return;
      }
      // The status belongs to the branch we just left. Clear it in the same
      // render that names the new ticket; loadStatus will restore the new
      // branch's answer below (#305).
      setTicketBehindTrunk(false);
      setTracTicket(res.ticket);
      if (res.ticket) autoReadTicketRef.current = res.ticket;
      setTicketInput('');
      setPatchSavedTo('');
      if (metaPatchRef.current) metaPatchRef.current(sitePath, { tracTicket: res.ticket });
      // Both, and awaited: the branch list decides which rows show, and
      // appliedPatch/updateIncomplete are per-branch (#108) — without the
      // status reload, switching tickets would keep showing the other
      // ticket's "patch applied · Revert" banner over this branch's tree.
      await Promise.all([loadBranches(), loadStatus()]);
      // The tree under the note is a different branch's now (#239).
      reprobeAfterBranchChange();
    } catch (e) {
      setTicketError(String(e));
    } finally {
      setTicketSaving(false);
    }
  }, [sitePath, loadBranches, loadStatus, onClearSwitchNotices, reprobeAfterBranchChange]);
  const linkTicket = useCallback(() => saveTicket(ticketInput), [saveTicket, ticketInput]);
  const unlinkTicket = useCallback(() => saveTicket(''), [saveTicket]);

  const discardTrunkWorkAndSwitch = useCallback(async (ref) => {
    setTicketSaving(true);
    setTicketError('');
    // The refused attempt left its last frame behind — without this, the
    // discard runs under a spinner describing a switch that never happened.
    if (onClearSwitchNotices) onClearSwitchNotices(sitePath);
    try {
      const res = await window.api.discardChanges(sitePath);
      if (!res?.ok) {
        setTicketError(res?.error || 'Could not discard the changes.');
        return;
      }
      setPatchSavedTo('');
      setBlockedByTrunkWork(null);
      // The switch below re-walks the tree, so on the happy path this is
      // redundant — but a switch that fails returns without reprobing, and
      // the note would go on offering to discard trunk work that is already
      // gone (#239).
      applyDiscardToNote(discardOutcome(res));
    } catch (e) {
      setTicketError(String(e));
      return;
    } finally {
      setTicketSaving(false);
    }
    // Outside the guard above: saveTicket owns the busy flag itself, and the
    // discard has already succeeded — a failure here is about the switch.
    await saveTicket(ref);
  }, [sitePath, saveTicket, onClearSwitchNotices]);

  // "Save them as a patch, then start clean" — one chosen outcome, not two
  // steps the contributor has to sequence themselves (#234). The discard only
  // runs once the save dialog has really produced a file: cancelling the
  // dialog cancels the whole option, and a failed save leaves the edits in
  // the working tree with the question still open. The busy flag is held
  // while the dialog is up because it is not window-modal — without it the
  // panel underneath keeps taking clicks, and a discard chosen there would
  // run again when the dialog finally answers.
  const saveTrunkWorkThenStartClean = useCallback(async (ref) => {
    setTicketError('');
    let savedTo = '';
    setTicketSaving(true);
    try {
      const res = await window.api.savePatch(sitePath);
      if (res?.canceled) return;
      if (!res?.ok) {
        setTicketError(res?.error || 'Could not save the patch.');
        return;
      }
      savedTo = res.filePath || '';
      setPatchSavedTo(savedTo);
    } catch (e) {
      setTicketError(String(e));
      return;
    } finally {
      setTicketSaving(false);
    }
    await discardTrunkWorkAndSwitch(ref);
    // After the panel is gone, the only on-screen record of where the work
    // went. The switch clears `patchSavedTo` with the rest of the panel
    // state, so the sentence that survives is its own notice — same shape as
    // carriedNotice, and true even if the switch itself failed: by now the
    // patch is written and the tree is clean.
    setPatchSavedNotice(savedTo);
  }, [sitePath, discardTrunkWorkAndSwitch]);

  // "Delete this ticket's work" (#108) — destroys the branch, which is why it
  // sits behind a confirm while switching does not.
  const deleteTicketWork = useCallback(async (ref) => {
    setDeletingBranch(ref);
    setTicketError('');
    try {
      const res = await window.api.deleteBranch(sitePath, ref);
      if (!res?.ok) {
        setTicketError(res?.error || 'Could not delete the branch.');
        return;
      }
      await loadBranches();
      // 'trunk' is the literal main returns (TRUNK in ticket-branches.js,
      // which the renderer cannot import — it pulls in fs). It means the site
      // now sits on trunk: usually because the delete was made from there,
      // but also when the deleted branch was somehow the active one — main
      // then cleared the ticket, and the status reload re-syncs the panel and
      // the sidebar to that.
      if (res.current === 'trunk') await loadStatus();
      // Only a delete that took the checkout with it changed what the note is
      // measuring against (#239): deleting a ticket you are not on — including
      // from trunk, where `current` says trunk either way — leaves the tree
      // alone, and re-walking it would blank the sentence and rebuild the
      // identical one. After loadStatus, so a fast walk cannot render trunk's
      // count under the ticket number the delete just cleared.
      if (res.movedToTrunk) reprobeAfterBranchChange();
    } catch (e) {
      setTicketError(String(e));
    } finally {
      setDeletingBranch(null);
    }
  }, [sitePath, loadBranches, loadStatus, reprobeAfterBranchChange]);

  const runInstall = useCallback((options = {}) => {
    const { onLog, onDone } = options;
    setInstalling(true);
    ensureStick('npm');
    window.api.runNpmInstall(sitePath, ({ data }) => {
      appendNpm(data);
      if (onLog) onLog(data);
    }, async ({ code }) => {
      appendNpm(`\ninstall exited with code ${code}\n`);
      setInstalling(false);
      // A failed install must not mark the site initialized (#42): the wizard
      // would advance to a build that cannot work. Leaving the step incomplete
      // keeps the install button available for a retry.
      if (code === 0) { try { await window.api.markSiteInitialized(sitePath); } catch {} onInitialized(sitePath); }
      try { await loadStatus(); } catch {}
      if (onDone) onDone({ code });
    });
  }, [appendNpm, ensureStick, loadStatus, onInitialized, sitePath]);

  // `track` (default) records the run in currentRunIdRef so killCurrent/Ctrl+C
  // reach it; the decoupled watcher passes track:false and takes its runId
  // through onStart into its own ref instead. `mirrorToNpm` (default) copies the
  // output into the shared npm buffer; the watcher passes false so its stream
  // stays in its own tab (and does not grow that buffer without bound).
  const runScript = useCallback((name, options = {}) => {
    const { onLog, onDone, args = [], track = true, mirrorToNpm = true, onStart } = options;
    ensureStick('npm');
    // Clearing the failure here rather than on the next exit is what stops the
    // step reading "Failed" while its own retry is streaming to the terminal.
    if (name === 'build') { setBuilding(true); setBuildFailed(false); }
    if (track) currentRunIdRef.current = null;
    return window.api.runNpmScript(sitePath, name, args, ({ data }) => {
      if (mirrorToNpm) appendNpm(data);
      if (onLog) onLog(data);
    }, async ({ code }) => {
      if (mirrorToNpm) appendNpm(`\n${name} exited with code ${code}\n`);
      if (name === 'build') {
        setBuilding(false);
        setBuildFailed(code !== 0);
        try { await loadStatus(); } catch {}
      }
      if (track) currentRunIdRef.current = null;
      if (onDone) onDone({ code });
    }).then(({ runId }) => {
      if (track) currentRunIdRef.current = runId;
      if (onStart) onStart(runId);
    }).catch((error) => {
      if (track) currentRunIdRef.current = null;
      if (mirrorToNpm) appendNpm(`\nFailed to start npm run ${name}: ${error && error.message ? error.message : String(error)}\n`);
      if (name === 'build') setBuilding(false);
      if (onDone) onDone({ code: -1 });
    });
  }, [appendNpm, ensureStick, loadStatus, sitePath]);

  const killCurrent = useCallback(async () => {
    const runId = currentRunIdRef.current;
    try {
      await window.api.npmKill({ runId, directoryPath: sitePath });
    } finally {
      currentRunIdRef.current = null;
    }
  }, [sitePath]);

  // Kills only the watcher, by its own runId, so stopping or pausing it never
  // reaches whatever one-shot currentRunIdRef is tracking. Kill by runId is
  // exact: the watcher is always stopped before any other per-directory run
  // starts, so main's one-per-directory fallback is never contended.
  const killWatcher = useCallback(async () => {
    const runId = watchRunIdRef.current;
    if (!runId) return;
    try {
      await window.api.npmKill({ runId, directoryPath: sitePath });
    } finally {
      watchRunIdRef.current = null;
    }
  }, [sitePath]);

  // terminal refs/state (after run helpers so dependencies are available)
  const terminalContainerRef = useRef(null);
  // The scroll root for the next-action cue (#252): the whole detail section, so
  // the cue can find whichever block is the next step wherever it sits.
  const nextActionSectionRef = useRef(null);
  const terminalRef = useRef(null);
  const terminalStickRef = useRef(true);
  const terminalInputHandlerRef = useRef(() => {});
  const terminalKillRef = useRef(null);
  const terminalStateRef = useRef({ input: '', history: [], historyIndex: 0, running: false });
  const serverStartRequestedRef = useRef(false);
  const stoppingRef = useRef(false);
  const runningRef = useRef(false);
  const waitingForWatchRef = useRef(false);
  // "A dev-server boot is in progress or live." The terminal lock used to double
  // as this signal, but the watcher no longer holds that lock (#247), so
  // startPhpServer needs its own flag to know the boot was not aborted.
  const devServerActiveRef = useRef(false);

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { waitingForWatchRef.current = waitingForWatch; }, [waitingForWatch]);

  // The terminal's own busy flag lives in a ref, so nothing re-renders when it
  // moves — fine for the guards that read it inline, useless for anything the
  // UI has to reflect. The hints under the Terminal (#182) do have to reflect
  // it, so every write goes through here and keeps a state copy in step. The
  // direction that hurts is the ref saying "busy" while the state says "free":
  // the hint links stay enabled and their click is silently refused.
  const [terminalRunning, setTerminalRunning] = useState(false);
  const markTerminalRunning = useCallback((value) => {
    const next = Boolean(value);
    terminalStateRef.current.running = next;
    setTerminalRunning(next);
  }, []);

  const normalizeForTerminal = useCallback((text) => String(text ?? '').replace(/\r?\n/g, '\r\n'), []);

  const writeToTerminal = useCallback((text) => {
    const term = terminalRef.current;
    if (!term) return;
    term.write(normalizeForTerminal(text));
    if (terminalStickRef.current) term.scrollToBottom();
  }, [normalizeForTerminal]);

  // Taking a step back by hand is the answer to "Setup stopped." — so the
  // notice goes away here rather than lingering over work already resumed.
  const runInstallWithTerminal = useCallback(() => {
    setSetupChainEnd(null);
    writeToTerminal('Running npm install…\n');
    runInstall({
      onLog: (chunk) => writeToTerminal(chunk),
      onDone: ({ code }) => {
        writeToTerminal(`npm install exited with code ${code}\n`);
      }
    });
  }, [runInstall, writeToTerminal]);

  const runBuildWithTerminal = useCallback(() => {
    setSetupChainEnd(null);
    writeToTerminal('Running npm run build…\n');
    runScript('build', {
      onLog: (chunk) => writeToTerminal(chunk),
      onDone: ({ code }) => {
        writeToTerminal(`npm run build exited with code ${code}\n`);
      }
    });
  }, [runScript, writeToTerminal]);

  const showPrompt = useCallback((prependNewLine = true) => {
    const term = terminalRef.current;
    if (!term) return;
    const state = terminalStateRef.current;
    if (prependNewLine) term.write('\r\n');
    term.write('$ ');
    state.input = '';
    state.historyIndex = state.history.length;
    if (terminalStickRef.current) term.scrollToBottom();
  }, []);

  const replaceTerminalInput = useCallback((next) => {
    const term = terminalRef.current;
    if (!term) return;
    const state = terminalStateRef.current;
    const current = state.input;
    if (current && current.length) {
      for (let i = 0; i < current.length; i += 1) {
        term.write('\b \b');
      }
    }
    state.input = next;
    if (next) term.write(next);
    if (terminalStickRef.current) term.scrollToBottom();
  }, []);

  // Drops a command at the prompt without running it, for the hints under the
  // Terminal (#182). Build and install are one-time steps in the setup
  // checklist, so a contributor who edits files or adds a dependency later has
  // no button left to press — the terminal is the path that still works, and
  // nothing pointed at it. Prefilling rather than running is the point: the
  // command lands where they can see it, and they press Enter themselves.
  const prefillTerminalCommand = useCallback((command) => {
    // The links are already rendered as plain text while the terminal is busy,
    // so this is the belt to that braces — but it says so rather than returning
    // silently, matching every other busy guard in this file. A guard that
    // swallows the click is how a link becomes a control that does nothing.
    if (terminalStateRef.current.running) {
      writeToTerminal('A command is already running. Press Ctrl+C to stop it.\n');
      return;
    }
    replaceTerminalInput(command);
    const term = terminalRef.current;
    if (term) term.focus();
  }, [replaceTerminalInput, writeToTerminal]);

  const addCommandToHistory = useCallback((value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const state = terminalStateRef.current;
    if (state.history[state.history.length - 1] === trimmed) {
      state.historyIndex = state.history.length;
      return;
    }
    const nextHistory = [...state.history, trimmed];
    if (nextHistory.length > 50) nextHistory.shift();
    state.history = nextHistory;
    state.historyIndex = nextHistory.length;
  }, []);

  const printHelp = useCallback(() => {
    writeToTerminal('Available commands:\n');
    writeToTerminal('  help                        Show this help text\n');
    writeToTerminal('  npm install                 Run npm install in the site directory\n');
    writeToTerminal('  npm run <script>            Run one of: ' + TERMINAL_ALLOWED_SCRIPTS.join(', ') + '\n');
    writeToTerminal('\nThe setup checklist runs npm install and npm run build once. Run them here\nwhenever you change files or add a dependency afterwards.\n');
  }, [writeToTerminal]);

  const executeTerminalCommand = useCallback((rawCommand) => {
    const command = rawCommand.trim();
    const state = terminalStateRef.current;
    if (!command) {
      showPrompt(false);
      return;
    }

    addCommandToHistory(command);

    if (state.running) {
      writeToTerminal('A command is already running. Press Ctrl+C to stop it.\n');
      return;
    }

    if (command === 'help') {
      printHelp();
      showPrompt(false);
      return;
    }

    const lower = command.toLowerCase();
    if (TERMINAL_INSTALL_ALIASES.includes(lower)) {
      markTerminalRunning(true);
      terminalKillRef.current = () => { killCurrent().catch(() => {}); };
      writeToTerminal('Running npm install…\n');
      runInstall({
        onLog: (chunk) => writeToTerminal(chunk),
        onDone: ({ code }) => {
          writeToTerminal(`npm install exited with code ${code}\n`);
          markTerminalRunning(false);
          terminalKillRef.current = null;
          showPrompt(false);
        }
      });
      return;
    }

    if (lower.startsWith('npm run ')) {
      const script = command.slice(8).trim();
      if (!script) {
        writeToTerminal('Missing script name. Example: npm run build\n');
        showPrompt(false);
        return;
      }
      if (!TERMINAL_ALLOWED_SCRIPTS.includes(script)) {
        writeToTerminal(`Unsupported script "${script}". Allowed scripts: ${TERMINAL_ALLOWED_SCRIPTS.join(', ')}\n`);
        showPrompt(false);
        return;
      }
      markTerminalRunning(true);
      terminalKillRef.current = () => { killCurrent().catch(() => {}); };
      writeToTerminal(`Running npm run ${script}…\n`);
      runScript(script, {
        onLog: (chunk) => writeToTerminal(chunk),
        onDone: ({ code }) => {
          writeToTerminal(`npm run ${script} exited with code ${code}\n`);
          markTerminalRunning(false);
          terminalKillRef.current = null;
          showPrompt(false);
        }
      });
      return;
    }

    writeToTerminal(`Unsupported command: ${command}\nTry "help" for the list of supported commands.\n`);
    showPrompt(false);
  }, [addCommandToHistory, killCurrent, markTerminalRunning, printHelp, runInstall, runScript, showPrompt, writeToTerminal]);

  const handleTerminalData = useCallback((data) => {
    const term = terminalRef.current;
    if (!term) return;
    const state = terminalStateRef.current;

    if (data === '\u0003') { // Ctrl+C
      term.write('^C\r\n');
      state.input = '';
      state.historyIndex = state.history.length;
      if (state.running) {
        if (terminalKillRef.current) terminalKillRef.current();
      } else {
        showPrompt(false);
      }
      return;
    }

    if (state.running) {
      // Ignore all other input while command is running
      return;
    }

    if (data === '\r') { // Enter
      const current = state.input;
      state.input = '';
      term.write('\r\n');
      state.historyIndex = state.history.length;
      executeTerminalCommand(current);
      return;
    }

    if (data === '\u007f') { // Backspace
      if (state.input.length > 0) {
        state.input = state.input.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }

    if (data === '\u001b[A' || data === '\u001b[B') { // history navigation
      if (!state.history.length) return;
      if (data === '\u001b[A') {
        state.historyIndex = Math.max(0, state.historyIndex - 1);
      } else {
        state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
      }
      const nextValue = state.historyIndex >= state.history.length ? '' : state.history[state.historyIndex];
      replaceTerminalInput(nextValue);
      return;
    }

    if (data.startsWith('\u001b')) {
      // Ignore other escape sequences
      return;
    }

    state.input += data;
    term.write(data);
    if (terminalStickRef.current) term.scrollToBottom();
  }, [executeTerminalCommand, replaceTerminalInput, showPrompt]);

  useEffect(() => {
    terminalInputHandlerRef.current = handleTerminalData;
  }, [handleTerminalData]);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return undefined;
    const term = new Terminal({
      rows: 12,
      cursorBlink: true,
      scrollback: 4000,
      convertEol: false,
      theme: { background: '#111', foreground: '#f5f5f5' },
      ...TERMINAL_FONT
    });
    terminalRef.current = term;
    term.open(container);
    term.write(normalizeForTerminal('WordPress npm helper terminal.\n'));
    printHelp();
    showPrompt(false);
    const dataDisposable = term.onData((d) => terminalInputHandlerRef.current(d));
    const scrollDisposable = term.onScroll(() => {
      const buffer = term.buffer.active;
      const atBottom = buffer.baseY + buffer.cursorY >= buffer.length - term.rows;
      terminalStickRef.current = atBottom;
    });
    return () => {
      dataDisposable.dispose();
      scrollDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      terminalStickRef.current = true;
    };
  }, [normalizeForTerminal, printHelp, showPrompt]);

  useEffect(() => {
    const incoming = setupLogs || '';
    if (!incoming) return;
    const prev = setupLogsRef.current;
    if (incoming === prev) return;
    const diff = incoming.startsWith(prev) ? incoming.slice(prev.length) : incoming;
    if (diff) {
      appendNpm(diff);
      writeToTerminal(diff);
    }
    setupLogsRef.current = incoming;
  }, [appendNpm, setupLogs, writeToTerminal]);
  const stopDevServer = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    devServerActiveRef.current = false;
    setWaitingForWatch(false);
    waitingForWatchRef.current = false;
    serverStartRequestedRef.current = false;
    setStarting(false);
    try { await window.api.stopServer(sitePath); } catch {}
    try { window.api.stopWpDebug(sitePath); } catch {}
    // stopWpDebug only tears down the watcher in the main process. The renderer
    // keeps its own 'wp:debug-log:data' listener until this runs, and a second
    // start would add another one on top of it — every line then appended once
    // per dev-server run the session has had.
    try { if (wpDebugUnsubRef.current) { wpDebugUnsubRef.current(); wpDebugUnsubRef.current = null; } } catch {}
    try { if (newEmailUnsubRef.current) { newEmailUnsubRef.current(); newEmailUnsubRef.current = null; } } catch {}
    try { if (smtpStartedUnsubRef.current) { smtpStartedUnsubRef.current(); smtpStartedUnsubRef.current = null; } } catch {}
    setRunning(false);
    runningRef.current = false;
    setServerUrl('');
    setSmtpPort(0);
    stoppingRef.current = false;
    waitingForWatchRef.current = false;
    terminalKillRef.current = null;
    markTerminalRunning(false);
    currentRunIdRef.current = null;
    // The watcher is independent now (#247): stopping the dev server leaves it
    // running, so a contributor can keep compiling on save without serving the
    // site. It is stopped only by its own control (stopWatcher).
  }, [markTerminalRunning, setRunning, setServerUrl, setSmtpPort, setStarting, setWaitingForWatch, sitePath]);

  const startPhpServer = useCallback(async () => {
    if (serverStartRequestedRef.current || stoppingRef.current || !devServerActiveRef.current) {
      serverStartRequestedRef.current = false;
      return;
    }
    serverStartRequestedRef.current = true;
    setWaitingForWatch(false);
    waitingForWatchRef.current = false;
    ensureStick('runtime');
    setStarting(true);
    // Subscribe to SMTP events before starting to avoid missing early events
    if (!smtpStartedUnsubRef.current) smtpStartedUnsubRef.current = window.api.onSmtpStarted(sitePath, (port)=>setSmtpPort(port||0));
    if (!newEmailUnsubRef.current) newEmailUnsubRef.current = window.api.onNewEmail(sitePath, (msg)=>setEmails((prev)=>sortEmails([msg, ...prev])));
    try {
      const res = await window.api.startServer(
        sitePath,
        (p)=>appendRuntime(p.data || ''),
        (url)=>{
          if (stoppingRef.current) {
            serverStartRequestedRef.current = false;
            return;
          }
          const u = url.replace(/\/$/,'/');
          setServerUrl(u);
          window.api.openExternal(u);
          setRunning(true);
          runningRef.current = true;
          setStarting(false);
          serverStartRequestedRef.current = false;
        },
        ()=>{
          setRunning(false); runningRef.current = false; setServerUrl(''); serverStartRequestedRef.current = false;
          // A stop the user did not ask for is a crash: say so, and tear the
          // whole dev session down — watcher included — instead of leaving the
          // button spinning "Starting dev server…" forever (issue #73).
          if (!stoppingRef.current) {
            appendRuntime('Dev server stopped unexpectedly (see Help → Open App Log for details).\n');
            killCurrent().catch(() => {});
            stopDevServer().catch(() => {});
          }
        }
      );
      // A failed start reports through the return value, not an exception.
      // This also covers spawn failures that never produce a "stopped" event.
      if (res && res.ok === false && !stoppingRef.current && !runningRef.current) {
        appendRuntime(`Dev server failed to start: ${res.error || 'unknown error'}\n`);
        killCurrent().catch(() => {});
        stopDevServer().catch(() => {});
        return;
      }
    } catch (error) {
      appendRuntime(`Failed to start PHP server: ${error && error.message ? error.message : String(error)}\n`);
      setStarting(false);
      serverStartRequestedRef.current = false;
      runningRef.current = false;
      return;
    }
    // Reset before subscribing: the tail replays the tail of the file when it
    // attaches (up to 256KB, startWpDebugTail in main.js), so a restart would
    // otherwise show the previous session's log a second time below itself.
    // Stopping the server does not clear the pane — after a crash that log is
    // the thing to read — but starting a new run does.
    setDebugLogs('');
    setDebugUnread(0);
    try {
      if (wpDebugUnsubRef.current) { wpDebugUnsubRef.current(); wpDebugUnsubRef.current = null; }
      const tail = await window.api.startWpDebug(sitePath,(d)=>appendDebug(d || ''));
      wpDebugUnsubRef.current = tail?.unsubscribe || null;
      if (tail?.filePath) setDebugLogPath(tail.filePath);
    } catch {}
    try { const { port, emails: fetchedEmails } = await window.api.getEmails(sitePath); if (port) setSmtpPort(port); setEmails(fetchedEmails||[]); } catch {}
  }, [appendDebug, appendRuntime, ensureStick, killCurrent, newEmailUnsubRef, setEmails, setRunning, setServerUrl, setStarting, setSmtpPort, sitePath, smtpStartedUnsubRef, sortEmails, stopDevServer]);

  // The watcher process itself (grunt _watch), streaming into its own tab. No
  // terminal lock, no server coupling — that independence is the point of #247.
  const startWatchProcess = useCallback(() => {
    const plan = planDevServerStart({ hasBuilt: true });
    markWatchState('watching');
    watchWasActiveRef.current = true;
    appendWatch(`Running ${plan.watch.label}…\n`);
    runScript(plan.watch.script, {
      args: plan.watch.args,
      track: false,
      mirrorToNpm: false,
      onStart: (runId) => { watchRunIdRef.current = runId; },
      onLog: (chunk) => { appendWatch(chunk); },
      onDone: ({ code }) => {
        watchRunIdRef.current = null;
        appendWatch(`\n${plan.watch.label} exited with code ${code}\n`);
        // A watcher exit never touches the server (#247). Only an unexpected
        // exit flips the tab to 'exited'; a stop/pause we asked for has already
        // moved the state to 'idle'/'paused', so leave it be.
        if (watchStateRef.current === 'watching' || watchStateRef.current === 'building') {
          markWatchState('exited', code);
          watchWasActiveRef.current = false;
        }
      }
    });
  }, [appendWatch, markWatchState, runScript]);

  // Start the build watch, building first if the site has no completed build
  // (the _watch task deliberately skips that full build). `onReady` fires once
  // build/ exists and the watch has started — the server start hangs off it,
  // but the watch stays independent afterwards.
  const startBuildWatch = useCallback(({ onReady } = {}) => {
    const s = watchStateRef.current;
    if (s === 'watching') { if (onReady) onReady(); return; }
    if (s === 'building') return; // already on its way to watching
    if (!hasBuilt) {
      // Fresh / skip-the-wizard sites need one full build before anything can
      // watch or serve. It is a one-shot, so it holds the terminal lock while
      // it runs; the watch that follows does not. Reveal the tab so the build
      // is visible.
      const state = terminalStateRef.current;
      if (state.running) { appendWatch('A command is already running in the terminal — stop it before starting the build watch.\n'); return; }
      selectLogTab('watch');
      markWatchState('building');
      watchWasActiveRef.current = true;
      markTerminalRunning(true);
      terminalKillRef.current = () => { killCurrent().catch(() => {}); };
      appendWatch('No completed build found — running npm run build first…\n');
      runScript('build', {
        mirrorToNpm: false,
        onLog: (chunk) => { appendWatch(chunk); },
        onDone: ({ code }) => {
          markTerminalRunning(false);
          terminalKillRef.current = null;
          if (code !== 0 || watchStateRef.current !== 'building') {
            if (code !== 0) { appendWatch(`\nnpm run build failed with code ${code} — build watch not started.\n`); markWatchState('exited', code); }
            else markWatchState('idle');
            watchWasActiveRef.current = false;
            return;
          }
          startWatchProcess();
          if (onReady) onReady();
        }
      });
    } else {
      startWatchProcess();
      if (onReady) onReady();
    }
  }, [appendWatch, hasBuilt, killCurrent, markTerminalRunning, markWatchState, runScript, selectLogTab, startWatchProcess]);

  // User-initiated stop of the watch (its own button). Never touches the server.
  const stopWatcher = useCallback(async () => {
    const wasBuilding = watchStateRef.current === 'building';
    markWatchState('idle');
    watchWasActiveRef.current = false;
    if (watchRunIdRef.current) {
      try { await killWatcher(); } catch {}
    } else if (wasBuilding) {
      // Still in the one-shot build phase — that run is the tracked one.
      try { await killCurrent(); } catch {}
      markTerminalRunning(false);
      terminalKillRef.current = null;
    }
  }, [killCurrent, killWatcher, markTerminalRunning, markWatchState]);

  // Pause the watch for an operation that needs the build directory and
  // node_modules to itself — an install, a full build, a trunk reset (#262).
  // Returns whether it actually paused, so a caller can log accordingly; resume
  // is safe to call unconditionally since it no-ops unless the state is 'paused'.
  const pauseWatcher = useCallback(async () => {
    if (watchStateRef.current !== 'watching' && watchStateRef.current !== 'building') return false;
    markWatchState('paused');
    appendWatch('\nPaused while another operation uses the build.\n');
    try { await killWatcher(); } catch {}
    return true;
  }, [appendWatch, killWatcher, markWatchState]);

  // Bring the watch back after a pause. Guarded on 'paused' so a dev-server stop
  // or a manual stop mid-operation (which sets 'idle') is never resurrected.
  const resumeWatcher = useCallback(() => {
    if (watchStateRef.current !== 'paused') return;
    appendWatch('\nResumed.\n');
    startWatchProcess();
  }, [appendWatch, startWatchProcess]);

  const toggleWatch = useCallback(() => {
    const s = watchStateRef.current;
    if (s === 'watching' || s === 'building') { stopWatcher(); return; }
    // Starting it from its own button reveals the tab, whether or not a build
    // runs first — that is where its output and state live.
    selectLogTab('watch');
    startBuildWatch();
  }, [selectLogTab, startBuildWatch, stopWatcher]);

  const toggleDevServer = async ()=>{
    if (!running) {
      // eslint-disable-next-line no-alert -- see the note above onRename.
      if (!skipInit && !hasBuilt) { alert('Please complete the full build before starting the dev server. You can also skip the wizard.'); return; }
      serverStartRequestedRef.current = false;
      devServerActiveRef.current = true;
      setStarting(true);
      // The server needs build/ on disk, which the build watch guarantees. Start
      // the watch first (automatically, if it is not already running) and hang
      // the server start off its readiness — the watch stays independent after.
      startBuildWatch({ onReady: () => { startPhpServer().catch(() => {}); } });
    } else {
      await killCurrent().catch(() => {});
      await stopDevServer();
    }
  };
  const isServerStarting = waitingForWatch || (starting && !serverUrl);
  const isDevProcessActive = running || isServerStarting;
  let devServerButtonLabel = 'Start dev server';
  if (isDevProcessActive) devServerButtonLabel = isServerStarting ? 'Starting dev server...' : 'Stop dev server';
  // The build watch has its own control and status dot beside the server's — it
  // runs independently of the server (#247). Green watching, amber building or
  // paused, red an unexpected exit, grey stopped.
  const watchActive = watchState === 'watching' || watchState === 'building';
  const watchDotColor = WATCH_DOT_COLORS[watchState] || '#8c8f94';
  const watchButtonLabel = watchActive ? 'Stop build watch' : 'Start build watch';
  // Elapsed-seconds counter for the starting state, so a slow boot is
  // distinguishable from a hang (issue #73).
  const [startElapsed, setStartElapsed] = useState(0);
  useEffect(() => {
    if (!isServerStarting) {
      setStartElapsed(0);
      return undefined;
    }
    const id = setInterval(() => setStartElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isServerStarting]);
  const markSkipWizard = useCallback(async () => {
    await window.api.setSkipInitWizard(sitePath, true);
    setSkipInit(true);
  }, [sitePath]);
  // eslint-disable-next-line no-alert -- see the note above onRename.
  const confirmAnd = async (m,a)=>{ if(window.confirm(m)) await a(); };

  // The tickets with work on this site (#108), in a card of their own (#240)
  // between the Trac ticket card and the patch one — which ticket am I on,
  // which of my tickets do I want, bring in work from elsewhere. The sentence
  // differs with the state — with no ticket linked the rows offer to continue,
  // with one linked they point out the other open tickets — but the rows, the
  // ordering and the delete action are the same list, and it lives in the one
  // card in both states rather than jumping somewhere else on unlink.
  //
  // Switch and delete are checkouts of the same working directory that an
  // install, a build or a trunk update is using, so they block on the long
  // operations as well as on each other — the same trio every destructive
  // control in the ticket panel guards on.
  const branchRows = ticketBranchRows({ branches: ticketBranches.branches, current: ticketBranches.current, tracTicket, now: Date.now() });
  const ticketsCard = ticketListCard({ rowCount: branchRows.length, linked: Boolean(tracTicket) });
  // What the switch is doing, while it does it (#173). Gated on the busy flag
  // rather than merely cleared by it: the last sends can land after the invoke
  // has already answered, which would flash a sentence under an idle panel.
  // Where loose work went, said once and plainly (#108). Carrying uncommitted
  // edits into a new ticket is now something the contributor chooses in the
  // panel below (#234), so this confirms an answered question rather than
  // announcing a move the app made on its own.
  const carriedNotice = carriedWork ? (
    <div style={{ marginTop: 8, padding: '8px 12px', background: '#f0f6fc', border: '1px solid #c5d9ed', borderRadius: 6, color: '#1d2327', fontSize: 12 }}>
      Your {carriedWork.files} uncommitted {carriedWork.files === 1 ? 'change' : 'changes'} came along into #{carriedWork.ticket}, and will go into its patch.
    </div>
  ) : null;

  // The counterpart for the other answer to the same question: the edits were
  // saved and the ticket started clean. Rendered wherever the panel that
  // asked could have been, because that panel — and the path it showed — is
  // gone once the switch completes.
  const savedCleanNotice = patchSavedNotice ? (
    <div style={{ marginTop: 8, padding: '8px 12px', background: '#f0f6fc', border: '1px solid #c5d9ed', borderRadius: 6, color: '#1d2327', fontSize: 12 }}>
      Your edits were saved to {patchSavedNotice} and are no longer in the working tree.
    </div>
  ) : null;

  const switchProgressLine = ticketSaving && switchProgress ? (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, color: '#3c434a', fontSize: 12 }}>
      <Spinner />
      <span>{describeSwitchProgress(switchProgress)}</span>
    </div>
  ) : null;
  const ticketActionsBlocked = ticketSaving || deletingBranch !== null || updateState !== 'idle' || installing || building;

  // The one question both paths now ask (#234). Picking a ticket while trunk
  // has uncommitted edits used to do opposite things — carry them silently
  // into a new ticket, refuse the switch to a known one — split by an
  // implementation fact the contributor cannot see. Now main refuses both
  // ways with `dirty-trunk` and this panel asks once. Only the carry needs
  // the ticket to be new: an existing branch has its own work to restore, so
  // loose edits cannot ride into it. Rendered as a variable because two
  // views hold a "Link ticket" field, and a refusal with no panel under it
  // would be a dead end in the second one.
  const blockedPanel = blockedByTrunkWork ? (
    <div style={{ marginTop: 8, padding: '10px 12px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 6, color: '#6e5406', fontSize: 12 }}>
      <div>
        {blockedByTrunkWork.files
          ? `You have ${blockedByTrunkWork.files === 1 ? '1 uncommitted change' : `${blockedByTrunkWork.files} uncommitted changes`} on this site, not on any ticket yet.`
          : 'You have uncommitted changes on this site, not on any ticket yet.'}
        {' '}What should happen to them?
        {blockedByTrunkWork.canCarry ? '' : ' This ticket already has its own work here, so these edits cannot come along into it.'}
      </div>
      {patchSavedTo ? (
        <div style={{ marginTop: 6, fontWeight: 600 }}>
          Saved to {patchSavedTo}. The edits are still in the working tree.
        </div>
      ) : null}
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {blockedByTrunkWork.canCarry ? (
          <Button
            variant="link"
            isBusy={ticketSaving}
            disabled={ticketActionsBlocked}
            onClick={() => saveTicket(blockedByTrunkWork.ref, { carryTrunkWork: true })}
            style={{ fontSize: 12 }}
          >Take these edits into {blockedByTrunkWork.ticket ? `#${blockedByTrunkWork.ticket}` : 'the ticket'}</Button>
        ) : null}
        <Button variant="link" disabled={ticketActionsBlocked} onClick={() => saveTrunkWorkThenStartClean(blockedByTrunkWork.ref)} style={{ fontSize: 12 }}>
          Save them as a patch, then start clean…
        </Button>
        <Button
          variant="link"
          isDestructive
          disabled={ticketActionsBlocked}
          onClick={() => confirmAnd('Discard the uncommitted edits on trunk? This cannot be undone.', () => discardTrunkWorkAndSwitch(blockedByTrunkWork.ref))}
          style={{ fontSize: 12 }}
        >Discard them and start clean</Button>
        {/* The way out that touches nothing — three consequential actions
            with no fourth door is its own trap (#234). */}
        <Button variant="link" disabled={ticketActionsBlocked} onClick={() => { setBlockedByTrunkWork(null); setPatchSavedTo(''); }} style={{ fontSize: 12 }}>
          Cancel
        </Button>
      </div>
    </div>
  ) : null;
  const renderBranchRows = (linked) => (
    <div style={{ marginTop: 8, border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden' }}>
      {branchRows.map((row, i) => (
        <div key={row.ref} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: i < branchRows.length - 1 ? '1px solid #f0f0f1' : 'none' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <span style={{ fontSize: 13, color: '#1d2327' }}>
              {linked ? <>You also have work on #{row.ticketId}{' — '}</> : null}
              <Button variant="link" onClick={() => saveTicket(String(row.ticketId))} disabled={ticketActionsBlocked} style={{ fontSize: 13 }}>
                {linked ? 'switch' : `Continue working on #${row.ticketId}`}
              </Button>
            </span>
            {row.timeLabel ? (
              <div style={{ marginTop: 2, fontSize: 11, color: '#6c6f72' }}>{row.timeLabel}</div>
            ) : null}
          </div>
          <Button
            variant="link"
            isDestructive
            isBusy={deletingBranch === row.ref}
            disabled={ticketActionsBlocked}
            onClick={() => confirmAnd(`Delete all work on #${row.ticketId} on this site? This cannot be undone.`, () => deleteTicketWork(row.ref))}
            style={{ fontSize: 12, flex: '0 0 auto' }}
          >Delete this ticket&apos;s work</Button>
        </div>
      ))}
    </div>
  );

  // --- Update to latest trunk (#94) ---
  const age = trunkAgeInfo({ trunkDate });
  const isUpdating = updateState !== 'idle';
  // Where the note goes moves with the ticket: a change that belongs to
  // #12345 is news for the ticket card, one that belongs to nothing is news
  // for the buttons that would give it somewhere to go.
  const changesNote = changesNoteParts({ ...(worktreeDirty || {}), tracTicket });
  const staleTicketNotice = ticketTrunkNotice({ ticketId: tracTicket, behind: ticketBehindTrunk });
  const updateSteps = planUpdateSteps({ lockfileChanged: updateLockfileChanged });
  const updateStepStates = updateStepStatuses(updateSteps, updateState);

  const finishUpdate = (message) => {
    markTerminalRunning(false);
    terminalKillRef.current = null;
    setUpdateState('idle');
    if (message) writeToTerminal(message);
    // Resume the watch if the update paused it (#262). Safe on every exit path
    // and a no-op if nothing was paused.
    resumeWatcher();
    loadStatus().catch(() => {});
    refreshDirty();
  };

  // Steps 2 and 3 of the chain: npm install (only when the lockfile moved,
  // and named when skipped) then a rebuild. Reuses the wizard's runInstall /
  // runScript so exit codes, retries and terminal streaming all behave
  // exactly as they do everywhere else (same pattern as toggleDevServer).
  const runUpdateInstallAndBuild = (lockfileChanged) => {
    const runBuildStep = () => {
      setUpdateState('building');
      writeToTerminal('\nRunning npm run build…\n');
      runScript('build', {
        onLog: (chunk) => writeToTerminal(chunk),
        onDone: async ({ code }) => {
          if (code === 0) {
            try { await window.api.markUpdateComplete(sitePath); } catch {}
            const elapsedSeconds = updateStartRef.current ? Math.round((Date.now() - updateStartRef.current) / 1000) : null;
            setLastUpdateSummary({ lockfileChanged, elapsedSeconds, savedPatchPath: savedPatchPathRef.current });
            confirm('Updated to the latest trunk');
            finishUpdate('\nUpdate complete — this site is now on the latest trunk.\n');
          } else {
            finishUpdate('\nUpdate incomplete — the build failed. The code is new but the built assets are old; retry install & build from the banner above.\n');
          }
        }
      });
    };
    if (lockfileChanged) {
      setUpdateState('installing');
      writeToTerminal('\npackage-lock.json changed — running npm install (only the changed packages are downloaded)…\n');
      runInstall({
        onLog: (chunk) => writeToTerminal(chunk),
        onDone: ({ code }) => {
          if (code !== 0) {
            finishUpdate('\nUpdate incomplete — npm install failed. The code is new but dependencies and built assets are old; retry install & build from the banner above.\n');
            return;
          }
          runBuildStep();
        }
      });
    } else {
      writeToTerminal(`\n${SKIP_INSTALL_MESSAGE}\n`);
      runBuildStep();
    }
  };

  // --- Applying someone else's patch (#11) ---
  // Same three-stage shape as the update chain, and the same npm wrappers, so
  // exit codes and terminal streaming behave identically.
  const isApplying = applyState !== 'idle';
  const showTerminalHints = shouldShowTerminalHints({ hasBuilt });
  const terminalBusy = computeTerminalBusy({
    terminalRunning, installing, building, starting, running, isUpdating, isApplying
  });
  const applySteps = planApplySteps({ needsInstall: applyNeedsInstall, buildByWatcher: applyBuildByWatcher });
  const applyStepStates = updateStepStatuses(applySteps, applyState, APPLY_STATE_TO_STEP);

  // The applied patch as a layer with a name (#306), not an undo blob. Both
  // answers come from the same record: whether it can still be lifted out —
  // measured in main on every status read, so it comes back on its own when the
  // overlapping edit is undone — and whose changes the next patch would land on.
  const appliedLayer = describeAppliedLayer(appliedPatch, {
    when: appliedPatch?.appliedAt ? new Date(appliedPatch.appliedAt).toLocaleString() : ''
  });
  const appliedPatchLabel = appliedPatch?.label || 'The patch you applied';
  const previewAttribution = attributeConflicts({ conflicts: applyPreview?.conflicts, appliedPatch });
  // The layer exits reach the same two operations the changes note does, so
  // they go through the same guard: a discard is a force checkout, and running
  // it under a live dev server or a half-finished install rewrites the tree
  // from under it. Not re-derived here — that is how a second answer starts.
  const layerExitBlocked = discardBlocked({ isUpdating, installing, building, devServerActive: isDevProcessActive, discarding });
  const layerExit = layerExitFailure({ patchSaveError, discardError });

  // --- Initial setup, as one chain (#246) ---
  // The third chain, and the only one nobody starts: between the clone, the
  // install and the build there is no decision to make, so making the
  // contributor notice each one end and click the next was work the app was
  // handing back for nothing. It runs on its own once the clone finishes.
  //
  // What makes that reasonable rather than presumptuous is that it is visible
  // and it stops: the checklist names the running step, and Stop actually ends
  // the child (an install included, since the kill path learned to reach one).
  const isSettingUp = setupChainState !== 'idle';
  const setupSteps = planSetupSteps();
  const setupStepStates = updateStepStatuses(setupSteps, setupChainState, SETUP_STATE_TO_STEP);
  // Whether this chain is ending because the contributor asked it to. A killed
  // npm exits non-zero — on Windows without even a signal — so the exit code
  // cannot tell a stop from a failure; only the fact that we asked for the kill
  // can.
  const setupStoppedRef = useRef(false);

  // One sentence per way the chain can end, and `setupOutcome` is what picks
  // between them. Every one of them ends by naming where the rest of the work
  // now lives, because the chain going quiet is otherwise indistinguishable
  // from the app having forgotten about the site.
  const SETUP_END_MESSAGES = {
    done: '\nSetup complete — start the dev server when you are ready.\n',
    stopped: '\nSetup stopped. The remaining steps are in the checklist above — run them whenever you are ready.\n',
    'failed-install': '\nnpm install failed — setup stopped here. Its output is above; retry the install from the checklist.\n',
    'failed-build': '\nThe build failed — dependencies are installed. Its output is above; retry the build from the checklist.\n'
  };

  const finishSetupChain = (outcome) => {
    markTerminalRunning(false);
    terminalKillRef.current = null;
    setSetupChainState('idle');
    setSetupChainEnd(outcome);
    writeToTerminal(SETUP_END_MESSAGES[outcome] || '');
    if (outcome === 'done') confirm('This site is ready to work on');
  };

  const stopSetupChain = () => {
    setupStoppedRef.current = true;
    writeToTerminal('\nStopping setup…\n');
    killCurrent().catch(() => {});
  };

  const startSetupChain = () => {
    const state = terminalStateRef.current;
    if (state.running) return;
    setupStoppedRef.current = false;
    setSetupChainEnd(null);
    markTerminalRunning(true);
    terminalKillRef.current = () => { stopSetupChain(); };
    setSetupChainState('installing');
    writeToTerminal('\nSetting this site up — running npm install…\n');
    runInstall({
      onLog: (chunk) => writeToTerminal(chunk),
      onDone: ({ code }) => {
        const stopped = setupStoppedRef.current;
        // Stopping at the first failure is not politeness — a build on a
        // half-installed tree cannot work, and its failure would bury the one
        // that mattered (#42).
        if (stopped || code !== 0) {
          finishSetupChain(setupOutcome({ stopped, installCode: code }));
          return;
        }
        // Checked again here: Stop is reachable in the moment between the
        // install ending and the build being spawned, and a stop that quietly
        // started a half-hour build would be the worst possible answer to it.
        if (setupStoppedRef.current) {
          finishSetupChain(setupOutcome({ stopped: true }));
          return;
        }
        setSetupChainState('building');
        writeToTerminal('\nRunning npm run build…\n');
        runScript('build', {
          onLog: (chunk) => writeToTerminal(chunk),
          onDone: ({ code: buildCode }) => {
            finishSetupChain(setupOutcome({
              stopped: setupStoppedRef.current,
              installCode: 0,
              buildCode
            }));
          }
        });
      }
    });
  };

  // The chain is started by an edge, not by a state: the clone finishing. The
  // ref keeps that edge reachable from an effect that must not re-run whenever
  // the chain's own callbacks are rebuilt on a render.
  const startSetupChainRef = useRef(startSetupChain);
  useEffect(() => { startSetupChainRef.current = startSetupChain; });

  const wasPendingRef = useRef(isPending);
  const setupChainArmedRef = useRef(false);
  useEffect(() => {
    const gate = {
      wasPending: wasPendingRef.current,
      isPending,
      alreadyArmed: setupChainArmedRef.current
    };
    wasPendingRef.current = isPending;
    // Two calls, because the decision is: is this the clone-finished edge (so
    // reading the site's state off disk is worth it), and then does that state
    // say this is a fresh clone we should drive. See setupAutoStartDecision.
    if (setupAutoStartDecision(gate) !== 'probe') return undefined;
    setupChainArmedRef.current = true;
    let cancelled = false;
    (async () => {
      // The status this row is holding was probed while the clone was still
      // running, so it is re-read here rather than trusted.
      const status = (await loadStatus()) || null;
      if (cancelled) return;
      if (setupAutoStartDecision({ ...gate, status }) !== 'start') return;
      startSetupChainRef.current();
    })();
    return () => { cancelled = true; };
  }, [isPending, loadStatus]);

  // The single most recent patch across whatever is loaded — PRs always, Trac
  // attachments once the contributor has opened them (#11). Drives the "Latest"
  // pill and the "latest is a patch file" note.
  // `rankComplete` travels with the list: when the commit-date walk stopped
  // early there is no pill, because an unranked row could be the newer fix
  // (#281).
  const latestPatch = pickLatest({
    prs: ticketPatches?.items,
    attachments: tracAttachments?.items,
    prRankComplete: ticketPatches?.rankComplete
  });
  const latestIsAttachment = latestPatch?.kind === 'attachment';
  // The panel lists only what can be applied — screenshots and other non-patch
  // attachments are noise here. The parser still returns them (pickLatest and
  // tests rely on the full list); the filtering is purely what's shown.
  const patchAttachments = (tracAttachments?.items || []).filter((a) => a.applyable);
  // The ticket's own facts (#292), riding the same scrape as the attachments:
  // one Trac visit, one challenge, both answers.
  const tracInfo = tracAttachments?.ticket || null;
  const tracInfoBadge = statusBadge(tracInfo);
  const tracAttachmentsRead = tracAttachments
    && (tracAttachments.status === 'ok' || tracAttachments.status === 'no-attachments');
  // One pill shape, two uses: the "Latest" marker on a patch row and a linked
  // pull request's state. Only the words and the colours differ.
  const pillStyle = { display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
  const latestPill = (isLatest) => (isLatest ? (
    <span style={{ ...pillStyle, background: '#e7f1ff', color: '#0b5d95', marginLeft: 8 }}>
      Latest
    </span>
  ) : null);
  const prStatePill = (state) => {
    const badge = prStateBadge(state);
    return (
      <span style={{ ...pillStyle, background: badge.background, color: badge.color }}>
        {badge.label}
      </span>
    );
  };

  const finishApply = (message) => {
    markTerminalRunning(false);
    terminalKillRef.current = null;
    setApplyState('idle');
    if (message) writeToTerminal(message);
    // Resume the watch if this apply paused it. Safe on every exit path
    // (success, failure, cancel) and a no-op if nothing was paused (#262).
    resumeWatcher();
    loadStatus().catch(() => {});
    refreshDirty();
  };

  const runApplyInstallAndBuild = (needsInstall, verb, { runBuild = true } = {}) => {
    const runBuildStep = () => {
      setApplyState('building');
      writeToTerminal('\nRunning npm run build…\n');
      runScript('build', {
        onLog: (chunk) => writeToTerminal(chunk),
        onDone: ({ code }) => {
          // Only now is the apply genuinely done — the patch is on disk and the
          // site is rebuilt around it, so "open the site to try it out" is true
          // (#253). A failed build leaves stale assets and its own banner, so it
          // gets no success confirmation.
          if (code === 0) confirm(`${verb} the patch`);
          finishApply(code === 0
            ? `\n${verb} — open the site to try it out.\n`
            : `\nThe patch is ${verb.toLowerCase()} but the build failed, so the site still runs the old assets.\n`);
        }
      });
    };
    if (!runBuild) {
      // A running build watch recompiles the src/ change on its own, so there is
      // no install and no build of our own to run — just hand off to it (#262).
      confirm(`${verb} the patch`);
      finishApply(`\n${verb} — the build watch is recompiling it. Open the site to try it out.\n`);
      return;
    }
    if (needsInstall) {
      setApplyState('installing');
      writeToTerminal('\nThe patch changes package-lock.json — running npm install…\n');
      runInstall({
        onLog: (chunk) => writeToTerminal(chunk),
        onDone: ({ code }) => {
          if (code !== 0) {
            finishApply('\nnpm install failed, so the build was skipped. The patch is applied but dependencies are stale.\n');
            return;
          }
          runBuildStep();
        }
      });
    } else {
      writeToTerminal(`\n${SKIP_INSTALL_MESSAGE}\n`);
      runBuildStep();
    }
  };

  // Reads a patch file and works out what it would do, without touching the
  // checkout — the contributor decides after seeing the file list.
  const choosePatchFile = async () => {
    clearApplyError();
    setApplyNotice('');
    try {
      const chosen = await window.api.choosePatchFile();
      if (!chosen) return;
      if (chosen.error) {
        setApplyError(`Could not read that file: ${chosen.error}`);
        return;
      }
      const preview = await window.api.previewPatch(sitePath, chosen.text);
      if (!preview || !preview.ok) {
        setApplyError(preview?.error || 'Could not read that patch.');
        return;
      }
      setApplyPreview({ ...preview, label: chosen.name, text: chosen.text });
    } catch (e) {
      setApplyError(String(e));
    }
  };

  // Loads the PRs linked to the ticket. Manual, not on a timer: each call is a
  // request against a shared, unauthenticated GitHub limit, so it runs when the
  // contributor asks — on link, and on an explicit refresh.
  const loadTicketPatches = useCallback(async () => {
    setTicketPatchesLoading(true);
    try {
      const res = await window.api.listTicketPatches(sitePath);
      setTicketPatches(res && res.ok ? res.prs : { status: 'error', items: [] });
    } catch {
      setTicketPatches({ status: 'error', items: [] });
    } finally {
      setTicketPatchesLoading(false);
    }
  }, [sitePath]);

  // Load the ticket's PRs only for the active site. Every SiteRow stays mounted
  // (the parent hides inactive ones), so fetching on mount would spend the
  // shared, unauthenticated GitHub quota once per linked site on every launch.
  // The ref keeps re-activating a site from re-fetching the same ticket; a
  // relink (ticket change) and the Refresh button still fetch. Unlinking clears
  // the list. Placed after loadTicketPatches is defined: an effect that named it
  // earlier in the body would read the const before its declaration ran.
  const loadedTicketRef = useRef(null);
  // Set only by saveTicket, on a link the contributor just performed. The
  // per-ticket effect below consumes it to auto-read the ticket's details:
  // there, after the generation bump, so the scrape's result is not dropped as
  // stale. A ref and not state — it must not survive a remount, or selecting
  // an already-linked site would open a Trac window nobody asked for (#292).
  const autoReadTicketRef = useRef(null);
  const tracScrapeRef = useRef(null);
  // A Trac scrape can run up to 90s. Bump a generation on every ticket change so
  // a scrape that resolves after the ticket has moved on is dropped, rather than
  // shown under the wrong ticket or clearing a newer request's loading flag. Kept
  // on its own [tracTicket]-only effect, deliberately not folded into the one
  // below: that effect also re-runs on an `isActive` toggle (switching site tabs
  // and back), which must not bump the generation of an in-flight scrape that
  // has nothing to do with this ticket change (#299 follow-up). Declared first —
  // React runs same-component passive effects in declaration order — so the
  // bump always lands before the auto-triggered scrape a few lines down (#299).
  const scrapeGenRef = useRef(0);
  useEffect(() => { scrapeGenRef.current += 1; }, [tracTicket]);
  useEffect(() => {
    if (!tracTicket) {
      setTicketPatches(null);
      // Attachments are per-ticket and loaded on demand; a stale list from the
      // previous ticket must not linger, and a scrape dropped by the generation
      // bump above must not leave a stuck spinner.
      setTracAttachments(null);
      setTracAttachmentsLoading(false);
      loadedTicketRef.current = null;
      return;
    }
    if (!isActive || loadedTicketRef.current === tracTicket) return;
    // A new ticket on the active site: drop any attachments the previous one
    // loaded (and clear its loading flag, so a scrape dropped by the generation
    // bump above cannot leave a stuck spinner with no button to recover), then
    // fetch its PRs. Marked loaded before the fetch resolves, on purpose: a
    // failed initial fetch is not retried on every re-activation (which could
    // keep spending a rate-limited quota) — Refresh is the retry.
    setTracAttachments(null);
    setTracAttachmentsLoading(false);
    loadedTicketRef.current = tracTicket;
    loadTicketPatches();
    // Auto-read the ticket's own facts when this ticket was just linked by
    // hand (#292). Only then: the contributor just acted on this ticket, so a
    // human-check window appearing has context. On mount or re-activation the
    // ref is empty and nothing opens — details stay on demand, the #109 rule.
    if (autoReadTicketRef.current === tracTicket) {
      autoReadTicketRef.current = null;
      // Through the ref, not the function: loadTracAttachments is declared
      // below this effect and recreated per render — the same shape as
      // metaPatchRef above.
      if (tracScrapeRef.current) tracScrapeRef.current();
    }
  }, [tracTicket, isActive, loadTicketPatches]);

  // Fetches a PR's diff and drops into the same preview the file picker uses,
  // so applying a PR and applying a downloaded patch are one path from here on.
  const previewPr = async (pr) => {
    clearApplyError();
    setApplyNotice('');
    setFetchingPr(pr.number);
    try {
      const diff = await window.api.fetchPrDiff(pr.number);
      if (!diff || !diff.ok) {
        setApplyError(diff?.status === 'rate-limited'
          ? 'GitHub is rate-limiting this connection right now. Open the PR and download its .diff, then use “Choose a patch file”.'
          : `Could not fetch the diff for PR #${pr.number}: ${diff?.error || 'unknown error'}`);
        return;
      }
      const preview = await window.api.previewPatch(sitePath, diff.text);
      if (!preview || !preview.ok) {
        setApplyError(preview?.error || 'Could not read that diff.');
        return;
      }
      // `url` and `state` ride along so a conflict can offer the pull request
      // itself, framed by what it is: an open one is rebased by its author, a
      // closed one is nobody's to update (#282). State is absent when the PR
      // came from a pasted number rather than the linked list.
      setApplyPreview({ ...preview, label: `PR #${pr.number}`, text: diff.text, prUrl: pr.url, prState: pr.state || null });
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setFetchingPr(null);
    }
  };

  // Opens the real Trac ticket (the user clears the challenge once if shown),
  // scrapes its attachment list, and shows it in-app. On demand, not on link.
  const loadTracAttachments = async () => {
    const gen = scrapeGenRef.current;
    clearApplyError();
    setTracAttachmentsLoading(true);
    try {
      const res = await window.api.listTracAttachments(sitePath);
      if (gen !== scrapeGenRef.current) return; // ticket changed mid-scrape; drop the stale result
      setTracAttachments(res && res.ok ? res : { status: 'error', items: [] });
    } catch {
      if (gen !== scrapeGenRef.current) return;
      setTracAttachments({ status: 'error', items: [] });
    } finally {
      if (gen === scrapeGenRef.current) setTracAttachmentsLoading(false);
    }
  };

  // Downloads an attachment through the challenge-passing session and hands it
  // to the same preview the PR and file paths use.
  useEffect(() => { tracScrapeRef.current = loadTracAttachments; });

  const previewAttachment = async (att) => {
    clearApplyError();
    setApplyNotice('');
    setFetchingAttachment(att.url);
    try {
      const res = await window.api.fetchTracAttachment(att.url);
      if (!res || !res.ok) {
        setApplyError(res?.error || `Could not download ${att.filename}.`);
        return;
      }
      const preview = await window.api.previewPatch(sitePath, res.text);
      if (!preview || !preview.ok) {
        setApplyError(preview?.error || 'Could not read that patch.');
        return;
      }
      setApplyPreview({ ...preview, label: att.filename, text: res.text });
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setFetchingAttachment(null);
    }
  };

  // Apply a PR straight from a pasted URL or number, without needing it to be
  // linked to the ticket — same fetch → preview flow as the linked-PR list.
  const previewPrFromInput = () => {
    const parsed = parsePrRef(prUrlInput);
    // clearApplyError first, not setApplyError alone: a parse error arriving on
    // top of a conflict breakdown would otherwise leave the stale regions on
    // screen hiding it, since the banner leads with the breakdown's headline.
    if (!parsed.ok) { clearApplyError(); setApplyError(parsed.error); setApplyNotice(''); return; }
    setPrUrlInput('');
    previewPr({ number: parsed.number, url: `https://github.com/WordPress/wordpress-develop/pull/${parsed.number}` });
  };

  const runApply = async ({ reverse = false } = {}) => {
    const state = terminalStateRef.current;
    if (state.running) {
      writeToTerminal('A command is already running. Press Ctrl+C to stop it.\n');
      return;
    }
    const preview = applyPreview;
    const needsInstall = reverse
      ? Boolean(appliedPatch?.files?.includes('package-lock.json'))
      : Boolean(preview.needsInstall);
    // A running build watch already recompiles src/, so a src-only patch skips
    // the build and is not interrupted; an install/full build pauses it (#262).
    const watcherActive = watchStateRef.current === 'watching';
    const impact = planWatchImpact({ needsInstall, watcherActive });
    clearApplyError();
    setApplyNotice('');
    setApplyNeedsInstall(needsInstall);
    setApplyBuildByWatcher(!impact.runBuild);
    setApplyState('applying');
    markTerminalRunning(true);
    if (impact.pauseWatcher) await pauseWatcher();
    // Same contract as the other chains: while `running` is set, Ctrl+C in the
    // terminal has to reach the child process the chain is about to spawn.
    terminalKillRef.current = () => { killCurrent().catch(() => {}); };
    window.api.applyPatch(
      sitePath,
      reverse ? { reverse: true } : { patchText: preview.text, label: preview.label },
      ({ data }) => writeToTerminal(data),
      (res) => {
        if (!res || !res.ok) {
          // The main process has already dropped the stale record, so reloading
          // the status is what takes the "is applied" banner down and frees the
          // panel to accept another patch. Nothing was written, so there is
          // nothing to install or build.
          if (res?.notApplied) {
            if (res.recordCleared) {
              setApplyNotice(`${res.error} The applied-patch record has been cleared.`);
            } else {
              setApplyError(`${res.error} The record of it could not be cleared, so this site still thinks it is applied.`);
            }
            // finishApply reloads the status, which is what takes the banner
            // down now that the main process has dropped the record.
            finishApply();
            return;
          }
          setApplyError(res?.error || 'The patch could not be applied.');
          // A conflict is where the panel used to stop: one file named, the
          // rest of the failures left in the terminal, and no sense of whether
          // one region of twenty missed or all of them. The breakdown is what
          // turns that into a decision (#282). A reverse gets its own framing
          // (#306): it fails only because the contributor's own edits are on the
          // patch's lines, so the ticket's other patches and the pull request's
          // author are both the wrong place to send them.
          setApplyConflict(describeApplyFailure(res, reverse
            ? { reverting: appliedPatch?.label || 'That patch' }
            : {
              otherPatchCount: otherPatchCount({
                label: preview?.label,
                prs: ticketPatches?.items,
                attachments: patchAttachments
              }),
              prUrl: preview?.prUrl || null,
              prState: preview?.prState || null,
              appliedPatch,
              // The preview's own collision list: the files this ticket has work
              // in, measured from its base (#301). Without it an open pull
              // request is always narrated as stale, so a failure caused by the
              // contributor's own edits sends them to ask a stranger for a
              // rebase that would not help (#303).
              ownWorkPaths: preview?.conflicts || []
            }));
          finishApply();
          return;
        }
        setApplyPreview(null);
        // The confirmation waits until the rebuild finishes (see runBuildStep) —
        // the patch is on disk now, but the site is not usable until it is built
        // around it, so announcing "applied" here would be premature. When a
        // watch will rebuild it, runApplyInstallAndBuild confirms right away.
        runApplyInstallAndBuild(needsInstall, reverse ? 'Reverted' : 'Applied', { runBuild: impact.runBuild });
      }
    ).catch((e) => {
      // A rejected invoke never reaches onDone, so without this the terminal
      // stays wedged with `running` set and no way back short of a reload.
      setApplyError(String(e));
      finishApply();
    });
  };

  // Step 1: fetch + reset in the main process, then hand over to the npm
  // steps. Assumes the tree is clean (startTrunkUpdate handles dirty trees).
  const beginTrunkUpdate = async () => {
    const state = terminalStateRef.current;
    if (state.running) {
      writeToTerminal('A command is already running. Press Ctrl+C to stop it.\n');
      return;
    }
    // A trunk reset rewrites the whole tree at once; a live watch would try to
    // recompile mid-reset. Pause it for the update; finishUpdate resumes it. The
    // PHP server stays up — the rebuild regenerates build/ under it (#262).
    await pauseWatcher();
    markTerminalRunning(true);
    terminalKillRef.current = () => { killCurrent().catch(() => {}); };
    setUpdateLockfileChanged(false);
    setLastUpdateSummary(null);
    updateStartRef.current = Date.now();
    setUpdateState('fetching');
    window.api.updateTrunk(sitePath, ({ data }) => writeToTerminal(data), (res) => {
      if (!res || !res.ok) {
        // The main process already wrote the failure message to the stream.
        finishUpdate();
        return;
      }
      if (res.upToDate) {
        // Nothing to fetch — but "Already up to date." only reaching the
        // terminal left the contributor unsure the check had even run (#253).
        // The confirmation says so where it will be seen; there is no install
        // or build to follow.
        confirm('Already up to date with trunk');
        finishUpdate();
        return;
      }
      setUpdateLockfileChanged(Boolean(res.lockfileChanged));
      runUpdateInstallAndBuild(Boolean(res.lockfileChanged));
    });
  };

  const startTrunkUpdate = async () => {
    // The dev server no longer blocks an update: the watch is paused for the
    // reset and the PHP server stays up (#262). Only real in-progress work
    // (an update, install or build already running) still blocks.
    if (isUpdating || installing || building) return;
    savedPatchPathRef.current = null;
    try {
      const res = await window.api.isWorktreeDirty(sitePath);
      if (res && res.ok && res.dirty) {
        setDirtyFiles(Array.isArray(res.files) ? res.files : []);
        setDirtyChoice('save');
        setDirtyError(null);
        setDirtyModalOpen(true);
        return;
      }
    } catch {}
    beginTrunkUpdate();
  };

  // Dirty-tree resolutions. Saving is the default: it is what the tool is
  // for, and it is the only option that cannot lose work.
  const dirtySaveAndUpdate = async () => {
    setDirtySaving(true);
    setDirtyError(null);
    try {
      const res = await window.api.savePatch(sitePath);
      if (res && res.canceled) return; // stay in the modal
      if (!res || !res.ok || !res.filePath) {
        setDirtyError(`Error saving diff: ${res && res.error ? res.error : 'Unknown error'}`);
        return;
      }
      const d = await window.api.discardChanges(sitePath);
      if (!d || !d.ok) {
        setDirtyError(`Saved your changes to ${res.filePath}, but resetting the working tree failed: ${d && d.error ? d.error : 'Unknown error'}`);
        return;
      }
      savedPatchPathRef.current = res.filePath;
      applyDiscardToNote(discardOutcome(d));
      setDirtyModalOpen(false);
      writeToTerminal(`\nSaved your changes to ${res.filePath} and reset the working tree.\n`);
      // This ran as the contributor closed the modal; the confirmation is the
      // only trace of it outside the terminal (#253).
      confirm(`Saved your changes to ${pathBasename(res.filePath)} and reset the working tree`);
      beginTrunkUpdate();
    } finally {
      setDirtySaving(false);
    }
  };

  const dirtyDiscardAndUpdate = () => confirmAnd(DISCARD_CONFIRM_MESSAGE, async () => {
    setDirtyError(null);
    const d = await window.api.discardChanges(sitePath);
    if (!d || !d.ok) {
      setDirtyError(`Failed to discard changes: ${d && d.error ? d.error : 'Unknown error'}`);
      return;
    }
    applyDiscardToNote(discardOutcome(d));
    setDirtyModalOpen(false);
    writeToTerminal('\nDiscarded local changes.\n');
    confirm('Local changes discarded.');
    beginTrunkUpdate();
  });

  // Re-entry point for a previously interrupted update: trunk already moved,
  // so only install+build remain. Install runs unconditionally — the
  // lockfile delta from the failed run is no longer known.
  const retryInstallAndBuild = async () => {
    const state = terminalStateRef.current;
    if (state.running) {
      writeToTerminal('A command is already running. Press Ctrl+C to stop it.\n');
      return;
    }
    // Same as beginTrunkUpdate: install + a full build need the tree to
    // themselves, so pause the watch; finishUpdate resumes it (#262).
    await pauseWatcher();
    markTerminalRunning(true);
    terminalKillRef.current = () => { killCurrent().catch(() => {}); };
    setUpdateLockfileChanged(true);
    setLastUpdateSummary(null);
    updateStartRef.current = Date.now();
    runUpdateInstallAndBuild(true);
  };

  // The diff fetch, shared by opening the modal and by a discard that happens
  // while it is open — the pane has to show what the tree now holds, which
  // after a discard is the "nothing to send" banner.
  const loadPatchText = async () => {
    setPatchLoading(true);
    setPatchLoadFailed(false);
    try {
      const res = await window.api.getPatch(sitePath);
      if (res && res.ok) setPatchText((res.patch && res.patch.trim().length) ? res.patch : 'No changes.');
      else {
        setPatchLoadFailed(true);
        setPatchText(res && res.error ? `Error: ${res.error}` : 'Failed to generate patch');
      }
    } catch (e) {
      setPatchLoadFailed(true);
      setPatchText(`Error: ${e && e.message ? e.message : String(e)}`);
    } finally {
      setPatchLoading(false);
    }
  };

  const openPatchModal = async ()=>{
    setIsPatchOpen(true);
    setPatchText('');
    setPatchLoadFailed(false);
    // Last time's outcome belongs to last time's patch.
    setPatchSaved(null);
    setPatchSaveError('');
    setDiscardError(null);
    setHandleError('');
    setEditingHandle(false);
    // Same rule for the pull request card: last time's outcome belongs to last
    // time's patch. The account is not reset — that survives the modal — but it
    // is re-read, since it can have been signed out from another site's panel.
    setPrResult(null);
    setPrError(null);
    setPrStage('');
    setPrNotes('');
    setGithubError('');
    setGithubDeclined(false);
    loadGithubAccount();
    await loadPatchText();
  };

  // One discard for both entry points — the note's link and the modal's. The
  // confirm is the same native one the dirty-update modal uses; the user has
  // already chosen, this is the last chance to notice they chose wrong.
  // Both links disable through discardBlocked; no re-check in here. The
  // native confirm blocks the renderer, so the states discardBlocked names
  // cannot flip while the dialog is up — a check after it would read the
  // same render-time values the disabled prop already enforced.
  const discardAllChanges = () => confirmAnd(DISCARD_CONFIRM_MESSAGE, async () => {
    setDiscarding(true);
    setDiscardError(null);
    try {
      let outcome;
      try {
        outcome = discardOutcome(await window.api.discardToBase(sitePath));
      } catch (e) {
        // A rejected invoke never returns a reply object; shape it into one so
        // the failure reaches the same red line instead of vanishing.
        outcome = discardOutcome({ ok: false, error: e && e.message ? e.message : String(e) });
      }
      if (!outcome.ok) {
        setDiscardError(outcome.message);
        return;
      }
      applyDiscardToNote(outcome);
      const feedback = applyFeedbackAfterDiscard(outcome);
      setAppliedPatch(feedback.appliedPatch);
      setApplyError(feedback.applyError);
      setApplyConflict(feedback.applyConflict);
      setApplyNotice(feedback.applyNotice);
      writeToTerminal('\nDiscarded local changes.\n');
      confirm('All changes discarded.');
      if (isPatchOpen) await loadPatchText();
    } finally {
      setDiscarding(false);
    }
  });

  // The sentence is one thing wherever it renders; only the wrapper differs.
  const changesNoteBody = changesNote ? (
    <>
      {changesNote.lead}
      <Button variant="link" onClick={openPatchModal} disabled={isUpdating}>{changesNote.patchLabel}</Button>
      {changesNote.middle}
      <DiscardChangesLink
        label={changesNote.discardLabel}
        onClick={discardAllChanges}
        reason={discardDisabledReason({
          patchHasChanges: true,
          isUpdating,
          installing,
          building,
          devServerActive: isDevProcessActive,
          discarding
        })}
      />
      {changesNote.end}
      {discardError ? <div style={{ color: '#d63638', fontSize: 12, marginTop: 4 }}>{discardError}</div> : null}
    </>
  ) : null;

  // Copying is the one action here with no visible result: the clipboard is
  // somewhere else, the diff does not move, and a button that answers nothing
  // reads as a button that did nothing — so it gets pressed again, and the
  // contributor is left unsure whether they have the patch at all.
  //
  // A failed copy says so rather than staying quiet. `writeText` rejects when
  // the document is not focused, which is exactly the case where someone has
  // clicked away mid-action and is least likely to notice nothing happened.
  useEffect(() => () => { if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current); }, []);

  const copyPatch = async () => {
    // Cleared first so a second press restarts the message instead of
    // inheriting the timer of the one before it.
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    let state = 'copied';
    try {
      await navigator.clipboard.writeText(patchText);
    } catch {
      state = 'failed';
    }
    setPatchCopied(state);
    copyFeedbackTimer.current = setTimeout(() => setPatchCopied(''), 2000);
  };

  // Naming destinations for a patch that does not exist would be noise, and
  // both of the states that produce one are already spelled out in the pane
  // below: `getPatch` returns the literal 'No changes.', and its failures are
  // put in the same box prefixed with 'Error'. The sentinel can arrive under
  // `#` lines naming binaries that could not be carried (#85), so the test is
  // "is there a diff under the commentary" rather than a string comparison.
  const patchHasChanges = Boolean(patchText)
    && hasDiffLines(patchText)
    && !patchText.startsWith('Error');
  const modalDiscardReason = discardDisabledReason({
    patchLoading,
    patchLoadFailed,
    patchHasChanges,
    isUpdating,
    installing,
    building,
    devServerActive: isDevProcessActive,
    discarding
  });

  // Saving the file, for every destination that needs one (#166). `handoff`
  // asks the main process for the provenance header and the name that carries
  // the handle; `destination: 'trac'` keeps the diff plain but lets main enforce
  // the same applied-layer guard as the UI. With no options this is the backup
  // the Save button has always produced. Returns the path so a caller can say
  // what it did next — the Trac route saves and then opens the attach page.
  const savePatchFile = async (options) => {
    setPatchSaved(null);
    setPatchSaveError('');
    try {
      const res = await window.api.savePatch(sitePath, options);
      if (res && res.ok && res.filePath) {
        setPatchSaved(res.filePath);
        // The green line below is the record of where it went; this is the
        // announcement, for a contributor who saved from a menu and is no
        // longer looking at the pane (#253).
        confirm(`Patch saved to ${pathBasename(res.filePath)}`);
        return res.filePath;
      }
      if (res && res.canceled) return null;
      setPatchSaveError(res && res.error ? res.error : 'Unknown error');
    } catch (e) {
      setPatchSaveError(e && e.message ? e.message : String(e));
    }
    return null;
  };

  const savePatch = () => savePatchFile();

  // The Trac destination in full: save the file, then open the ticket's attach
  // page so the contributor uploads it themselves. Nothing is posted from here
  // — that would mean carrying a wordpress.org session, which #166 rules out.
  // The page is opened only after a file exists, so the browser never lands on
  // an attach form with nothing to attach.
  const saveForTrac = async () => {
    const filePath = await savePatchFile({ destination: 'trac' });
    if (filePath && tracTicket) window.api.openExternal(attachUrl(tracTicket));
  };

  const saveForHandoff = async () => {
    if (!wporg?.handle) return;
    await savePatchFile({ handoff: true });
  };

  // --- The pull request destination (#167) ---

  const loadGithubAccount = async () => {
    try {
      const res = await window.api.getGithubAccount();
      setGithubAccount(res && res.ok ? res : { login: null, configured: false });
    } catch {
      setGithubAccount({ login: null, configured: false });
    }
  };

  // Sign-in is two-legged on purpose: this resolves as soon as there is a code
  // to show, because the contributor's next move is in a browser, and the
  // outcome of the wait arrives later on the callback.
  const startGithubSignIn = async () => {
    setGithubError('');
    setCodeCopied(false);
    let started;
    try {
      started = await window.api.signInToGithub((done) => {
        setGithubDeviceCode(null);
        if (done && done.ok) {
          setGithubAccount((prev) => carryTestMode(prev, { login: done.login, configured: true }));
          setGithubError('');
          return;
        }
        // Declining is a choice, not a fault, so it reads as one.
        setGithubError(done && done.reason === 'denied'
          ? 'The authorization was declined on GitHub. Nothing was changed.'
          : (done && done.error) || 'Sign-in did not complete.');
      });
    } catch (e) {
      setGithubError(e && e.message ? e.message : String(e));
      return;
    }
    if (!started || !started.ok) {
      setGithubError((started && started.error) || 'Could not start sign-in.');
      return;
    }
    setGithubDeviceCode({ userCode: started.userCode, verificationUri: started.verificationUri });
    // Opening the page here rather than making it a second button: the code on
    // screen is only useful on that page, and a contributor who has just been
    // told what will happen should not have to go looking for where.
    window.api.openExternal(started.verificationUri);
  };

  const cancelGithubSignIn = async () => {
    setGithubDeviceCode(null);
    setGithubError('');
    try { await window.api.cancelGithubSignIn(); } catch {}
  };

  const signOutOfGithub = async () => {
    try { await window.api.signOutOfGithub(); } catch {}
    setGithubAccount((prev) => carryTestMode(prev, { login: null, configured: prev?.configured !== false }));
    setPrResult(null);
    setPrError(null);
  };

  const openPullRequest = async () => {
    setPrError(null);
    setPrResult(null);
    setPrStage('forking');
    // Subscribed only for the duration of the attempt: the event carries a site
    // path because one main process serves every open site, and a stale
    // listener would move another site's spinner.
    const unsubscribe = window.api.subscribePullRequestProgress((payload) => {
      if (payload && payload.sitePath === sitePath) setPrStage(payload.stage);
    });
    try {
      const res = await window.api.openPullRequest(sitePath, { title: prTitle, notes: prNotes });
      if (res && res.ok) {
        setPrResult(res);
        // The result panel below carries the link; this announces the outcome
        // for a contributor who looked away during the slow fork step (#253).
        confirm(prConfirmationMessage(res));
      } else {
        setPrError(res || { reason: 'error', error: 'The pull request could not be opened.' });
        // A revoked authorization is forgotten in the main process, so the card
        // has to stop claiming an account it no longer has.
        if (res && res.reason === 'unauthorized') setGithubAccount((prev) => carryTestMode(prev, { login: null, configured: true }));
      }
    } catch (e) {
      setPrError({ reason: 'error', error: e && e.message ? e.message : String(e) });
    } finally {
      setPrStage('');
      unsubscribe();
    }
  };

  const copyPrLink = async () => {
    if (!prResult?.url) return;
    try {
      await navigator.clipboard.writeText(prResult.url);
      setPrLinkCopied(true);
      setTimeout(() => setPrLinkCopied(false), 2000);
    } catch {}
  };

  // The pull request card has six states and they are genuinely sequential —
  // done, still asking, waiting on the browser, ready, declined, not started.
  // Written as nested ternaries in the JSX that is one expression six levels
  // deep and unreadable at the point where the wording matters most, so the
  // states get early returns and the card body gets one call.
  const renderPullRequestBody = () => {
    if (appliedPatch) {
      return (
        <div style={{ fontSize:12, color:'#6e5406', lineHeight:1.5 }}>
          Revert {appliedPatchLabel} before opening a pull request from this checkout.
        </div>
      );
    }

    if (prResult) {
      return (
        <>
          {/*
            A dry run (WP_DEV_ENV_GITHUB_DRY_RUN) stops after the branch: the
            fork writes are private, the pull request is the step watchers
            hear about. Saying so beats a "pull request #null".
          */}
          {prResult.dryRun ? (
            <div style={{ fontSize:13, color:'#0f5132' }}>
              Dry run — branch <Button variant="link" onClick={()=>window.api.openExternal(prResult.url)} style={{ fontSize:13 }}><code style={{ fontSize:12 }}>{prResult.branch}</code></Button> was created on your fork; no pull request was opened.
            </div>
          ) : (
          <div style={{ fontSize:13, color:'#0f5132' }}>
            Opened <Button variant="link" onClick={()=>window.api.openExternal(prResult.url)} style={{ fontSize:13 }}>pull request #{prResult.number}</Button>
            {' '}from <code style={{ fontSize:12 }}>{prResult.branch}</code>.
          </div>
          )}
          {/*
            The branch always bases on today's trunk (see resolveBase); this
            names the consequence when the local checkout was behind it. The
            clash guard has already ruled out upstream changes to the same
            files, so this is information, not alarm.
          */}
          {prResult.exactBase === false ? (
            <div style={{ fontSize:12, color:'#6e5406', background:'#fcf9e8', border:'1px solid #dba617', borderRadius:6, padding:'8px 10px' }}>
              Your checkout was behind trunk, so the branch was based on today&apos;s trunk. None of your files were changed upstream in between — the pull request shows only your work.
            </div>
          ) : null}
          {/*
            The Trac loop-back is for a pull request that exists — a dry run
            has no link worth posting on a ticket.
          */}
          {!prResult.dryRun && (
            <>
              <div style={{ fontSize:12, color:'#3c434a', lineHeight:1.5 }}>
                Triage and props live on the ticket, so the link belongs there too.
              </div>
              <Button variant="secondary" onClick={copyPrLink} icon={prLinkCopied ? checkIcon : copyIcon} style={{ justifyContent:'center' }}>
                {prLinkCopied ? 'Link copied' : 'Copy the link'}
              </Button>
              {tracTicket ? (
                <Button variant="primary" onClick={()=>window.api.openExternal(ticketUrl(tracTicket))} style={{ justifyContent:'center' }}>
                  Open #{tracTicket} to comment
                </Button>
              ) : null}
            </>
          )}
        </>
      );
    }

    // Not yet asked, which is not the same as signed out: offering "Sign in"
    // before the answer arrives makes the card flicker on every open.
    if (githubAccount === null) {
      return <div style={{ fontSize:12, color:'#6c6f72' }}>Checking…</div>;
    }

    if (githubAccount.configured === false) {
      return (
        <div style={{ fontSize:12, color:'#6c6f72' }}>
          This build has no GitHub application configured, so it cannot open a pull request. The other destinations still work.
        </div>
      );
    }

    if (githubDeviceCode) {
      return (
        <>
          <div style={{ fontSize:12, color:'#3c434a', lineHeight:1.5 }}>
            Enter this code at <strong>github.com/login/device</strong>, which has been opened in your browser.
          </div>
          <div style={{ fontFamily:'Menlo, Consolas, monospace', fontSize:24, letterSpacing:2, fontWeight:600, textAlign:'center', padding:'10px 0', color:'#1d2327' }}>
            {githubDeviceCode.userCode}
          </div>
          <Button variant="secondary" onClick={copyDeviceCode} icon={codeCopied ? checkIcon : copyIcon} style={{ justifyContent:'center' }}>
            {codeCopied ? 'Code copied' : 'Copy the code'}
          </Button>
          <Flex justify="center" gap={2}>
            <Spinner />
            <div style={{ fontSize:12, color:'#6c6f72' }}>Waiting for you to finish in the browser…</div>
          </Flex>
          <Button variant="link" onClick={cancelGithubSignIn} style={{ fontSize:12 }}>Cancel</Button>
        </>
      );
    }

    if (githubAccount.login) {
      return (
        <>
          {tracTicket ? (
            <>
              {/*
                The placeholder used to be the fallback title, `Ticket #NNNNN`,
                which taught the wrong thing by example: a reviewer scanning a
                list of pull requests learns nothing from a ticket number they
                can already see. It shows a good title instead, and the line
                under the field says what an empty box will produce, so the
                fallback stays honest without being the model.
              */}
              <TextControl
                value={prTitle}
                onChange={setPrTitle}
                disabled={Boolean(prStage)}
                placeholder="Reject a theme zip in the plugin installer"
                label="Title"
                help="What the change does, in one line. Reviewers scan these."
              />
              {!prTitle.trim() ? (
                <div style={{ fontSize:12, color:'#6c6f72', marginTop:-4 }}>
                  Left empty, it will be titled <strong>Ticket #{tracTicket}</strong>.
                </div>
              ) : null}
              {/*
                The one part of the body a human writes, and the reason the
                field exists: everything else — the ticket link, the handle,
                the event — the app already knows and adds. It goes to the top
                of the description, above the ticket line.
              */}
              <TextareaControl
                value={prNotes}
                onChange={setPrNotes}
                disabled={Boolean(prStage)}
                rows={4}
                label="Notes for reviewers (optional)"
                placeholder={'What the change does, and why.\nHow to see it working — the steps you used.\nAnything you are unsure about.'}
                help="Goes at the top of the description. The ticket link and your WordPress.org username are added underneath."
              />
              {/*
                Two facts from the core handbook that a first-timer has no way
                to know and that change what they do next: nobody is watching
                GitHub, and nothing is merged there. Both make the Trac step
                this flow ends on the point rather than the postscript, so they
                are stated before the button, not after the pull request
                exists.
              */}
              <details style={{ fontSize:12, color:'#6c6f72' }}>
                <summary style={{ cursor:'pointer', color:'#3858e9' }}>How pull requests work in core</summary>
                <div style={{ padding:'8px 0 0', lineHeight:1.6, display:'flex', flexDirection:'column', gap:6 }}>
                  <div>Nobody watches the pull request list. Yours is seen because its link is on the ticket — which is why this flow ends by sending you back there.</div>
                  <div>Nothing is merged on GitHub either. A committer applies the change themselves, and the ticket is where they decide to.</div>
                  <Button
                    variant="link"
                    onClick={()=>window.api.openExternal('https://make.wordpress.org/core/handbook/contribute/git/github-pull-requests-for-code-review/')}
                    style={{ fontSize:12 }}
                  >The handbook page on pull requests</Button>
                </div>
              </details>
              {/*
                The button says what it will actually do. A dry run's button
                reading "Open pull request" is the label lying about the mode,
                which is the failure this whole indicator exists to prevent.
              */}
              <Button
                variant="primary"
                onClick={openPullRequest}
                isBusy={Boolean(prStage)}
                disabled={Boolean(prStage)}
                style={{ justifyContent:'center' }}
              >{githubAccount?.testMode?.dryRun ? 'Push branch (dry run)' : 'Open pull request'}</Button>
            </>
          ) : (
            <div style={{ fontSize:12, color:'#6c6f72' }}>
              No ticket is linked to this site. A pull request has to cite one — link it in the Trac card.
            </div>
          )}
          {prStage ? (
            <div style={{ fontSize:12, color:'#6c6f72' }}>{PR_STAGE_LABELS[prStage] || 'Working…'}</div>
          ) : (
            <div style={{ fontSize:12, color:'#6c6f72' }}>
              {/*
                The destination is named, not implied: "the fork is made for
                you" answers what, this answers where — which account the fork
                and the branch land in.
              */}
              Signed in as {githubAccount.login} — the fork and branch go to{' '}
              <Button
                variant="link"
                onClick={()=>window.api.openExternal(`https://github.com/${githubAccount.login}/wordpress-develop`)}
                style={{ fontSize:12 }}
              >{githubAccount.login}/wordpress-develop</Button>.{' '}
              <Button variant="link" onClick={signOutOfGithub} style={{ fontSize:12 }}>Sign out</Button>
            </div>
          )}
        </>
      );
    }

    if (githubDeclined) {
      return (
        <>
          <div style={{ fontSize:12, color:'#6c6f72' }}>
            Nothing was signed in and nothing was sent. The patch file is still yours to save, and the other two destinations are unchanged.
          </div>
          <Button variant="link" onClick={()=>setGithubDeclined(false)} style={{ fontSize:12 }}>Show this again</Button>
        </>
      );
    }

    return (
      <>
        {/*
          The whole ask, before any of it happens — including the part the app
          cannot do for you. Declining has to be as visible as accepting, or the
          cliff is sprung rather than named.
        */}
        <div style={{ fontSize:12, color:'#3c434a', lineHeight:1.6 }}>
          Signing in lets the app fork wordpress-develop to your account, push this patch to a branch there, and open the pull request. It signs you in through your browser, never asks for your password, and forgets the authorization when you quit.
        </div>
        <div style={{ fontSize:12, color:'#6c6f72', lineHeight:1.6 }}>
          It cannot create the GitHub account for you, and it cannot post to Trac on your behalf.
        </div>
        <Button variant="primary" onClick={startGithubSignIn} style={{ justifyContent:'center' }}>Sign in with GitHub</Button>
        <Button variant="link" onClick={()=>{ setGithubDeclined(true); setGithubError(''); }} style={{ fontSize:12 }}>Not now</Button>
      </>
    );
  };

  const copyDeviceCode = async () => {
    if (!githubDeviceCode?.userCode) return;
    try {
      await navigator.clipboard.writeText(githubDeviceCode.userCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {}
  };

  // Both fields are written in one go, because they are asked in one form. The
  // event is optional: an empty box means "not at an event", which is also how
  // it is cleared once the WordCamp is over.
  const rememberContributor = async () => {
    if (!wporg) return;
    setHandleSaving(true);
    setHandleError('');
    try {
      const named = await wporg.rememberHandle(handleInput);
      if (!named?.ok) {
        setHandleError(named?.error || 'Could not save that username.');
        return;
      }
      const at = await wporg.rememberEvent(eventInput);
      if (!at?.ok) {
        setHandleError(at?.error || 'Could not save that event.');
        return;
      }
      setHandleInput('');
      setEventInput('');
      setEditingHandle(false);
    } finally {
      setHandleSaving(false);
    }
  };

  // Colours and indicator per step status. The status *word* is not here — it
  // lives in `setupStepLabel`, the one place that distinguishes a step that is
  // merely next from one that is running (#257).
  const checklistVisuals = {
    complete: {
      color: '#0f5132',
      background: '#f4fbf4',
      border: '#94d3ae',
      indicatorBg: '#0f5132',
      indicatorColor: '#fff',
      indicatorBorder: 'none',
      indicatorContent: '✓'
    },
    current: {
      color: '#0b5d95',
      background: '#e8f3ff',
      border: '#66afe9',
      indicatorBg: '#007cba',
      indicatorColor: '#fff',
      indicatorBorder: 'none',
      indicatorContent: '•'
    },
    failed: {
      color: '#8a1f21',
      background: '#fcf0f1',
      border: '#d63638',
      indicatorBg: '#d63638',
      indicatorColor: '#fff',
      indicatorBorder: 'none',
      indicatorContent: '✕'
    },
    pending: {
      color: '#6c6f72',
      background: '#f8f9f9',
      border: '#dcdcde',
      indicatorBg: '#6c6f72',
      indicatorColor: '#fff',
      indicatorBorder: 'none',
      indicatorContent: '•'
    },
    locked: {
      color: '#6c6f72',
      background: '#f5f5f7',
      border: '#dcdcde',
      indicatorBg: 'transparent',
      indicatorColor: '#6c6f72',
      indicatorBorder: '2px solid #c3c4c7',
      indicatorContent: '–'
    }
  };

  const setupFlags = {
    isPending,
    statusLoading,
    hasNodeModules,
    hasBuilt,
    installing,
    building,
    starting,
    installFailed,
    buildFailed,
    isUpdating
  };
  const stepState = computeSetupStepState(setupFlags);
  const { installLabel, installDescription, buildLabel, buildDescription } = setupStepCopy(setupFlags);

  const baseSteps = [
    {
      key: 'download',
      label: 'Download WordPress development version',
      description: isPending
        // The clone is also the trigger for everything after it (#246), so the
        // step says what happens next rather than implying a click is coming.
        ? 'Cloning the WordPress develop repository… install and build start on their own when it finishes.'
        : 'Clone the WordPress develop repository.',
      ...stepState.download,
      running: isPending
    },
    {
      key: 'install',
      label: 'Install npm dependencies',
      description: installDescription,
      ...stepState.install,
      running: installing,
      action: (
        <Button
          isBusy={installing}
          variant={stepState.install.done ? 'secondary' : 'primary'}
          onClick={runInstallWithTerminal}
          disabled={stepState.install.disabled}
        >{installLabel}</Button>
      )
    },
    {
      key: 'build',
      label: 'Run full build',
      description: buildDescription,
      ...stepState.build,
      running: building,
      action: (
        <Button
          isBusy={building}
          variant={hasBuilt ? 'secondary' : 'primary'}
          onClick={runBuildWithTerminal}
          disabled={stepState.build.disabled}
        >{buildLabel}</Button>
      )
    },
    {
      key: 'dev',
      label: 'Start dev server & finish wizard',
      description: 'Launch the development server once to complete the WordPress setup wizard.',
      ...stepState.dev,
      running: starting,
      action: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            isBusy={starting}
            variant={running ? 'secondary' : 'primary'}
            onClick={async () => {
              await markSkipWizard();
              await toggleDevServer();
            }}
            disabled={stepState.dev.disabled}
          >{running ? 'Stop dev server' : 'Start dev server and finish the wizard'}</Button>
          {starting || serverUrl ? (
            <span style={{ fontSize: 12 }}>
              {starting ? `Starting… (${formatElapsed(startElapsed)})` : null}
              {!starting && serverUrl ? (
                <>
                  <a href={serverUrl} onClick={(e) => { e.preventDefault(); window.api.openExternal(serverUrl); }}>{serverUrl}</a>
                  <span aria-hidden="true"> · </span>
                  <a href={adminUrl(serverUrl)} onClick={(e) => { e.preventDefault(); window.api.openExternal(adminUrl(serverUrl)); }}>wp-admin</a>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      )
    }
  ];

  const stepItems = setupStepStatuses(baseSteps);

  // The one block to point the contributor at next (#252). The checklist has
  // already worked out its own current step; the resolver folds that together
  // with the post-init state into a single id, which the render tags onto the
  // matching block (`data-next-action` + the `.next-action-cue` class) and the
  // cue hook scrolls into view.
  // A failed step counts as the one to point at: retrying it is exactly what
  // the contributor should do next, and it consumes no `current` of its own, so
  // without this a chain that stopped would leave the view with no cue at all.
  const currentSetupStep = stepItems.find((s) => s.status === 'current' || s.status === 'failed')?.key || null;
  const nextAction = deriveNextAction({
    skipInit,
    currentSetupStep,
    isApplying,
    applyPreview: Boolean(applyPreview),
    updateIncomplete,
    isUpdating,
    stale: age.stale,
    running,
    hasChanges: Boolean(worktreeDirty && worktreeDirty.dirty),
    ticketLinked: Boolean(tracTicket)
  });
  const nextActionId = nextAction ? nextAction.id : null;
  useNextActionCue(nextActionId, isActive, nextActionSectionRef);

  // Tags a block as a cue target: the `data-next-action` the hook scrolls to,
  // and the `.next-action-cue` class React draws the ring with when this block
  // is the one. Spread onto the block that carries the id's action.
  const cueProps = (id) => ({
    'data-next-action': id,
    className: nextActionId === id ? 'next-action-cue' : undefined
  });

  return (
    <section ref={nextActionSectionRef} className="wpct-site-page">
      {/* The glow on the next-action block is purely visual, invisible to a
          screen reader. This is its spoken equivalent: a polite live region that
          names the next step as the cue moves, so a non-sighted contributor gets
          the same hint. The region is always mounted and only its text toggles —
          a live region that appears already holding text is not reliably read,
          whereas a change to one already in the DOM is. Only the active row ever
          holds text, so only the visible site speaks; it clears to nothing when
          there is no next action. */}
      <div className="sr-only" role="status" aria-live="polite">
        {isActive && nextAction ? `Next step: ${nextAction.reason}` : ''}
      </div>
      <Section
        plain
        level={1}
        title={displayName}
        titleAdornment={
          <Button
            icon={edit}
            label="Rename site"
            aria-label="Rename site"
            onClick={openRenameModal}
            variant="tertiary"
            isSmall
          />
        }
        actions={
          <DropdownMenu
            label="More"
            text=""
            controls={[
              { title: 'Copy path', onClick: copyPath },
              // Opening the folder lives in the header's "Open directory in"
              // menu, next to the path it acts on. Repeating it here would be two
              // menus answering the same question a few pixels apart.
              { title: fileManagerLabel, onClick: showInFileManager },
              // Also reachable when the site is not yet stale (the staleness
              // notice is the primary entry point) — a fresh site just gets
              // "Already up to date." in the terminal.
              { title: 'Update to latest trunk', onClick: startTrunkUpdate },
              // Not while the clone is running: deleting the site would be
              // removing a directory the app is still writing into. The main
              // process refuses it either way (see site-registry.js) — that is
              // the backstop, and not offering a control that cannot work is
              // the actual answer.
              ...(isPending ? [] : [
                { title:'Delete this site', onClick:()=>confirmAnd('Delete this site from disk? This cannot be undone.', ()=>onDelete(sitePath)) }
              ])
            ]}
          />
        }
        meta={<>
          <MetaText>
            <StatusBadge status={initialized ? 'initialized' : 'uninitialized'} />
            {createdLabel ? <span>Created {createdLabel}</span> : null}
            {age.known ? (
              <span className="wpct-meta">
                {createdLabel ? <span aria-hidden="true">·</span> : null}
                {age.stale ? (
                  <span
                    aria-hidden="true"
                    title={`Trunk snapshot is ${age.ageDays} days old`}
                    className="wpct-stale-dot"
                  />
                ) : null}
                <span>{age.label}</span>
              </span>
            ) : null}
          </MetaText>
          {/* The path, the control that copies it and the control that opens it
              are one meta block rather than three stacked rows. They answer the
              same question — "where is this site?" — and separating them was
              what left "Open directory in" looking like it belonged to nothing.
              Detection runs when the menu is opened rather than on load: it is a
              filesystem sweep, and the answer is only needed once someone asks.
              It is re-read on every open, so an application installed while this
              app is running shows up the next time the menu is used. */}
          <MetaText>
            <code className="wpct-chip">{sitePath}</code>
            <Button
              icon={pathCopied ? checkIcon : copyIcon}
              label={pathCopied ? 'Copied!' : 'Copy path'}
              aria-label={pathCopied ? 'Copied!' : 'Copy path'}
              onClick={copyPath}
              variant="tertiary"
              isSmall
            />
            <Dropdown
              popoverProps={{ placement: 'bottom-start', offset: 4 }}
              renderToggle={({ isOpen, onToggle }) => (
                <Button
                  variant="link"
                  className="wpct-meta-link"
                  aria-expanded={isOpen}
                  aria-haspopup="menu"
                  onClick={() => {
                    if (!isOpen) void loadDetected();
                    onToggle();
                  }}
                >
                  Open directory in
                  <Icon icon={chevronDown} size={18} />
                </Button>
              )}
              renderContent={({ onClose }) => (
                <MenuGroup>
                  <MenuItem onClick={() => { onClose(); void showInFileManager(); }}>
                    {fileManagerName}
                  </MenuItem>
                  {detectedEditors.map((candidate) => (
                    <MenuItem key={candidate.path} onClick={() => { onClose(); void openIn(candidate.path); }}>
                      {candidate.name}
                    </MenuItem>
                  ))}
                  {/* A menu that is still counting is not an empty menu, and the
                      difference has to be visible: without this, a slow sweep
                      looks exactly like a machine with no editors on it. */}
                  {detectingEditors ? (
                    <MenuItem disabled>Looking for applications…</MenuItem>
                  ) : null}
                  {/* Always offered, never only as a fallback: detection is a
                      shortcut, and an application it misses is not one this app
                      refuses to use. */}
                  <MenuItem onClick={() => { onClose(); void openIn(null); }}>
                    Other application…
                  </MenuItem>
                </MenuGroup>
              )}
            />
          </MetaText>
          {/* With no modal in the way, this is the only place a failed open can
              speak — and it carries the way out with it, rather than leaving the
              contributor to find the menu again.

              Still styled by hand: every notice box in the window is converted
              together in Phase 4 of plans/ui-polish-pass.md, because introducing
              <Notice> for this one would leave two notice styles on screen until
              the rest caught up. */}
          {editorNotice ? (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 12px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 6, fontSize: 12, color: '#6e5406' }}>
              <span style={{ flex: '1 1 240px' }}>{editorNotice.message}</span>
              {editorNotice.offerPicker ? (
                <Button variant="tertiary" isSmall onClick={() => void openIn(null)}>Choose application…</Button>
              ) : null}
            </div>
          ) : null}
        </>}
      />
      {updateIncomplete && !isUpdating ? (
        <div {...cueProps('retry-install-build')} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', background: '#fcf0f1', border: '1px solid #d63638', borderRadius: 8, fontSize: 13, color: '#8a1f21' }}>
          <span style={{ flex: '1 1 320px' }}>
            <strong>Update incomplete</strong> — the code is new but the built assets are old. The site may not run correctly until install and build succeed.
          </span>
          <Button
            variant="secondary"
            isDestructive
            onClick={retryInstallAndBuild}
            disabled={installing || building}
          >Retry install &amp; build</Button>
        </div>
      ) : null}
      {age.stale && !updateIncomplete && !isUpdating ? (
        <div {...cueProps('update-trunk')} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '14px 16px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 8, fontSize: 13, color: '#6e5406' }}>
          <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong style={{ color: '#5c4400' }}>This site&apos;s WordPress code is {age.ageDays} days old</strong>
            <span>Patches you create now may not apply on Trac. Updating takes a few minutes.</span>
          </div>
          <Button
            variant="secondary"
            onClick={startTrunkUpdate}
            disabled={installing || building}
          >Update to latest trunk</Button>
        </div>
      ) : null}
      {isUpdating ? (
        <div {...cueProps('updating')} style={{ padding: '14px 16px', background: '#fff', border: '1px solid #dcdcde', borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: '#1d2327' }}>Updating to latest trunk</span>
            <span style={{ fontSize: 12, color: '#6c6f72' }}>
              step {Math.max(1, updateStepStates.filter((s) => s.status === 'complete' || s.status === 'skipped').length + 1)} of {updateSteps.length}
            </span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            {updateStepStates.map((s) => {
              const labels = UPDATE_STEP_LABELS[s.key] || {};
              const text = labels[s.status] || labels.pending || s.key;
              const { symbol = '', color = '#6c6f72' } = UPDATE_STEP_MARKS[s.status] || {};
              return (
                <div key={s.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, color, opacity: s.status === 'pending' || s.status === 'skipped' ? 0.75 : 1 }}>
                  <span aria-hidden="true" style={{ width: 12, display: 'inline-block', textAlign: 'center' }}>{symbol}</span>
                  <span style={{ fontWeight: s.status === 'current' ? 600 : 400 }}>{text}</span>
                </div>
              );
            })}
          </div>
          {updateState === 'installing' ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f0f0f1', fontSize: 12, color: '#6c6f72' }}>
              Most packages are already cached, so this is a download of the difference — not the whole tree.
            </div>
          ) : null}
        </div>
      ) : null}
      {lastUpdateSummary && !isUpdating && !updateIncomplete ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', background: '#f4fbf4', border: '1px solid #94d3ae', borderRadius: 8, fontSize: 13, color: '#0f5132' }}>
          <span aria-hidden="true" style={{ fontWeight: 700 }}>✓</span>
          <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong>Up to date with trunk as of today.</strong>
            <span>
              {lastUpdateSummary.lockfileChanged ? 'Dependencies updated' : 'Dependencies unchanged'}
              {typeof lastUpdateSummary.elapsedSeconds === 'number' ? `, rebuilt in ${formatElapsed(lastUpdateSummary.elapsedSeconds)}.` : ', rebuilt.'}
              {lastUpdateSummary.savedPatchPath ? ` Your changes were saved to ${lastUpdateSummary.savedPatchPath} before the reset.` : ''}
            </span>
          </div>
          <Button
            variant="tertiary"
            isSmall
            aria-label="Dismiss"
            onClick={() => setLastUpdateSummary(null)}
            style={{ color: '#0f5132' }}
          >✕</Button>
        </div>
      ) : null}
      {!skipInit ? (
        <div style={{ padding: 20, border: '1px solid #dcdcde', borderRadius: 12, background: '#fff' }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: '#1d2327' }}>Initial setup checklist</div>
          {/*
            Nobody pressed a button to start this, so the banner has to say what
            is happening, how far along it is and how to stop it — that is the
            whole licence for running unattended. The step counter comes from
            the same `updateStepStatuses` the update panel uses.
          */}
          {isSettingUp ? (
            <div role="status" style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '12px 16px', background: '#e8f3ff', border: '1px solid #66afe9', borderRadius: 8, fontSize: 13, color: '#0b5d95' }}>
              <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <strong style={{ color: '#0b5d95' }}>
                  Setting this site up for you — step {setupStepStates.filter((s) => s.status === 'complete').length + 1} of {setupSteps.length}
                </strong>
                <span>
                  {setupChainState === 'installing'
                    ? 'Installing dependencies. You can leave this running — the build follows on its own.'
                    : 'Running the full build. This can take up to half an hour on Windows; the Terminal below shows what it is doing.'}
                </span>
              </div>
              <Button variant="secondary" onClick={stopSetupChain}>Stop setup</Button>
            </div>
          ) : null}
          {!isSettingUp && setupChainEnd === 'stopped' ? (
            <div style={{ marginTop: 12, padding: '12px 16px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 8, fontSize: 13, color: '#6e5406' }}>
              <strong style={{ color: '#5c4400' }}>Setup stopped.</strong>{' '}
              Nothing was lost — pick it back up with the buttons below whenever you want.
            </div>
          ) : null}
          <div style={{ marginTop: 4, fontSize: 13, color: '#3c434a' }}>Complete each step to prepare this site for development.</div>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {stepItems.map((step) => {
              const visuals = checklistVisuals[step.status] || checklistVisuals.locked;
              const cueId = `setup-${step.key}`;
              return (
                <div
                  key={step.key}
                  data-next-action={cueId}
                  className={nextActionId === cueId ? 'next-action-cue' : undefined}
                  style={{
                    border: `1px solid ${visuals.border}`,
                    background: visuals.background,
                    borderRadius: 10,
                    padding: '14px 16px',
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr auto',
                    gridTemplateRows: 'auto auto',
                    columnGap: 16,
                    rowGap: 8,
                    alignItems: 'center'
                  }}
                >
                  <div style={{ gridRow: '1 / span 2', alignSelf: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28 }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        fontSize: 12,
                        fontWeight: 700,
                        lineHeight: 1,
                        background: visuals.indicatorBg,
                        color: visuals.indicatorColor,
                        border: visuals.indicatorBorder || 'none'
                      }}
                    >
                      {visuals.indicatorContent}
                    </span>
                  </div>
                  <div style={{ gridColumn: '2 / 3', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600, color: '#1d2327', lineHeight: 1.4 }}>{step.label}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: visuals.color, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{setupStepLabel(step.status, step.running)}</div>
                  </div>
                  <div style={{ gridColumn: '2 / 3', fontSize: 12, color: '#3c434a', lineHeight: 1.5 }}>{step.description}</div>
                  <div style={{ gridRow: '1 / span 2', gridColumn: '3 / 4', alignSelf: 'center', display: 'flex', alignItems: 'center' }}>
                    {step.action}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="link" onClick={markSkipWizard} style={{ textDecoration: 'underline' }}>Skip initialization wizard</Button>
          </div>
        </div>
      ) : (
        null
      )}
      {/* These two buttons were the clearest case of the complaint this pass
          answers: they sat in bare whitespace between the header and the Trac
          card, so they read as page furniture rather than as this site's own
          actions. The rule above them is what makes them belong to the site
          named directly overhead, and the status lines below them sit inside the
          same region as the button that produces them. */}
      {skipInit ? (
        <div className="wpct-site-actions">
          <ActionRow divided>
            <span {...cueProps('start-dev')} style={{ display: 'inline-flex' }}>
            <Button
              isBusy={isServerStarting}
              variant={isDevProcessActive ? 'secondary' : 'primary'}
              onClick={toggleDevServer}
              disabled={isUpdating}
              className="wpct-primary-action"
            >
              {isDevProcessActive ? (
                <span aria-hidden="true" className="wpct-running-dot" />
              ) : null}
              {devServerButtonLabel}
            </Button>
            </span>
            <Button
              variant="secondary"
              onClick={toggleWatch}
              disabled={isUpdating}
              title={watchActive ? 'The build watch compiles src/ edits automatically' : 'Compile src/ edits on save (runs independently of the dev server)'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', padding: '12px 16px', fontSize: 15, borderRadius: 12 }}
            >
              <span
                aria-hidden="true"
                style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: watchDotColor, flexShrink: 0 }}
              />
              <span style={{ fontWeight: 600 }}>{watchButtonLabel}</span>
            </Button>
            <span {...cueProps('review-changes')} style={{ display: 'inline-flex' }}>
            <Button
              variant="secondary"
              onClick={openPatchModal}
              disabled={isUpdating}
            >Review & submit changes</Button>
            </span>
          </ActionRow>
          {changesNote && changesNote.placement === 'buttons' ? (
            <div className="wpct-site-actions__status">
              {changesNoteBody}
            </div>
          ) : null}
          {(isServerStarting || serverUrl) ? (
            <div className="wpct-site-actions__status">
              {serverUrl ? (
                <>
                  <div className="wpct-action-row">
                    <a href={serverUrl} onClick={(e) => { e.preventDefault(); window.api.openExternal(serverUrl); }}>{serverUrl}</a>
                    <span aria-hidden="true" className="wpct-meta">·</span>
                    <a href={adminUrl(serverUrl)} onClick={(e) => { e.preventDefault(); window.api.openExternal(adminUrl(serverUrl)); }}>wp-admin</a>
                    {running ? (
                      <>
                        <span aria-hidden="true" style={{ color: '#8c8f94' }}>·</span>
                        <a href={adminerUrl(serverUrl)} onClick={(e) => { e.preventDefault(); window.api.openExternal(adminerUrl(serverUrl)); }}>DB inspect (Adminer)</a>
                      </>
                    ) : null}
                  </div>
                  <MetaText flow>Log in with <code>admin</code> / <code>password</code>.</MetaText>
                </>
              ) : (
                `Dev server is starting… (${formatElapsed(startElapsed)})`
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {skipInit ? (
      <div {...cueProps('link-ticket')} style={{ padding: 20, border: '1px solid #dcdcde', borderRadius: 12, background: '#fff' }}>
        <div style={{ fontWeight: 600, fontSize: 16, color: '#1d2327' }}>Trac ticket</div>
        {tracTicket ? (
          <>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {/* The ticket number is what the site is *for* once one is linked
                  — and under #108 it also names the branch you are on, so it
                  answers "which of my tickets am I looking at" at a glance.
                  Sized to read as the panel's subject rather than as a tag. */}
              <span style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 12px', borderRadius: 999, fontSize: 18, fontWeight: 600, letterSpacing: '0.01em', background: '#f0f0f1', color: '#1d2327' }}>
                #{tracTicket}
              </span>
              <Button variant="link" onClick={() => window.api.openExternal(ticketUrl(tracTicket))}>Open in Trac</Button>
              {!tracInfo ? (
                <Button variant="link" onClick={loadTracAttachments} disabled={tracAttachmentsLoading}>
                  {tracAttachmentsLoading ? 'Reading ticket…' : 'Read details from Trac'}
                </Button>
              ) : null}
              <Button variant="link" isDestructive onClick={unlinkTicket} disabled={ticketActionsBlocked}>Unlink</Button>
            </div>

            {staleTicketNotice ? (
              <div role="status" style={{ marginTop: 10, padding: '10px 12px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 6, color: '#6e5406', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{staleTicketNotice.title}</div>
                <div style={{ marginTop: 4 }}>{staleTicketNotice.body}</div>
              </div>
            ) : null}

            {tracInfo ? (
              <div style={{ marginTop: 10 }}>
                {tracInfo.summary ? (
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1d2327' }}>{tracInfo.summary}</div>
                ) : null}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap', fontSize: 12, color: '#3c434a' }}>
                  {tracInfoBadge ? (
                    <span style={{ padding: '1px 8px', borderRadius: 999, fontWeight: 600, fontSize: 11,
                      background: tracInfoBadge.tone === 'closed' ? '#fcf0f1' : '#edfaef',
                      color: tracInfoBadge.tone === 'closed' ? '#8a1f21' : '#005c12' }}>
                      {tracInfoBadge.label}
                    </span>
                  ) : null}
                  {tracInfo.type ? (
                    <span style={{ padding: '1px 8px', borderRadius: 999, fontSize: 11, background: '#f0f0f1', color: '#3c434a' }}>{tracInfo.type}</span>
                  ) : null}
                  {tracInfo.opened ? (
                    <span title={tracInfo.opened.absolute}>opened {tracInfo.opened.relative}</span>
                  ) : null}
                  {tracInfo.milestone ? <span>milestone: {tracInfo.milestone}</span> : null}
                </div>
                {tracInfo.component || tracInfo.keywords.length ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap', fontSize: 12, color: '#6c6f72' }}>
                    {tracInfo.component ? (
                      <span>
                        component:{' '}
                        {tracInfo.component.url ? (
                          <Button variant="link" style={{ fontSize: 12 }} onClick={() => window.api.openExternal(tracInfo.component.url)}>
                            {tracInfo.component.label}
                          </Button>
                        ) : tracInfo.component.label}
                      </span>
                    ) : null}
                    {tracInfo.keywords.length ? (
                      <span>
                        keywords:{' '}
                        {tracInfo.keywords.map((kw, i) => (
                          <span key={kw.label}>
                            {i ? ' ' : ''}
                            {kw.url ? (
                              <Button variant="link" style={{ fontSize: 12 }} onClick={() => window.api.openExternal(kw.url)}>{kw.label}</Button>
                            ) : kw.label}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {changesNote && changesNote.placement === 'ticket' ? (
              <div style={{ marginTop: 8, fontSize: 13, color: '#1d2327' }}>
                {changesNoteBody}
                <div style={{ marginTop: 4, fontSize: 12, color: '#6c6f72' }}>{changesNote.unlinkNote}</div>
              </div>
            ) : null}

            <div ref={ticketPatchesRef} style={{ marginTop: 16, borderTop: '1px solid #f0f0f1', paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#1d2327' }}>Linked pull requests</div>
                <Button variant="link" onClick={loadTicketPatches} disabled={ticketPatchesLoading} style={{ fontSize: 12 }}>
                  {ticketPatchesLoading ? 'Checking…' : 'Refresh'}
                </Button>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: '#6c6f72' }}>
                See the work that already exists on this ticket before adding your own.
              </div>

              {ticketPatchesLoading && !ticketPatches ? (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, color: '#3c434a', fontSize: 13 }}><Spinner /> Checking GitHub…</div>
              ) : null}

              {ticketPatches && ticketPatches.status === 'ok' && ticketPatches.items.length === 0 ? (
                <div style={{ marginTop: 10, fontSize: 13, color: '#6c6f72' }}>No pull requests cite this ticket yet.</div>
              ) : null}

              {ticketPatches && ticketPatches.status !== 'ok' && ticketPatches.status !== 'no-ticket' ? (
                <div style={{ marginTop: 10, padding: '8px 10px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 6, fontSize: 12, color: '#6e5406' }}>
                  {TICKET_PATCH_STATUS_MESSAGE[ticketPatches.status] || TICKET_PATCH_STATUS_MESSAGE.error}
                  {ticketPatches.items && ticketPatches.items.length && ticketPatches.cachedAt
                    ? ` Showing what was last seen ${new Date(ticketPatches.cachedAt).toLocaleString()}.`
                    : ' No cached list to fall back on.'}
                </div>
              ) : null}

              {ticketPatches && ticketPatches.items && ticketPatches.items.length ? (
                <div style={{ marginTop: 10, border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden' }}>
                  {ticketPatches.items.map((pr) => (
                    <div key={pr.number} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid #f0f0f1' }}>
                      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                          <span style={{ flex: '0 1 auto', minWidth: 0, fontSize: 13, color: '#1d2327', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <Button variant="link" onClick={() => window.api.openExternal(pr.url)} style={{ fontSize: 13 }}>#{pr.number}</Button>
                            {' '}{pr.title}
                          </span>
                          {latestPill(latestPatch?.kind === 'pr' && latestPatch.key === pr.number)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 11, color: '#6c6f72' }}>
                          {prStatePill(pr.state)}
                          {(() => {
                            const dated = prDateLabel(pr);
                            return dated ? <span>{dated.prefix} {new Date(dated.when).toLocaleDateString()}</span> : null;
                          })()}
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        isBusy={fetchingPr === pr.number}
                        disabled={isApplying || isUpdating || installing || building || Boolean(applyPreview) || fetchingPr !== null}
                        onClick={() => previewPr(pr)}
                        style={{ flex: '0 0 auto' }}
                      >Apply…</Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {latestIsAttachment ? (
              <div style={{ marginTop: 12, padding: '8px 10px', background: '#e7f1ff', border: '1px solid #9ec5f0', borderRadius: 6, fontSize: 12, color: '#0b5d95' }}>
                The most recent patch on this ticket is a file attachment, not a pull request — see Trac attachments below.
              </div>
            ) : null}

            <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f1', paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#1d2327' }}>Trac attachments</div>
                {tracAttachments ? (
                  <Button variant="link" onClick={loadTracAttachments} disabled={tracAttachmentsLoading} style={{ fontSize: 12 }}>
                    {tracAttachmentsLoading ? 'Checking…' : 'Refresh'}
                  </Button>
                ) : null}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: '#6c6f72' }}>
                Patch files are sometimes attached on Trac instead of a PR. Reading them opens the ticket so you can pass its human-check once.
              </div>

              {!tracAttachments && !tracAttachmentsLoading ? (
                <div style={{ marginTop: 10 }}>
                  <Button variant="secondary" onClick={loadTracAttachments} disabled={isApplying || isUpdating || installing || building} style={{ padding: '8px 14px', borderRadius: 10 }}>
                    Show Trac attachments
                  </Button>
                </div>
              ) : null}

              {tracAttachmentsLoading ? (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, color: '#3c434a', fontSize: 13 }}><Spinner /> Opening the ticket on Trac…</div>
              ) : null}

              {tracAttachmentsRead && patchAttachments.length === 0 ? (
                <div style={{ marginTop: 10, fontSize: 13, color: '#6c6f72' }}>No patch files attached to this ticket.</div>
              ) : null}

              {tracAttachments && (tracAttachments.status === 'challenge-timeout' || tracAttachments.status === 'error' || tracAttachments.status === 'closed') ? (
                <div style={{ marginTop: 10, padding: '8px 10px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 6, fontSize: 12, color: '#6e5406' }}>
                  {(() => {
                    if (tracAttachments.status === 'challenge-timeout') return 'Trac’s human-check did not complete in time. Try again, and click “I am human” if it appears.';
                    if (tracAttachments.status === 'closed') return 'The Trac window was closed before the attachments finished loading. Click “Show Trac attachments” to try again.';
                    return `Could not read the attachments from Trac.${tracAttachments.error ? ` (${tracAttachments.error})` : ''}`;
                  })()}
                </div>
              ) : null}

              {patchAttachments.length ? (
                <div style={{ marginTop: 10, border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden' }}>
                  {patchAttachments.map((att) => (
                    <div key={att.url} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid #f0f0f1' }}>
                      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                          <span style={{ flex: '0 1 auto', minWidth: 0, fontSize: 13, color: '#1d2327', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <Button variant="link" onClick={() => window.api.openExternal(att.url)} style={{ fontSize: 13 }}>{att.filename}</Button>
                          </span>
                          {latestPill(latestPatch?.kind === 'attachment' && latestPatch.key === att.url)}
                        </div>
                        <div style={{ fontSize: 11, color: '#6c6f72' }}>
                          {[att.author && `by ${att.author}`, att.dateText, att.sizeText].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        isBusy={fetchingAttachment === att.url}
                        disabled={isApplying || isUpdating || installing || building || Boolean(applyPreview) || fetchingAttachment !== null}
                        onClick={() => previewAttachment(att)}
                        style={{ flex: '0 0 auto' }}
                      >Apply…</Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 4, fontSize: 13, color: '#3c434a' }}>
              Tell the app which ticket you are working on. It is stored with the site, so it survives restarts, and you can change or remove it at any time.
            </div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 260 }}>
                <TextControl
                  value={ticketInput}
                  onChange={(value) => { setTicketInput(value); setTicketError(''); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); linkTicket(); } }}
                  disabled={ticketActionsBlocked}
                  placeholder="Ticket number or URL, e.g. 62281"
                  aria-label="Trac ticket number or URL"
                />
              </div>
              <Button
                variant="secondary"
                onClick={linkTicket}
                isBusy={ticketSaving}
                disabled={ticketActionsBlocked || !ticketInput.trim()}
                style={{ padding: '10px 16px', borderRadius: 10 }}
              >Link ticket</Button>
            </div>
            {/* Expectation-setting, not the warning itself: since #234 the
                app asks before moving or discarding anything, so this only
                has to be true, not load-bearing. Said without asking the
                worktree, so it costs nothing. */}
            <div style={{ marginTop: 6, fontSize: 12, color: '#6c6f72' }}>
              If you have edited anything already, you will be asked what should happen to those edits.
            </div>
          </>
        )}
        {ticketError ? (
          <div role="alert" style={{ marginTop: 8, color: '#d63638', fontSize: 12 }}>{ticketError}</div>
        ) : null}
        {switchProgressLine}
        {carriedNotice}
        {savedCleanNotice}
        {blockedPanel}
        {tracTicket ? null : (
          <div style={{ marginTop: 8 }}>
            <Button variant="link" onClick={() => window.api.openExternal(TRAC_TICKET_LISTS_URL)} style={{ fontSize: 12 }}>
              Not sure yet? Browse good first bugs on Trac
            </Button>
          </div>
        )}
      </div>
      ) : null}
      {skipInit && ticketsCard ? (
        <div style={{ padding: 20, border: '1px solid #dcdcde', borderRadius: 12, background: '#fff' }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: '#1d2327' }}>{ticketsCard.heading}</div>
          {renderBranchRows(Boolean(tracTicket))}
        </div>
      ) : null}
      {skipInit ? (
        <div style={{ padding: 20, border: '1px solid #dcdcde', borderRadius: 12, background: '#fff' }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: '#1d2327' }}>Apply a patch or PR</div>
          {!applyPreview && !isApplying ? (
            <div style={{ marginTop: 4, fontSize: 13, color: '#3c434a' }}>
              Apply a pull request or a <code>.diff</code>/<code>.patch</code> file to this checkout and rebuild, so you can test the work before adding your own. Your own changes are left alone.
            </div>
          ) : null}

          {appliedLayer && !isApplying ? (
            <div style={{ marginTop: 12, padding: '14px 16px', border: `1px solid ${appliedLayer.canRevert ? '#94d3ae' : '#dba617'}`, background: appliedLayer.canRevert ? '#f4fbf4' : '#fcf9e8', borderRadius: 8 }}>
              <div style={{ fontSize: 13, color: appliedLayer.canRevert ? '#0f5132' : '#6e5406' }}>
                <strong>{appliedLayer.label}</strong> {appliedLayer.summary}
              </div>
              {appliedLayer.explanation ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6e5406' }}>{appliedLayer.explanation}</div>
              ) : null}
              {appliedLayer.detail.map((line) => (
                <div key={line} style={{ marginTop: 4, fontSize: 12, color: '#6e5406', wordBreak: 'break-all' }}>{line}</div>
              ))}
              {appliedLayer.note ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6c6f72' }}>{appliedLayer.note}</div>
              ) : null}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {appliedLayer.canRevert ? (
                  <Button variant="secondary" onClick={() => runApply({ reverse: true })} disabled={isUpdating || installing || building}>Revert this patch</Button>
                ) : null}
                {appliedLayer.offerCopy ? (
                  <>
                    <Button variant="secondary" onClick={savePatch} disabled={layerExitBlocked}>Save a copy of your work</Button>
                    <Button variant="tertiary" onClick={discardAllChanges} disabled={layerExitBlocked}>Discard this ticket to its base</Button>
                  </>
                ) : null}
              </div>
              {/* Both exits report failure through state the changes note and the
                  patch modal own, and neither is on screen here — so a save that
                  could not write, or a discard that refused, would be a button
                  that did nothing on the one way out this banner recommends. */}
              {layerExit.message ? (
                <div role="alert" style={{ marginTop: 8, fontSize: 12, color: '#d63638' }}>{layerExit.message}</div>
              ) : null}
            </div>
          ) : null}

          {applyPreview && !isApplying ? (
            <div {...cueProps('apply-preview')} style={{ marginTop: 12, padding: '14px 16px', border: '1px solid #dcdcde', borderRadius: 8 }}>
              <div style={{ fontSize: 13, color: '#1d2327' }}>
                <strong>{applyPreview.label}</strong> changes {applyPreview.paths.length} file{applyPreview.paths.length === 1 ? '' : 's'}:
              </div>
              <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 12, color: '#3c434a', lineHeight: 1.7, overflowWrap: 'anywhere', maxHeight: 140, overflowY: 'auto' }}>
                {applyPreview.paths.map((p) => <div key={p}>{p}</div>)}
              </div>
              {/* Who the colliding work belongs to (#306) is the sentence. */}
              {previewAttribution.sentences.length ? (
                <div role="alert" style={{ marginTop: 10, padding: '8px 10px', background: '#fcf9e8', border: '1px solid #dba617', borderRadius: 6, fontSize: 12, color: '#6e5406' }}>
                  {previewAttribution.sentences.map((sentence) => <div key={sentence} style={{ marginTop: 2 }}>{sentence}</div>)}
                </div>
              ) : null}
              {applyPreview.unsupported.length ? (
                <div style={{ marginTop: 10, fontSize: 12, color: '#6e5406' }}>
                  {applyPreview.unsupported.join(', ')} {applyPreview.unsupported.length === 1 ? 'is a binary file and will be skipped' : 'are binary files and will be skipped'}.
                </div>
              ) : null}
              {applyPreview.needsInstall ? (
                <div style={{ marginTop: 10, fontSize: 12, color: '#3c434a' }}>It changes <code>package-lock.json</code>, so dependencies will be installed before the rebuild.</div>
              ) : null}
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <Button variant="primary" onClick={() => runApply()} disabled={isUpdating || installing || building}>Apply and rebuild</Button>
                <Button variant="tertiary" onClick={() => { setApplyPreview(null); clearApplyError(); setApplyNotice(''); }}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {isApplying ? (
            <div {...cueProps('applying-patch')} style={{ marginTop: 12, padding: '14px 16px', border: '1px solid #dcdcde', borderRadius: 8 }}>
              {applyStepStates.map((state, i) => {
                const step = applySteps[i];
                const mark = UPDATE_STEP_MARKS[state.status];
                const stepLabel = state.status === 'skipped' ? step.skipMessage : step.label;
                return (
                  <div key={step.key} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '2px 0', color: mark ? mark.color : '#6c6f72', fontWeight: state.status === 'current' ? 600 : 400, opacity: state.status === 'pending' || state.status === 'skipped' ? 0.75 : 1 }}>
                    <span aria-hidden="true" style={{ width: 12 }}>{mark ? mark.symbol : ''}</span>
                    <span>{stepLabel}</span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {applyError ? (
            <div role="alert" style={{ marginTop: 12, padding: '8px 10px', background: '#fcf0f1', border: '1px solid #d63638', borderRadius: 6, fontSize: 12, color: '#8a1f21' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                {/* The headline replaces the sentence when there is one: it says
                    the same thing in counts, which is the part that decides
                    whether the patch is worth rescuing. Without a breakdown the
                    original sentence is still the whole story. */}
                <span style={{ flex: '1 1 auto' }}>
                  {applyConflict?.headline || (/[.!?]$/.test(applyError.trim()) ? applyError : `${applyError.trim()}.`)} The checkout was not changed.
                </span>
                <Button
                  variant="tertiary"
                  isSmall
                  aria-label="Dismiss"
                  onClick={() => clearApplyError()}
                  style={{ color: '#8a1f21' }}
                >✕</Button>
              </div>

              {applyConflict ? (
                <div style={{ marginTop: 8 }}>
                  {applyConflict.items.map((item, i) => (
                    <div key={i} style={{ marginTop: i ? 8 : 0 }}>
                      {item.kind === 'note' ? (
                        <div>{item.text}</div>
                      ) : (
                        <>
                          <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>
                            {item.path} — {item.failed} of {item.total} {item.total === 1 ? 'change' : 'changes'}
                          </div>
                          {item.regions.map((region) => (
                            // index, not line: a concatenated patch can carry
                            // two hunks whose oldStart coincides.
                            <div key={region.index} style={{ marginTop: 4, paddingLeft: 10, borderLeft: '2px solid #d63638' }}>
                              {/* A searchable line, not a line number: the patch's
                                  numbers are coordinates in the file as its author
                                  had it, and on an old patch they miss by dozens.
                                  Text survives the drift — copy it into the
                                  editor's search and land on the region. */}
                              <div>
                                {region.anchor
                                  ? <>near <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{region.anchor}</code></>
                                  : `line ${region.line} of the patch`} · {region.reason}
                              </div>
                              {/* The lines themselves, because a location alone
                                  cannot answer the question that decides the
                                  next ten minutes: is this the change that
                                  matters, or reformatting that came with it. */}
                              {region.lines.length ? (
                                <pre style={{ margin: '2px 0 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                  {region.lines.join('\n')}{region.more ? `\n… ${region.more} more ${region.more === 1 ? 'line' : 'lines'}` : ''}
                                </pre>
                              ) : null}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  ))}

                  {applyConflict.advice ? (
                    <div style={{ marginTop: 8 }}>{applyConflict.advice}</div>
                  ) : null}

                  {applyConflict.offerOtherPatches || applyConflict.prUrl || applyConflict.offerDiscardToBase ? (
                    <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {applyConflict.offerDiscardToBase ? (
                        <>
                          <Button variant="secondary" isSmall onClick={savePatch} disabled={layerExitBlocked}>Save a copy of your work</Button>
                          <Button variant="secondary" isSmall onClick={discardAllChanges} disabled={layerExitBlocked}>Discard this ticket to its base</Button>
                        </>
                      ) : null}
                      {applyConflict.offerOtherPatches ? (
                        <Button
                          variant="secondary"
                          isSmall
                          onClick={() => {
                            // Choosing another patch is walking away from this
                            // one, so everything about it goes: the preview
                            // (whose presence keeps the lists' Apply buttons
                            // disabled) and the failure banner itself — an
                            // error describing an abandoned attempt would sit
                            // above the new one as noise.
                            setApplyPreview(null);
                            clearApplyError();
                            ticketPatchesRef.current?.scrollIntoView({
                              block: 'center',
                              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
                            });
                          }}
                        >Try another patch on this ticket</Button>
                      ) : null}
                      {applyConflict.prUrl && applyConflict.prButton ? (
                        <Button variant="secondary" isSmall onClick={() => window.api.openExternal(applyConflict.prUrl)}>
                          {applyConflict.prButton}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  {applyConflict.offerDiscardToBase && layerExit.message ? (
                    <div style={{ marginTop: 8 }}>{layerExit.message}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {applyNotice ? (
            // Dismissible, like the update summary above: the notice reports
            // something already resolved, so it outlives its usefulness the
            // moment it has been read, and nothing else in this panel takes it
            // down until the next patch.
            <div role="status" style={{ marginTop: 12, padding: '8px 10px', background: '#f0f6fc', border: '1px solid #3582c4', borderRadius: 6, fontSize: 12, color: '#1d3a5f', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ flex: '1 1 auto' }}>{applyNotice}</span>
              <Button
                variant="tertiary"
                isSmall
                aria-label="Dismiss"
                onClick={() => setApplyNotice('')}
                style={{ color: '#1d3a5f' }}
              >✕</Button>
            </div>
          ) : null}

          {!applyPreview && !isApplying ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 280, flex: '1 1 280px' }}>
                  <TextControl
                    value={prUrlInput}
                    onChange={(value) => { setPrUrlInput(value); clearApplyError(); setApplyNotice(''); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); previewPrFromInput(); } }}
                    disabled={isUpdating || installing || building}
                    placeholder="Paste a pull request URL or number"
                    aria-label="Pull request URL or number"
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={previewPrFromInput}
                  disabled={isUpdating || installing || building || !prUrlInput.trim()}
                  style={{ padding: '10px 16px', borderRadius: 10 }}
                >Apply PR</Button>
              </div>
              <div style={{ marginTop: 10 }}>
                <Button variant="link" onClick={choosePatchFile} disabled={isUpdating || installing || building} style={{ fontSize: 13 }}>
                  or choose a .diff / .patch file…
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Terminal</div>
          <div
            ref={terminalContainerRef}
            style={{
              height: 220,
              background: '#111',
              borderRadius: 6,
              overflow: 'hidden',
              border: '1px solid #1b1b1f'
            }}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: '#3c434a' }}>
            {showTerminalHints ? (
              <>
                <div>Edited files in <code>src/</code>? Run <TerminalCommandLink command="npm run build" onPrefill={prefillTerminalCommand} disabled={terminalBusy} /> so the site picks them up.</div>
                <div style={{ marginTop: 2, marginBottom: 6 }}>Added a dependency to <code>package.json</code>? Run <TerminalCommandLink command="npm install" onPrefill={prefillTerminalCommand} disabled={terminalBusy} />.</div>
              </>
            ) : null}
            <div>
              Type <code>help</code> to list supported commands. Press <code>Ctrl+C</code> to stop the current command.
            </div>
          </div>
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Logs</div>
          <TabPanel className="log-tabs" activeClass="is-active" onSelect={selectLogTab} tabs={logTabs}>
            {(tab) => {
              if (tab.name === 'runtime') {
                return <div ref={runtimeRef} onScroll={makeOnScroll('runtime')} style={LOG_PANE_STYLE}><LogText text={runtimeLogs} /></div>;
              }
              if (tab.name === 'watch') {
                return (
                  <div ref={watchRef} onScroll={makeOnScroll('watch')} style={LOG_PANE_STYLE}>
                    {watchLogs ? <LogText text={watchLogs} /> : (
                      <span style={{ color:'#888', fontFamily:'-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' }}>The build watch compiles <code>src/</code> edits into <code>build/</code>. It runs independently of the dev server — its output, and whether it is watching, paused, or stopped, appears here.</span>
                    )}
                  </div>
                );
              }
              return (
                <>
                <div ref={debugRef} onScroll={makeOnScroll('debug')} style={LOG_PANE_STYLE}>
                  {debugLogs ? <LogText text={debugLogs} /> : (
                    // An empty pane reads as broken, which is what this one was
                    // for as long as WP_DEBUG_LOG was never set. Say what fills
                    // it instead. In the app's own font, not the terminal's:
                    // this is interface copy rather than log output, and it is
                    // what keeps the `<code>` bits in it distinguishable.
                    <span style={{ color:'#888', fontFamily:'-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' }}>No PHP notices or errors yet. Anything WordPress or your code writes — <code>error_log()</code>, notices, deprecations, fatals — appears here while the dev server runs.</span>
                  )}
                </div>
                <div style={{ display:'flex', gap:8, marginTop:8, alignItems:'center', justifyContent:'space-between', flexWrap:'wrap' }}>
                  {/* The file is under build/, while the file being edited when
                      it filled up is under src/ — so it cannot be guessed, and
                      it is what someone needs to tail it in a terminal or attach
                      it to a ticket. Selectable rather than truncated with an
                      ellipsis: a path you cannot copy is decoration. */}
                  <code style={{ fontSize:11, color:'#666', userSelect:'text', wordBreak:'break-all', flex:'1 1 240px' }}>{debugLogPath || 'The log file appears once the dev server has run.'}</code>
                  <div style={{ display:'flex', gap:8 }}>
                    <Button size="small" variant="secondary" onClick={revealDebugLog} disabled={!debugLogPath}>Show in folder</Button>
                    <Button size="small" variant="secondary" onClick={copyDebugLog} disabled={!debugLogs}>{COPY_BUTTON_LABELS[debugCopied] || COPY_BUTTON_LABELS.idle}</Button>
                    <Button size="small" variant="secondary" onClick={clearDebugLog} disabled={!debugLogs}>Clear</Button>
                  </div>
                </div>
                </>
              );
            }}
          </TabPanel>
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Mail</div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ fontSize:12, color:'#666' }}>{smtpPort ? `SMTP listening on 127.0.0.1:${smtpPort}` : 'SMTP will start with the dev server.'}</div>
            <div><Button size="small" variant="secondary" onClick={clearEmails}>Clear emails</Button></div>
          </div>
          <div style={{ border:'1px solid #ddd', borderRadius:6, maxHeight:220, overflow:'auto' }}>
            {emails && emails.length ? emails.map((m)=>{
              const when = m.sentAt || m.date; const whenStr = when ? new Date(when).toLocaleString() : '';
              return (
                <div key={m.id}
                  role="button"
                  tabIndex={0}
                  onClick={()=>openEmail(m)}
                  onKeyDown={(e)=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEmail(m); } }}
                  style={{ padding:'8px 10px', cursor:'pointer', borderBottom:'1px solid #eee', display:'flex', gap:8 }}
                >
                  <div style={{ flex:'0 0 180px', color:'#555', fontSize:12 }}>{whenStr}</div>
                  <div style={{ flex:'0 0 220px', color:'#333', fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.from || ''}</div>
                  <div style={{ flex:'1 1 auto', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.subject || '(no subject)'}</div>
                </div>
              );
            }) : (
              <div style={{ padding:12, color:'#666' }}>No emails yet.</div>
            )}
          </div>
        </div>
      </div>
      {dirtyModalOpen ? (
        <Modal
          title="Update to latest trunk?"
          onRequestClose={() => { if (!dirtySaving) setDirtyModalOpen(false); }}
          shouldCloseOnClickOutside={!dirtySaving}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              You&apos;ve changed {dirtyFiles.length === 1 ? '1 file' : `${dirtyFiles.length} files`} in this site. Resetting to trunk would throw them away.
            </p>
            {dirtyFiles.length ? (
              <div style={{ border: '1px solid #dcdcde', borderRadius: 6, padding: '10px 12px', maxHeight: 140, overflowY: 'auto' }}>
                {dirtyFiles.map((f) => (
                  <div key={f} style={{ fontFamily: 'monospace', fontSize: 12, color: '#3c434a', lineHeight: 1.7, overflowWrap: 'anywhere' }}>{f}</div>
                ))}
              </div>
            ) : null}
            {[
              { key: 'save', label: 'Save them as a patch first (as a local file)', detail: 'a .diff on your machine — nothing is sent to Trac' },
              { key: 'discard', label: 'Discard them', detail: 'your changes are lost; this cannot be undone', destructive: true }
            ].map((opt) => {
              const selected = dirtyChoice === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setDirtyChoice(opt.key)}
                  disabled={dirtySaving}
                  aria-pressed={selected}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 13,
                    padding: '10px 12px',
                    borderRadius: 6,
                    border: selected ? '2px solid #3858e9' : '1px solid #dcdcde',
                    background: selected ? '#f0f3ff' : '#fff',
                    color: opt.destructive ? '#b32d2e' : '#1d2327'
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{opt.label}</span>
                  <span style={{ color: opt.destructive ? '#b32d2e' : '#6c6f72' }}> — {opt.detail}</span>
                </button>
              );
            })}
            {dirtyError ? (
              <div role="alert" style={{ padding: '10px 12px', background: '#fcf0f1', border: '1px solid #d63638', borderRadius: 6, fontSize: 13, lineHeight: 1.5, color: '#8a2424', overflowWrap: 'anywhere' }}>
                {dirtyError}
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => setDirtyModalOpen(false)} disabled={dirtySaving}>Cancel</Button>
              <Button
                variant="primary"
                isDestructive={dirtyChoice === 'discard'}
                isBusy={dirtySaving}
                disabled={dirtySaving}
                onClick={() => (dirtyChoice === 'discard' ? dirtyDiscardAndUpdate() : dirtySaveAndUpdate())}
              >{dirtyChoice === 'discard' ? 'Discard & update' : 'Save patch & update'}</Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {renameModalOpen ? (
        <Modal
          title="Rename site"
          onRequestClose={closeRenameModal}
          shouldCloseOnClickOutside={!renaming}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-close/Enter-to-submit on the modal form is standard, intentional behavior. */}
          <form
            onSubmit={handleRenameSubmit}
            onKeyDown={handleRenameFormKeyDown}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <TextControl
              id={RENAME_INPUT_ID}
              label="Site name"
              value={renameValue}
              onChange={(value) => setRenameValue(value)}
              disabled={renaming}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: this is the only field of a just-opened modal.
              autoFocus
            />
            {renameError ? <div style={{ color: '#d63638', fontSize: 12 }}>{renameError}</div> : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button type="button" variant="secondary" onClick={closeRenameModal} disabled={renaming}>Cancel</Button>
              <Button type="submit" variant="primary" isBusy={renaming} disabled={renaming}>Save</Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {isPatchOpen && (
        <Modal
          title="Review & submit changes"
          onRequestClose={()=>setIsPatchOpen(false)}
          shouldCloseOnClickOutside
          isFullScreen
          headerClassName="patch-modal-header"
        >
          <div style={{ display:'flex', flexDirection:'column', height:'80vh', gap:12 }}>
            {!patchLoading && age.stale && (
              <div style={{ padding:'12px 16px', background:'#fcf9e8', border:'1px solid #dba617', borderRadius:6, fontSize:13, lineHeight:1.5, color:'#6e5406' }}>
                This site&apos;s WordPress code is {age.ageDays} days old — this patch may not apply on Trac. Consider updating to the latest trunk first.
              </div>
            )}
            {!patchLoading && !patchHasChanges && (
              <div style={{ padding:'12px 16px', background:'#f0f6fc', border:'1px solid #d0d7de', borderRadius:6, fontSize:14, lineHeight:1.5, color:'#24292f' }}>
                There is nothing to send yet — this site has no changes against its copy of trunk.
              </div>
            )}
{/*
              Diff on the left, destinations on the right (#186).

              The patch used to sit under the destinations, which put the
              choice above the thing being chosen for: a contributor scrolled
              past three cards to read their own code, then scrolled back. The
              code is what they came to look at and the largest thing on the
              screen, so it takes the room, and where it can go stands beside
              it — visible the whole time they are reading, rather than
              something to scroll back to.

              This is the shape of an earlier take on the same screen (#6),
              revived here on top of the destinations this app has now.
            */}
            <div className="patch-columns">

              {/*
                The column widths, the stacking breakpoint and what scrolls in
                each case are in index.html — a media query can express them and
                an inline style cannot. `min-width: 0` there is load-bearing on
                a flex child holding a <pre>: without it the diff's longest line
                sets the column's floor and pushes the destinations off the
                modal instead of scrolling.
              */}
              <div className="patch-diff">
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:14, color:'#1d2327', display:'flex', alignItems:'baseline', gap:4, flexWrap:'wrap' }}>
                      {tracTicket ? `Your changes for ticket #${tracTicket}` : 'Your changes'}
                      <span style={{ fontWeight:400 }}>
                        {'('}
                        <DiscardChangesLink
                          label="Discard all changes"
                          onClick={discardAllChanges}
                          reason={modalDiscardReason}
                          style={{ fontSize: 12 }}
                        />
                        {')'}
                      </span>
                    </div>
                    <div style={{ fontSize:12, color:'#6c6f72' }}>Everything this site has that its copy of trunk does not.</div>
                    {discardError ? <div style={{ color:'#d63638', fontSize:12, marginTop:4 }}>{discardError}</div> : null}
                  </div>
                  {/*
                    Out of the diff and into the header: these used to float
                    over the top-right of the code, which was survivable at
                    full width and covers the first line of a hunk once the
                    pane is a column.
                  */}
                  <div style={{ display:'flex', gap:8 }}>
                    <Button variant="secondary" icon={download} onClick={savePatch} disabled={patchLoading}>Save</Button>
                    <Button
                      variant="secondary"
                      icon={patchCopied === 'copied' ? checkIcon : copyIcon}
                      onClick={copyPatch}
                      disabled={patchLoading}
                      // The label carries the outcome rather than a tooltip or
                      // a toast: it is the thing that was just pressed, so it
                      // is where the eye already is, and a screen reader
                      // announces the change on the focused control.
                    >{COPY_BUTTON_LABELS[patchCopied] || COPY_BUTTON_LABELS.idle}</Button>
                  </div>
                </div>
                {/*
                  Under the diff rather than beside the destinations that
                  trigger it: this is the outcome for the file, the file is
                  what this column is, and the header's own Save button needs
                  somewhere to report even when there are no destinations to
                  show.
                */}
                {patchSaved ? (
                  <div style={{ fontSize:13, color:'#0f5132' }}>Saved to {patchSaved}</div>
                ) : null}
                {patchSaveError ? (
                  <div role="alert" style={{ fontSize:13, color:'#d63638' }}>Could not save the patch: {patchSaveError}</div>
                ) : null}
                <div style={{ position:'relative', flex:1, minHeight:0 }}>
              {patchLoading ? (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:16 }}>
                  <Spinner />
                  <div style={{ color:'#666', fontSize:14 }}>Generating patch...</div>
                </div>
              ) : (
                <>
                  {/*
                      `boxSizing: border-box` with `height: 100%` and a
                      padding: without it the pane is its container plus
                      24px of padding, and it overflows by exactly that.
                      Invisible while the diff spanned the modal and the
                      overflow fell off the bottom; beside a sidebar it
                      sits on top of the destinations.
                    */}
                    <pre style={{ margin:0, whiteSpace:'pre-wrap', background:'#111', color:'#eee', padding:12, borderRadius:6, height:'100%', boxSizing:'border-box', overflowY:'auto' }}>
                    {patchText && patchText.trim().length ? <DiffText text={patchText} /> : 'No changes.'}
                  </pre>
                </>
              )}
                </div>
              </div>

              {/*
                Where the patch goes, named at the moment it exists (#166),
                each destination with what it costs — a tool that emits a file
                and stops leaves the contributor to work that out alone.

                Grouped by who does the sending, and stacked rather than laid
                side by side: in a column the grouping is what the shared card
                says, and the sidebar can scroll on its own while the diff
                stays put.
              */}
              {!patchLoading && patchHasChanges && (
                <div className="patch-destinations">
                  <div>
                  <div style={{ fontWeight:600, fontSize:14, color:'#1d2327' }}>Where this patch goes</div>
                  <div style={{ fontSize:12, color:'#6c6f72', lineHeight:1.5 }}>The pull request is the one the app sends for you. The other two save a file for you to send.</div>
                  </div>

                  {appliedPatch ? (
                    <div role="alert" style={{ padding:'10px 12px', background:'#fcf9e8', border:'1px solid #dba617', borderRadius:6, fontSize:12, color:'#6e5406', lineHeight:1.5 }}>
                      <strong>{appliedPatchLabel} is part of this checkout.</strong>{' '}
                      The app cannot safely separate its author’s changes from edits made afterward, so this combined patch cannot be submitted as your work. You can still use <strong>Save</strong> to keep an unattributed copy; revert the applied patch before submitting.
                    </div>
                  ) : null}

                  {/*
                    Alone in its own group, because it is the one destination
                    that acts for the contributor: it signs them in, forks, and
                    pushes. That is also where the signup cliff is (#167), named
                    here before anything happens rather than sprung after they
                    have left the venue.
                  */}
                  <DestinationGroup>
                    <Destination
                      title="Open a pull request"
                      cost="A GitHub account. The fork is made for you; no password is typed into this app and no credential is written to disk."
                      after="Automated checks run on it. Nobody watches GitHub, though — posting the link on the ticket is what gets it seen."
                    >
                      {/*
                        Absent from every shipped build. When a test switch is
                        set it sits above the button, because that is where the
                        decision is made — a mode set in a terminal minutes
                        earlier, in an app that otherwise looks identical, is how
                        a dry run that silently was not one opened a real pull
                        request during testing.
                      */}
                      {githubAccount?.testMode ? (
                        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'#f0f0f1', border:'1px dashed #949494', borderRadius:6, fontSize:12, color:'#3c434a', lineHeight:1.5 }}>
                          <span style={{ fontWeight:600, letterSpacing:0.5, textTransform:'uppercase', fontSize:10, color:'#1d2327' }}>Test mode</span>
                          <span>
                            {githubAccount.testMode.dryRun
                              ? 'Dry run — a branch is pushed to your fork, no pull request is opened.'
                              : <>Pull requests go to <code style={{ fontSize:11 }}>{githubAccount.testMode.target}</code>, not to wordpress-develop.</>}
                          </span>
                        </div>
                      ) : null}
                      {renderPullRequestBody()}
                      {githubError ? <div role="alert" style={{ color:'#d63638', fontSize:12 }}>{githubError}</div> : null}
                      {prError ? (
                        <>
                          <div role="alert" style={{ color:'#d63638', fontSize:12 }}>
                            {PR_FAILURE_MESSAGES[prError.reason] || prError.error}
                          </div>
                          {/*
                            Every failure lands here, and every failure has the
                            same floor: the file exists regardless of what GitHub
                            did.
                          */}
                          <Button variant="secondary" onClick={savePatch} style={{ justifyContent:'center' }}>Save the patch file instead</Button>
                        </>
                      ) : null}
                    </Destination>
                  </DestinationGroup>

                  <DestinationGroup>
                    <Destination
                      title="Attach to Trac"
                      cost="A WordPress.org account — needed anyway, for props and to comment."
                      after="No automated checks. Often followed by a request to open a pull request."
                    >
                      {tracTicket ? (
                        <Button variant="primary" onClick={saveForTrac} disabled={Boolean(appliedPatch)} style={{ justifyContent:'center' }}>
                          Save, then open #{tracTicket}
                        </Button>
                      ) : (
                        <>
                          <div style={{ fontSize:12, color:'#6c6f72' }}>
                            No ticket is linked to this site, so there is nowhere to attach it yet.
                          </div>
                          <TextControl
                            value={ticketInput}
                            onChange={(value) => { setTicketInput(value); setTicketError(''); }}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); linkTicket(); } }}
                            disabled={ticketActionsBlocked}
                            placeholder="Ticket number or URL, e.g. 62281"
                            aria-label="Trac ticket number or URL"
                          />
                          <Button
                            variant="secondary"
                            onClick={linkTicket}
                            isBusy={ticketSaving}
                            disabled={ticketActionsBlocked || !ticketInput.trim()}
                            style={{ justifyContent:'center' }}
                          >Link ticket</Button>
                          {ticketError ? <div role="alert" style={{ color:'#d63638', fontSize:12 }}>{ticketError}</div> : null}
                          {switchProgressLine}
                          {savedCleanNotice}
                          {blockedPanel}
                        </>
                      )}
                    </Destination>

                    <Destination
                      title="Hand it to a mentor"
                      cost="No accounts at all. The patch carries your WordPress.org username, and the event you are at."
                      after="Someone else pushes it; the props still land on you."
                    >
                      {wporg?.handle && !editingHandle ? (
                        <>
                          <Button variant="primary" onClick={saveForHandoff} disabled={Boolean(appliedPatch)} style={{ justifyContent:'center' }}>
                            Save patch as {wporg.handle}
                          </Button>
                          {/*
                            The event is shown on every save rather than only when
                            it is set: a remembered WordCamp from last year would
                            otherwise keep stamping patches with nobody seeing it.
                          */}
                          <div style={{ fontSize:12, color:'#6c6f72' }}>
                            {wporg.event ? <>The patch will say it was written at <strong>{wporg.event}</strong>.</> : 'No event on the patch.'}
                          </div>
                          <Button
                            variant="link"
                            onClick={() => {
                              setHandleInput(wporg.handle);
                              setEventInput(wporg.event || '');
                              setHandleError('');
                              setEditingHandle(true);
                            }}
                            style={{ fontSize:12 }}
                          >Change these</Button>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize:12, color:'#6c6f72' }}>
                            Asked once and remembered for every site — these are facts about you, not about this checkout.
                          </div>
                          <TextControl
                            value={handleInput}
                            onChange={(value) => { setHandleInput(value); setHandleError(''); }}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); rememberContributor(); } }}
                            disabled={handleSaving}
                            placeholder="WordPress.org username, e.g. janedoe"
                            aria-label="WordPress.org username"
                          />
                          <TextControl
                            value={eventInput}
                            onChange={(value) => { setEventInput(value); setHandleError(''); }}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); rememberContributor(); } }}
                            disabled={handleSaving}
                            placeholder="Event, e.g. WordCamp Europe 2026 (optional)"
                            aria-label="Event this patch was written at"
                          />
                          <Button
                            variant="secondary"
                            onClick={rememberContributor}
                            isBusy={handleSaving}
                            // Empty is a valid answer only when there is
                            // something to clear — a shared laptop at a
                            // contributor day, the next person taking over.
                            // Before the first answer it would just be a button
                            // that does nothing.
                            disabled={handleSaving || (!handleInput.trim() && !wporg?.handle)}
                            style={{ justifyContent:'center' }}
                          >Remember this</Button>
                          {handleError ? <div role="alert" style={{ color:'#d63638', fontSize:12 }}>{handleError}</div> : null}
                        </>
                      )}
                    </Destination>
                  </DestinationGroup>
                  </div>
              )}
            </div>
          </div>
        </Modal>
      )}
      {isEmailOpen && activeEmail && (
        <Modal
          title={activeEmail.subject || 'Email'}
          onRequestClose={()=>{ setIsEmailOpen(false); setActiveEmail(null); }}
          shouldCloseOnClickOutside
          isFullScreen
        >
          <div style={{ padding: 8 }}>
            <div style={{ marginBottom: 8, fontSize:12, color:'#444' }}>
              <div><strong>From:</strong> {activeEmail.from || ''}</div>
              <div><strong>To:</strong> {activeEmail.to || ''}</div>
              {activeEmail.cc ? (<div><strong>CC:</strong> {activeEmail.cc}</div>) : null}
              <div><strong>Date:</strong> {formatEmailDate(activeEmail)}</div>
            </div>
            <TabPanel className="email-tabs" activeClass="is-active" onSelect={(n)=>setEmailViewTab(n)} tabs={[{name:'rendered',title:'Rendered'},{name:'raw',title:'Raw'}]}>
              {(tab)=> tab.name==='rendered' ? (
                <div style={{ border:'1px solid #ddd', borderRadius:6, padding:12, minHeight:'60vh', background:'#fff' }}>
                  {activeEmail.html ? (
                    <div dangerouslySetInnerHTML={{ __html: String(activeEmail.html) }} />
                  ) : (
                    <pre style={{ whiteSpace:'pre-wrap', margin:0 }}>{activeEmail.text || ''}</pre>
                  )}
                </div>
              ) : (
                <pre style={{ whiteSpace:'pre-wrap', margin:0, background:'#111', color:'#eee', padding:12, borderRadius:6, minHeight:'60vh', overflow:'auto' }}>{activeEmail.raw || activeEmail.text || ''}</pre>
              )}
            </TabPanel>
          </div>
        </Modal>
      )}
    </section>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
