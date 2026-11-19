(() => {
  'use strict';

  const STORAGE_KEY = 'todo-v2';
  const OLD_STORAGE_KEY = 'my-lists-v1';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_KINDS = [
    { id: 'do', name: 'Do' },
    { id: 'read', name: 'Read' },
    { id: 'watch', name: 'Watch' },
  ];
  const STATES = ['open', 'doing', 'done'];
  const COUNTDOWN = '__countdown';
  const FLAG_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 3.5h9v13.5L10 13.6 5.5 17Z"/></svg>';

  const $ = (id) => document.getElementById(id);

  // ---------- state ----------

  const str = (v) => (typeof v === 'string' ? v : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normalize(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};

    const kinds = DEFAULT_KINDS.map((k) => {
      const saved = arr(data.kinds).find((x) => x && x.id === k.id);
      return { id: k.id, name: str(saved && saved.name).trim() || k.name, updatedAt: num(saved && saved.updatedAt) ?? 0 };
    });
    for (const k of arr(data.kinds)) {
      const id = str(k && k.id);
      const name = str(k && k.name).trim();
      if (id && name && id !== COUNTDOWN && !kinds.some((x) => x.id === id)) {
        kinds.push({ id, name, updatedAt: num(k.updatedAt) ?? 0 });
      }
    }

    const items = arr(data.items)
      .filter((i) => i && str(i.title).trim())
      .map((i) => {
        const state = STATES.includes(i.state) ? i.state : 'open';
        const createdAt = num(i.createdAt) ?? Date.now();
        return {
          id: str(i.id) || uid(),
          kind: kinds.some((k) => k.id === i.kind) ? i.kind : 'do',
          title: str(i.title).trim(),
          note: str(i.note).trim(),
          due: parseDate(str(i.due)) ? i.due : '',
          state,
          next: state !== 'done' && !!i.next,
          createdAt,
          doneAt: state === 'done' ? num(i.doneAt) ?? Date.now() : null,
          updatedAt: num(i.updatedAt) ?? createdAt,
        };
      });

    const countdowns = arr(data.countdowns)
      .filter((c) => c && str(c.name).trim() && parseDate(str(c.date)))
      .map((c) => ({ id: str(c.id) || uid(), name: str(c.name).trim(), date: c.date, updatedAt: num(c.updatedAt) ?? 0 }));

    // When each deleted thing was deleted, so a deletion on one device wins over an older copy on another.
    const deleted = {};
    if (data.deleted && typeof data.deleted === 'object') {
      for (const [key, at] of Object.entries(data.deleted)) if (num(at) !== null) deleted[key] = at;
    }

    return { kinds, items, countdowns, deleted };
  }

  // Carries over anything saved by the first version of this page.
  function migrateOld(old) {
    const bookState = { want: 'open', reading: 'doing', finished: 'done' };
    return {
      items: [
        ...arr(old.todos).map((t) => ({ kind: 'do', title: t && t.text, state: t && t.done ? 'done' : 'open' })),
        ...arr(old.books).map((b) => ({
          kind: 'read',
          title: b && b.title,
          note: b && b.author,
          state: bookState[b && b.status] || 'open',
        })),
      ],
      countdowns: old.countdowns,
    };
  }

  function load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return normalize(JSON.parse(saved));
      const old = localStorage.getItem(OLD_STORAGE_KEY);
      if (old) return normalize(migrateOld(JSON.parse(old)));
    } catch {
      // Unreadable or unavailable storage: start empty.
    }
    return normalize(null);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable (e.g. private mode): the page still works for this visit.
    }
  }

  // ---------- change tracking (what makes syncing between devices merge cleanly) ----------

  const COLLECTIONS = ['kinds', 'items', 'countdowns'];
  let snapshot = new Map(); // "collection:id" -> contents as last saved

  const fingerprint = ({ updatedAt, ...rest }) => JSON.stringify(rest);

  function takeSnapshot() {
    snapshot = new Map();
    for (const col of COLLECTIONS) for (const e of state[col]) snapshot.set(`${col}:${e.id}`, fingerprint(e));
  }

  // Compares with the last save: anything new or changed gets the current time, anything gone gets a deletion marker.
  function stamp() {
    const now = Date.now();
    const seen = new Set();
    for (const col of COLLECTIONS) {
      for (const e of state[col]) {
        const key = `${col}:${e.id}`;
        seen.add(key);
        if (snapshot.get(key) !== fingerprint(e)) {
          e.updatedAt = now;
          delete state.deleted[key];
        }
      }
    }
    for (const key of snapshot.keys()) if (!seen.has(key)) state.deleted[key] = now;
    takeSnapshot();
  }

  // Combines two copies: for each thing the newest version wins, unless it was deleted after that.
  function merge(a, b) {
    const deleted = { ...a.deleted };
    for (const [key, at] of Object.entries(b.deleted)) deleted[key] = Math.max(deleted[key] || 0, at);
    const out = { deleted };
    for (const col of COLLECTIONS) {
      const byId = new Map();
      for (const e of [...a[col], ...b[col]]) {
        const current = byId.get(e.id);
        if (!current || e.updatedAt > current.updatedAt) byId.set(e.id, e);
      }
      out[col] = [...byId.values()].filter((e) => {
        const key = `${col}:${e.id}`;
        if (deleted[key] >= e.updatedAt) return false;
        delete deleted[key]; // changed again after it was deleted elsewhere: it stays
        return true;
      });
    }
    out.items.sort((x, y) => y.createdAt - x.createdAt);
    return normalize(JSON.parse(JSON.stringify(out)));
  }

  function save() {
    stamp();
    persist();
    scheduleSync();
  }

  let state = load();
  takeSnapshot();
  let doneFilter = 'all';
  const completing = new Set(); // ids of to-dos mid-way through the completion animation
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let countMode = 'days'; // how the hero countdown counts; tapping the numeral cycles it
  let countInPending = false; // play the count-in once each time the Countdowns page is opened

  // ---------- helpers ----------

  // `focus` names a control so the same control can be focused again after a re-render (see render()).
  function el(tag, { focus, ...props } = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    if (focus) node.dataset.focus = focus;
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  }

  // "YYYY-MM-DD" -> local-midnight Date (or null if invalid)
  function parseDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function daysUntil(dateStr) {
    return Math.round((parseDate(dateStr) - startOfToday()) / DAY_MS);
  }

  function relativeDay(days) {
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return days > 0 ? `${days} days` : `${-days} days ago`;
  }

  function longDate(date) {
    return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function quote(text) {
    return `“${text.length > 26 ? `${text.slice(0, 25)}…` : text}”`;
  }

  function emptyState(text) {
    return el('p', { className: 'empty', textContent: text });
  }

  function kindName(id) {
    const kind = state.kinds.find((k) => k.id === id);
    return kind ? kind.name : '';
  }

  function commit() {
    save();
    render();
  }

  // ---------- undo toast ----------

  let toastTimer;
  let undoAction = null;

  function hideToast() {
    clearTimeout(toastTimer);
    undoAction = null;
    $('toast').classList.remove('show');
  }

  // A short message at the bottom of the screen, with Undo when the change can be taken back.
  function showToast(message, undo = null) {
    $('toast-text').textContent = message;
    undoAction = undo;
    $('toast-undo').hidden = !undo;
    $('toast').classList.toggle('plain', !undo);
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undo ? 8000 : 4000);
  }

  // Applies a change, then offers to take it back for a few seconds.
  function changeWithUndo(message, mutate) {
    const before = JSON.stringify(state);
    mutate();
    commit();
    showToast(message, () => {
      state = normalize(JSON.parse(before));
      commit();
    });
  }

  // ---------- confirm dialog (before anything is deleted or replaced) ----------

  function confirmAction({ title, text, ok }) {
    const dialog = $('confirm-sheet');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = ok;
    dialog.returnValue = '';
    dialog.showModal();
    $('confirm-cancel').focus(); // the safe choice is the default
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  // The row just added gets a brief highlight, so you can see where it went.
  let justAdded = null;

  function markAdded(id) {
    justAdded = id;
    setTimeout(() => {
      if (justAdded === id) justAdded = null;
    }, 1600);
  }

  $('toast-undo').addEventListener('click', () => {
    if (undoAction) undoAction();
    hideToast();
  });

  // ---------- rows ----------

  function dueTag(days, title) {
    const urgency = days < 0 ? ' overdue' : days <= 1 ? ' soon' : '';
    return el('span', {
      className: `due${urgency}`,
      textContent: days < 0 ? `${plural(-days, 'day')} overdue` : relativeDay(days),
      title,
    });
  }

  function dueBadge(item) {
    return item.due ? dueTag(daysUntil(item.due), longDate(parseDate(item.due))) : null;
  }

  // The tappable text part of a row. A due tag sits inside it so narrow screens can drop it under the title;
  // it is also linked as the button's description so screen readers still hear it.
  function openButton(id, label, title, sub, tag, onclick) {
    const button = el(
      'button',
      { type: 'button', className: 'open', ariaLabel: label, onclick, focus: `open:${id}` },
      el('span', { className: 'title', textContent: title }),
      sub && el('span', { className: 'sub', textContent: sub }),
      tag
    );
    if (tag) {
      tag.id = `due-${uid()}`;
      button.setAttribute('aria-describedby', tag.id);
    }
    return button;
  }

  function completeItem(item, li, input) {
    input.disabled = true;
    const finish = () => {
      completing.delete(item.id);
      if (!state.items.includes(item) || item.state === 'done') return;
      changeWithUndo(`${quote(item.title)} done`, () => {
        item.state = 'done';
        item.next = false;
        item.doneAt = Date.now();
      });
    };
    if (reducedMotion.matches) return finish();
    completing.add(item.id);
    li.classList.add('completing');
    setTimeout(finish, 350);
  }

  function itemRow(item, { showKind = false, showFlag = false } = {}) {
    const sub = [showKind && kindName(item.kind), item.note].filter(Boolean).join(' · ');
    const pending = completing.has(item.id);
    const li = el('li', { className: [pending && 'completing', item.id === justAdded && 'just-added'].filter(Boolean).join(' ') });
    const tick = el('input', {
      type: 'checkbox',
      checked: pending,
      disabled: pending,
      ariaLabel: `Mark ${item.title} as done`,
      onchange: () => completeItem(item, li, tick),
      focus: `tick:${item.id}`,
    });

    li.append(
      el('label', { className: 'tick' }, tick),
      openButton(item.id, `Edit ${item.title}`, item.title, sub, dueBadge(item), () => openSheet({ item })),
      ...[showFlag && el('button', {
          type: 'button',
          className: 'flag',
          focus: `flag:${item.id}`,
          innerHTML: FLAG_ICON,
          title: item.next ? 'Remove from Next up' : 'Add to Next up',
          ariaLabel: `Next up: ${item.title}`,
          ariaPressed: String(item.next),
          onclick: () => {
            item.next = !item.next;
            commit();
          },
        })].filter(Boolean)
    );
    return li;
  }

  function countdownRow(c, days) {
    const abs = Math.abs(days);
    return el(
      'li',
      { className: [days < 0 && 'past', c.id === justAdded && 'just-added'].filter(Boolean).join(' ') },
      el(
        'button',
        { type: 'button', className: 'open', ariaLabel: `Edit ${c.name}`, onclick: () => openSheet({ countdown: c }), focus: `open:${c.id}` },
        el('span', { className: 'title', textContent: c.name }),
        el('span', { className: 'sub', textContent: longDate(parseDate(c.date)) })
      ),
      days === 0
        ? el('div', { className: 'days' }, el('b', { textContent: 'Today' }))
        : el(
            'div',
            { className: 'days' },
            el('b', { textContent: String(abs) }),
            el('small', { textContent: `${abs === 1 ? 'day' : 'days'}${days < 0 ? ' ago' : ''}` })
          )
    );
  }

  function section(title, rows, labelClass = '') {
    return [
      el('h2', { className: `group ${labelClass}`.trim(), textContent: title }),
      el('ul', { className: 'rows' }, ...rows),
    ];
  }

  function head(eyebrow, title, summary) {
    return el(
      'header',
      { className: 'view-head' },
      eyebrow,
      el('h1', { textContent: title }),
      el('p', { className: 'summary', textContent: summary })
    );
  }

  function linkRow(href, title, count) {
    return el(
      'li',
      {},
      el(
        'a',
        { className: 'list-link', href, focus: `link:${href}` },
        el('span', { className: 'title', textContent: title }),
        el('span', { className: 'count', textContent: String(count) })
      )
    );
  }

  // Only on narrow screens, where a list is one step below the Lists tab. Wide screens have the sidebar.
  const backToLists = () => el('a', { className: 'eyebrow back-link', href: '#lists', textContent: '‹ Lists' });

  // ---------- views ----------

  function homeView() {
    const active = state.items.filter((i) => i.state !== 'done');
    const next = active.filter((i) => i.next);
    const doing = active.filter((i) => i.state === 'doing' && !i.next);

    // The next countdown gets its own line under the title, so it is left out of Coming up.
    const nextEvent = state.countdowns
      .map((c) => ({ c, days: daysUntil(c.date) }))
      .filter((i) => i.days >= 0)
      .sort((a, b) => a.days - b.days)[0];

    // Anything already listed under Next up or In progress shows its date there, so it is left out here.
    const coming = [
      ...active
        .filter((i) => i.due && !i.next && i.state !== 'doing')
        .map((i) => ({ id: i.id, days: daysUntil(i.due), title: i.title, sub: kindName(i.kind), open: () => openSheet({ item: i }) })),
      ...state.countdowns
        .filter((c) => !nextEvent || c !== nextEvent.c)
        .map((c) => ({ id: c.id, days: daysUntil(c.date), title: c.name, sub: 'Countdown', open: () => openSheet({ countdown: c }) }))
        .filter((c) => c.days >= 0),
    ]
      .sort((a, b) => a.days - b.days)
      .slice(0, 5);

    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const todayStart = startOfToday().getTime();
    const doneToday = state.items.filter((i) => i.state === 'done' && i.doneAt >= todayStart).length;
    const progress = active.length
      ? `${doneToday} of ${active.length + doneToday} done today`
      : doneToday
        ? 'All done for today'
        : state.items.length
          ? 'All done'
          : '';

    const nodes = [head(el('p', { className: 'dateline', textContent: today }), 'To Do', progress)];

    // One quiet line about the next thing to look forward to.
    if (nextEvent) {
      const { c, days } = nextEvent;
      nodes[0].append(
        el('a', {
          className: 'next-event',
          href: '#countdowns',
          textContent: days === 0 ? `${c.name} is today` : days === 1 ? `${c.name} is tomorrow` : `${days} days until ${c.name}`,
        })
      );
    }

    if (!state.items.length && !state.countdowns.length) {
      nodes.push(emptyState('A blank page. Press + to add your first to-do.'));
    }

    if (next.length) {
      nodes.push(...section('Next up', next.map((i) => itemRow(i, { showKind: true }))));
    } else if (active.length) {
      nodes.push(
        el('h2', { className: 'group', textContent: 'Next up' }),
        el('p', { className: 'hint', textContent: 'Open a list and tap Next up (the bookmark) on a to-do to show it here.' })
      );
    }

    if (doing.length) nodes.push(...section('In progress', doing.map((i) => itemRow(i, { showKind: true })), 'accent'));

    if (coming.length) {
      nodes.push(
        ...section(
          'Coming up',
          coming.map((c) =>
            el('li', {}, openButton(c.id, `Edit ${c.title}`, c.title, c.sub, dueTag(c.days), c.open))
          )
        )
      );
    }

    return nodes;
  }

  // Every list in one place. Wide screens show these in the sidebar; narrow ones reach this from the tab bar.
  function listsView() {
    const active = state.items.filter((i) => i.state !== 'done');
    return [
      head(null, 'Lists', active.length ? `${active.length} to do` : ''),
      el(
        'ul',
        { className: 'rows' },
        ...state.kinds.map((k) =>
          linkRow(`#list/${encodeURIComponent(k.id)}`, k.name, active.filter((i) => i.kind === k.id).length)
        )
      ),
      el(
        'div',
        { className: 'view-actions' },
        el('button', { type: 'button', className: 'text-button', textContent: 'New list', onclick: () => openListSheet(), focus: 'btn:new-list' })
      ),
    ];
  }

  function listView(kind) {
    const items = state.items.filter((i) => i.kind === kind.id && i.state !== 'done');
    const doing = items.filter((i) => i.state === 'doing');
    const open = items.filter((i) => i.state === 'open');
    const row = (i) => itemRow(i, { showFlag: true });

    const nodes = [head(backToLists(), kind.name, items.length ? `${items.length} to do` : '')];

    if (!items.length) {
      nodes.push(emptyState('Nothing here. Press + to add something.'));
    } else if (doing.length) {
      nodes.push(...section('In progress', doing.map(row), 'accent'));
      if (open.length) nodes.push(...section('Not started', open.map(row)));
    } else {
      nodes.push(el('ul', { className: 'rows' }, ...open.map(row)));
    }

    nodes.push(
      el(
        'div',
        { className: 'view-actions' },
        el('button', { type: 'button', className: 'text-button', textContent: 'Rename list', onclick: () => openListSheet(kind), focus: 'btn:rename-list' }),
        !DEFAULT_KINDS.some((k) => k.id === kind.id) &&
          el('button', {
            type: 'button',
            className: 'text-button',
            textContent: 'Delete this list',
            focus: 'btn:delete-list',
            onclick: async () => {
              const inList = state.items.filter((i) => i.kind === kind.id);
              const open = inList.filter((i) => i.state !== 'done').length;
              const finished = inList.length - open;
              const parts = [open && plural(open, 'to-do'), finished && `${finished} finished in Done`].filter(Boolean);
              const ok = await confirmAction({
                title: `Delete “${kind.name}”?`,
                text: parts.length ? `The list and its ${parts.join(' and ')} will be deleted.` : 'The list will be deleted.',
                ok: 'Delete list',
              });
              if (!ok) return;
              changeWithUndo(`${quote(kind.name)} list deleted`, () => {
                state.kinds = state.kinds.filter((k) => k.id !== kind.id);
                state.items = state.items.filter((i) => i.kind !== kind.id);
              });
              location.hash = '#lists';
            },
          })
      )
    );

    return nodes;
  }

  // ---------- countdown hero ----------

  const COUNT_MODES = ['days', 'weeks', 'sleeps', 'hours'];

  // The same wait, counted a few different ways. Weeks only make sense from seven days out.
  function countAs(mode, c, days) {
    const one = (n, word) => `${word}${n === 1 ? '' : 's'}`;
    if (mode === 'weeks') {
      const weeks = Math.floor(days / 7);
      const rest = days % 7;
      return { n: weeks, unit: `${one(weeks, 'week')}${rest ? ` and ${plural(rest, 'day')}` : ''}` };
    }
    if (mode === 'sleeps') return { n: days, unit: one(days, 'sleep') };
    if (mode === 'hours') {
      const hours = Math.max(0, Math.floor((parseDate(c.date) - Date.now()) / 3600000));
      return { n: hours, unit: one(hours, 'hour') };
    }
    return { n: days, unit: one(days, 'day') };
  }

  function nextMode(days) {
    let i = COUNT_MODES.indexOf(countMode);
    do i = (i + 1) % COUNT_MODES.length;
    while (COUNT_MODES[i] === 'weeks' && days < 7);
    return COUNT_MODES[i];
  }

  // Ticks the numeral down from a little above the real number, so the page opens with the days running out.
  function countIn(numEl, days) {
    const from = days + Math.min(12, Math.max(3, Math.round(days * 0.25)));
    const start = performance.now();
    const duration = 900;
    const settled = () => numEl.isConnected && numEl.dataset.mode === 'days';
    const step = (now) => {
      if (!settled()) return;
      const t = Math.min(1, (now - start) / duration);
      numEl.textContent = Math.round(from - (from - days) * (1 - (1 - t) ** 3)).toLocaleString();
      if (t < 1) requestAnimationFrame(step);
    };
    numEl.textContent = from.toLocaleString();
    requestAnimationFrame(step);
    // Background tabs pause animation frames, so make sure the real number always lands.
    setTimeout(() => { if (settled()) numEl.textContent = days.toLocaleString(); }, duration + 150);
  }

  function hero(c, days) {
    const event = el(
      'button',
      { type: 'button', className: 'hero-event', ariaLabel: `Edit ${c.name}`, onclick: () => openSheet({ countdown: c }), focus: `open:${c.id}` },
      el('span', { className: 'hero-name', textContent: c.name }),
      el('span', { className: 'hero-date', textContent: days === 0 ? 'It’s here.' : longDate(parseDate(c.date)) })
    );

    // On the day: a large italic "Today" whose letters rise in one by one.
    if (days === 0) {
      return el(
        'section',
        { className: 'hero is-today', ariaLabel: 'Next countdown' },
        el(
          'p',
          { className: 'hero-today' },
          el('span', { className: 'sr-only', textContent: 'Today' }),
          ...Array.from('Today', (ch, i) => {
            const letter = el('span', { className: 'letter', ariaHidden: 'true', textContent: ch });
            letter.style.animationDelay = `${i * 70}ms`;
            return letter;
          })
        ),
        event
      );
    }

    if (countMode === 'weeks' && days < 7) countMode = 'days';
    const first = countAs(countMode, c, days);
    const num = el('span', { className: 'hero-num', textContent: first.n.toLocaleString() });
    num.dataset.mode = countMode;
    const unit = el('span', { className: 'hero-unit', textContent: first.unit });

    const count = el(
      'button',
      {
        type: 'button',
        className: 'hero-count',
        title: 'Count it another way',
        focus: 'hero-count',
        onclick: () => {
          countMode = nextMode(days);
          const next = countAs(countMode, c, days);
          num.dataset.mode = countMode;
          num.textContent = next.n.toLocaleString();
          unit.textContent = next.unit;
          count.classList.remove('swap');
          void count.offsetWidth;
          count.classList.add('swap');
        },
      },
      el('span', { className: 'hero-count-text', ariaLive: 'polite' }, num, el('span', { className: 'sr-only', textContent: ' ' }), unit)
    );
    count.setAttribute('aria-describedby', 'hero-hint');

    if (countInPending && countMode === 'days' && !reducedMotion.matches) countIn(num, days);
    countInPending = false;

    return el(
      'section',
      { className: 'hero', ariaLabel: 'Next countdown' },
      count,
      el('span', { className: 'sr-only', id: 'hero-hint', textContent: 'Activate to count it another way.' }),
      event
    );
  }

  function countdownsView() {
    const all = state.countdowns.map((c) => ({ c, days: daysUntil(c.date) }));
    const upcoming = all.filter((i) => i.days >= 0).sort((a, b) => a.days - b.days);
    const past = all.filter((i) => i.days < 0).sort((a, b) => b.days - a.days);
    const [first, ...later] = upcoming;

    if (!first) {
      const nodes = [head(null, 'Countdowns', '')];
      if (!all.length) nodes.push(emptyState('Nothing to look forward to yet. Press + to add a date.'));
      if (past.length) nodes.push(...section('Past', past.map((i) => countdownRow(i.c, i.days))));
      return nodes;
    }

    // The soonest event gets the page; the page title is kept for screen readers.
    const nodes = [
      el('header', { className: 'view-head' }, el('h1', { className: 'sr-only', textContent: 'Countdowns' })),
      hero(first.c, first.days),
    ];
    if (later.length) nodes.push(...section('Later', later.map((i) => countdownRow(i.c, i.days))));
    if (past.length) nodes.push(...section('Past', past.map((i) => countdownRow(i.c, i.days))));
    return nodes;
  }

  function doneView() {
    const allDone = state.items.filter((i) => i.state === 'done').sort((a, b) => b.doneAt - a.doneAt);
    const kinds = state.kinds.filter((k) => allDone.some((i) => i.kind === k.id));
    if (doneFilter !== 'all' && !kinds.some((k) => k.id === doneFilter)) doneFilter = 'all';
    const shown = doneFilter === 'all' ? allDone : allDone.filter((i) => i.kind === doneFilter);

    const nodes = [head(null, 'Done', allDone.length ? `${allDone.length} finished` : '')];

    if (!allDone.length) {
      nodes.push(emptyState('Nothing finished yet. It will be recorded here.'));
      return nodes;
    }

    if (kinds.length > 1) {
      const chip = (id, label) =>
        el('button', {
          type: 'button',
          className: 'chip',
          textContent: label,
          ariaPressed: String(doneFilter === id),
          focus: `chip:${id}`,
          onclick: () => {
            doneFilter = id;
            render();
          },
        });
      nodes.push(el('div', { className: 'chips', role: 'group', ariaLabel: 'Filter by kind' }, chip('all', 'All'), ...kinds.map((k) => chip(k.id, k.name))));
    }

    const months = new Map();
    for (const item of shown) {
      const key = new Date(item.doneAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      if (!months.has(key)) months.set(key, []);
      months.get(key).push(item);
    }

    for (const [month, items] of months) {
      nodes.push(
        ...section(
          month,
          items.map((item) =>
            el(
              'li',
              { className: 'done' },
              el(
                'label',
                { className: 'tick' },
                el('input', {
                  type: 'checkbox',
                  checked: true,
                  ariaLabel: `Mark ${item.title} as not done`,
                  focus: `tick:${item.id}`,
                  onchange: () =>
                    changeWithUndo(`${quote(item.title)} moved back to ${kindName(item.kind)}`, () => {
                      item.state = 'open';
                      item.doneAt = null;
                    }),
                })
              ),
              el(
                'button',
                { type: 'button', className: 'open', ariaLabel: `Edit ${item.title}`, onclick: () => openSheet({ item }), focus: `open:${item.id}` },
                el('span', { className: 'title', textContent: item.title }),
                el('span', {
                  className: 'sub',
                  textContent: [kindName(item.kind), item.note].filter(Boolean).join(' · '),
                })
              ),
              el('span', {
                className: 'due',
                textContent: new Date(item.doneAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
              })
            )
          )
        )
      );
    }

    return nodes;
  }

  // ---------- routing ----------

  function currentRoute() {
    const hash = location.hash.slice(1);
    if (hash === 'lists' || hash === 'countdowns' || hash === 'done') return { name: hash };
    if (hash.startsWith('list/')) {
      let id = hash.slice(5);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Keep the raw value; it simply won't match a list.
      }
      const kind = state.kinds.find((k) => k.id === id);
      if (kind) return { name: 'list', kind };
    }
    return { name: 'home' };
  }

  let renderedDay = '';

  // ---------- sidebar (wide screens) ----------

  function renderSidebar(route) {
    const active = state.items.filter((i) => i.state !== 'done');
    const link = (href, name, count, current) =>
      el(
        'li',
        {},
        el(
          'a',
          { className: 'side-link', href, ariaCurrent: current ? 'page' : null, focus: `side:${href}` },
          el('span', { className: 'side-name', textContent: name }),
          count !== null && el('span', { className: 'side-count', textContent: String(count) })
        )
      );

    $('sidebar').replaceChildren(
      el('p', { className: 'side-app', textContent: 'To Do' }),
      el('button', { type: 'button', className: 'btn side-add', textContent: 'New to-do', title: 'New to-do (N)', onclick: () => openAdd(), focus: 'side:add' }),
      el(
        'nav',
        { ariaLabel: 'Main' },
        el('ul', { className: 'side-list' }, link('#home', 'Home', null, route.name === 'home')),
        el('h2', { className: 'group', textContent: 'Lists' }),
        el(
          'ul',
          { className: 'side-list' },
          ...state.kinds.map((k) =>
            link(
              `#list/${encodeURIComponent(k.id)}`,
              k.name,
              active.filter((i) => i.kind === k.id).length,
              route.name === 'list' && route.kind.id === k.id
            )
          )
        ),
        el('button', { type: 'button', className: 'text-button side-new-list', textContent: 'New list', onclick: () => openListSheet(), focus: 'side:new-list' }),
        el('h2', { className: 'group', textContent: 'More' }),
        el(
          'ul',
          { className: 'side-list' },
          link('#countdowns', 'Countdowns', state.countdowns.filter((c) => daysUntil(c.date) >= 0).length, route.name === 'countdowns'),
          link('#done', 'Done', state.items.length - active.length, route.name === 'done')
        )
      )
    );
  }

  // ---------- keeping keyboard focus across re-renders ----------

  // Each render rebuilds the page, which would drop keyboard focus to the top of the document. Controls carry a
  // data-focus name, so render() can focus the same control in the new page, or the nearest one of its kind
  // when it is gone (a to-do that was just ticked off moves focus to the next tick).
  let lastFocused = null;
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && e.target.dataset.focus) lastFocused = e.target;
  });

  function focusToKeep() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.dataset.focus) return active;
    // A tick disables itself while it animates, which drops focus to the page: carry on from where it was.
    const dropped = !active || active === document.body;
    if (dropped && lastFocused && (!lastFocused.isConnected || lastFocused.disabled)) return lastFocused;
    return null;
  }

  // "tick:abc123" -> "tick": controls of the same kind can stand in for each other.
  const focusKind = (key) => key.split(':')[0];
  const controlsOfKind = (kind) => [...document.querySelectorAll('[data-focus]')].filter((n) => focusKind(n.dataset.focus) === kind);

  // Remembers which control had focus, and where it sat among controls of its kind.
  function focusSpot() {
    const from = focusToKeep();
    if (!from) return null;
    const key = from.dataset.focus;
    return { key, kind: focusKind(key), ordinal: Math.max(0, controlsOfKind(focusKind(key)).indexOf(from)) };
  }

  function restoreFocus({ key, kind, ordinal }, routeChanged) {
    let target = [...document.querySelectorAll('[data-focus]')].find((n) => n.dataset.focus === key && !n.disabled);
    if (!target && !routeChanged) {
      const now = controlsOfKind(kind).filter((n) => !n.disabled);
      target = now[Math.min(ordinal, now.length - 1)];
    }
    if (!target) {
      // A different page, or nothing of the same kind left: start from the page title.
      target = document.querySelector('#view h1');
      if (target) target.tabIndex = -1;
    }
    if (target) target.focus({ preventScroll: true });
  }

  let renderedRoute = '';

  function render() {
    renderedDay = startOfToday().toDateString();
    const route = currentRoute();
    const routeId = route.name === 'list' ? `list:${route.kind.id}` : route.name;
    const routeChanged = routeId !== renderedRoute;
    renderedRoute = routeId;

    const keep = focusSpot();
    lastFocused = null; // used at most once; focusing the restored control sets it again

    renderSidebar(route);
    const tab = route.name === 'list' ? 'lists' : route.name;
    for (const link of $('tabbar').querySelectorAll('a')) {
      if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }

    const views = {
      home: () => ['To Do', homeView()],
      lists: () => ['Lists · To Do', listsView()],
      list: () => [`${route.kind.name} · To Do`, listView(route.kind)],
      countdowns: () => ['Countdowns · To Do', countdownsView()],
      done: () => ['Done · To Do', doneView()],
    };
    const [title, nodes] = views[route.name]();
    document.title = title;
    $('view').replaceChildren(...nodes);

    if (keep && !document.querySelector('dialog[open]')) restoreFocus(keep, routeChanged);
  }

  window.addEventListener('hashchange', () => {
    finishSignIn(); // the email link can also land in a tab where the app is already open
    countInPending = currentRoute().name === 'countdowns';
    render();
    window.scrollTo(0, 0);
    // Replay the entrance animation for the new screen.
    const view = $('view');
    view.style.animation = 'none';
    void view.offsetWidth;
    view.style.animation = '';
  });

  // Keep the day counts right if the page is left open past midnight.
  function refreshIfNewDay() {
    if (renderedDay !== startOfToday().toDateString() && !$('sheet').open) render();
  }
  document.addEventListener('visibilitychange', refreshIfNewDay);
  setInterval(refreshIfNewDay, 60 * 1000);

  // ---------- add / edit sheet ----------

  const sheet = $('sheet');
  let editing = null; // { item } | { countdown } | null when adding

  function currentKind() {
    const checked = sheet.querySelector('input[name="kind"]:checked');
    return checked ? checked.value : 'do';
  }

  // A new to-do starts with just a title and a list; "Add a note, due date or Next up" shows the rest.
  // Editing shows everything, and a countdown always shows its date because it needs one.
  let showDetails = false;

  function syncSheetMode() {
    const isCountdown = currentKind() === COUNTDOWN;
    const editingItem = !!(editing && editing.item);
    const details = !!editing || showDetails;
    $('row-kind').hidden = !!(editing && editing.countdown);
    $('kind-legend').textContent = editing ? 'List' : 'Add to';
    $('row-more').hidden = isCountdown || details;
    $('row-note').hidden = isCountdown || !details;
    $('row-due').hidden = !isCountdown && !details;
    $('row-next').hidden = isCountdown || !details;
    $('row-state').hidden = !editingItem;
    $('f-title').placeholder = isCountdown ? 'What are you counting down to?' : 'What needs doing?';
    $('f-due').required = isCountdown;
    $('due-label').innerHTML = isCountdown ? 'Date' : 'Due date <em>optional</em>';
    $('sheet-title').textContent = editing
      ? isCountdown
        ? 'Edit countdown'
        : 'Edit to-do'
      : isCountdown
        ? 'New countdown'
        : 'New to-do';
  }

  function openSheet({ item = null, countdown = null, kind = 'do' } = {}) {
    editing = item ? { item } : countdown ? { countdown } : null;
    showDetails = false;

    $('sheet-form').reset();

    // Kind chips. A countdown can't become a to-do (or back), so they are locked when editing one.
    const selected = item ? item.kind : countdown ? COUNTDOWN : kind;
    const options = [...state.kinds.map((k) => [k.id, k.name]), ...(item ? [] : [[COUNTDOWN, 'Countdowns']])];
    $('f-kind').replaceChildren(
      ...options.map(([value, label]) =>
        el(
          'label',
          { className: 'chip-option' },
          el('input', { type: 'radio', name: 'kind', value, checked: value === selected, disabled: !!countdown }),
          el('span', { textContent: label })
        )
      )
    );
    $('f-title').value = item ? item.title : countdown ? countdown.name : '';
    $('f-note').value = item ? item.note : '';
    $('f-due').value = item ? item.due : countdown ? countdown.date : '';
    $('f-next').checked = !!(item && item.next);
    sheet.querySelector(`input[name="state"][value="${item ? item.state : 'open'}"]`).checked = true;
    $('sheet-delete').hidden = !editing;

    syncSheetMode();
    sheet.showModal();
    // When editing, don't pop the phone keyboard open until a field is tapped.
    if (editing) $('sheet-cancel').focus();
    else $('f-title').focus();
  }

  $('f-kind').addEventListener('change', () => {
    // A date typed for a countdown carries over as the due date, so keep it in view rather than hide it.
    if (currentKind() !== COUNTDOWN && $('f-due').value) showDetails = true;
    syncSheetMode();
  });

  $('sheet-more').addEventListener('click', () => {
    showDetails = true;
    syncSheetMode();
    $('f-note').focus();
  });
  $('sheet-cancel').addEventListener('click', () => sheet.close());

  for (const dialog of document.querySelectorAll('dialog')) {
    // A click on the dimmed backdrop lands on the dialog element itself.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  $('sheet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('f-title').value.trim();
    const kind = currentKind();
    const due = parseDate($('f-due').value) ? $('f-due').value : '';
    if (!title) return;

    if (kind === COUNTDOWN) {
      if (!due) return;
      sheet.close();
      if (editing && editing.countdown) {
        Object.assign(editing.countdown, { name: title, date: due });
        commit();
      } else {
        const id = uid();
        markAdded(id);
        changeWithUndo(`${quote(title)} added to Countdowns`, () => state.countdowns.push({ id, name: title, date: due }));
      }
      return;
    } else {
      const newState = sheet.querySelector('input[name="state"]:checked').value;
      const fields = {
        kind,
        title,
        note: $('f-note').value.trim(),
        due,
        state: newState,
        next: newState !== 'done' && $('f-next').checked,
      };
      sheet.close();
      if (editing && editing.item) {
        const item = editing.item;
        fields.doneAt = newState === 'done' ? item.doneAt ?? Date.now() : null;
        Object.assign(item, fields);
        commit();
      } else {
        const id = uid();
        markAdded(id);
        changeWithUndo(`${quote(title)} added to ${kindName(kind)}`, () =>
          state.items.unshift({ id, createdAt: Date.now(), doneAt: null, ...fields })
        );
      }
    }
  });

  $('sheet-delete').addEventListener('click', async () => {
    if (!editing) return;
    const { item, countdown } = editing;
    const name = item ? item.title : countdown.name;
    const ok = await confirmAction({
      title: item ? 'Delete this to-do?' : 'Delete this countdown?',
      text: `“${name}” will be deleted.`,
      ok: 'Delete',
    });
    if (!ok) return; // back to the edit sheet, unchanged
    sheet.close();
    changeWithUndo(`${quote(name)} deleted`, () => {
      if (item) state.items = state.items.filter((i) => i !== item);
      else state.countdowns = state.countdowns.filter((c) => c !== countdown);
    });
  });

  function openAdd() {
    const route = currentRoute();
    openSheet({ kind: route.name === 'list' ? route.kind.id : route.name === 'countdowns' ? COUNTDOWN : 'do' });
  }

  $('add').addEventListener('click', openAdd);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]') || (e.target instanceof Element && e.target.closest('input, select, textarea'))) return;
    e.preventDefault();
    openAdd();
  });

  // ---------- new list sheet ----------

  let renaming = null;

  function openListSheet(kind = null) {
    renaming = kind;
    $('list-form').reset();
    $('f-list-name').value = kind ? kind.name : '';
    $('list-sheet-title').textContent = kind ? 'Rename list' : 'New list';
    $('list-submit').textContent = kind ? 'Save' : 'Create';
    $('list-sheet').showModal();
    $('f-list-name').focus();
  }

  $('list-cancel').addEventListener('click', () => $('list-sheet').close());

  $('list-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('f-list-name').value.trim();
    if (!name) return;
    if (renaming) {
      renaming.name = name;
      $('list-sheet').close();
      commit();
      return;
    }
    const kind = { id: uid(), name };
    state.kinds.push(kind);
    save();
    $('list-sheet').close();
    location.hash = `#list/${kind.id}`;
  });

  // ---------- backup ----------

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    el('a', { href: url, download: `to-do-${stamp}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('import').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let incoming;
    try {
      const parsed = JSON.parse(await file.text());
      incoming = normalize(parsed && !parsed.items && (parsed.todos || parsed.books) ? migrateOld(parsed) : parsed);
    } catch {
      showToast('That file isn’t a backup from this app.');
      return;
    }
    const total = incoming.items.length + incoming.countdowns.length;
    const ok = await confirmAction({
      title: 'Replace everything?',
      text: `Everything here will be replaced with the backup (${plural(total, 'item')}).${session ? ' Your other signed-in devices will get it too.' : ''}`,
      ok: 'Replace',
    });
    if (!ok) return;
    hideToast();
    state = incoming;
    commit();
    showToast('Backup restored');
  });

  // Pick up changes made in another tab of the same browser.
  window.addEventListener('storage', (e) => {
    if (e.key === SYNC_KEY) {
      loadSession();
      renderSync();
      return;
    }
    if (e.key !== STORAGE_KEY || document.querySelector('dialog[open]')) return;
    hideToast();
    state = load();
    takeSnapshot();
    render();
  });

  // ---------- sync across devices (optional: needs config.js filled in) ----------

  const SYNC_KEY = 'todo-sync';
  const config = window.TODO_SYNC || {};
  const SYNC = config.url && config.key ? { url: String(config.url).replace(/\/+$/, ''), key: String(config.key) } : null;

  let session = null; // { access_token, refresh_token, expires_at, user: { id, email } }
  let syncStatus = 'idle';
  let syncMessage = '';
  let syncTimer;
  let syncing = false;
  let syncAgain = false;

  function loadSession() {
    try {
      session = JSON.parse(localStorage.getItem(SYNC_KEY));
    } catch {
      session = null;
    }
    if (!session || !session.refresh_token) session = null;
  }

  function storeSession() {
    try {
      if (session) localStorage.setItem(SYNC_KEY, JSON.stringify(session));
      else localStorage.removeItem(SYNC_KEY);
    } catch {
      // Without storage the sign-in lasts for this visit only.
    }
  }

  async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${SYNC.url}${path}`, {
      method,
      headers: {
        apikey: SYNC.key,
        'Content-Type': 'application/json',
        ...(auth && session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; the status code is enough.
    }
    if (!res.ok) {
      const error = new Error((data && (data.msg || data.message || data.error_description || data.error)) || `error ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function setSession(tokens, user) {
    session = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      user: user || (session && session.user) || null,
    };
    storeSession();
  }

  function signOutLocally(message = '') {
    session = null;
    storeSession();
    setSyncStatus('idle', message);
  }

  async function freshToken() {
    if (session.expires_at - Date.now() > 60 * 1000) return;
    try {
      const tokens = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        auth: false,
        body: { refresh_token: session.refresh_token },
      });
      setSession(tokens, tokens.user ? { id: tokens.user.id, email: tokens.user.email } : null);
    } catch (error) {
      if (error.status === 400 || error.status === 401) signOutLocally('Your sign-in expired. Sign in again to keep syncing.');
      throw error;
    }
  }

  // Remote changes wait while you are editing something or a tick is still animating.
  const canApplyRemote = () => !document.querySelector('dialog[open]') && completing.size === 0;

  function applyMerged(merged) {
    if (JSON.stringify(merged) === JSON.stringify(state)) return;
    hideToast(); // an undo from before this merge could otherwise erase what just arrived
    state = merged;
    takeSnapshot();
    persist();
    render();
  }

  function scheduleSync(delay = 800) {
    if (!SYNC || !session) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
  }

  // Pull the saved copy, merge it with this device's, and save the result back.
  // The version number stops two devices from overwriting each other: if another one saved first, merge again.
  async function sync() {
    if (!SYNC || !session || !session.user) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    if (!canApplyRemote()) {
      scheduleSync(1500);
      return;
    }
    syncing = true;
    if (syncStatus !== 'synced') setSyncStatus('syncing');
    try {
      await freshToken();
      const mine = `user_id=eq.${encodeURIComponent(session.user.id)}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        const rows = await request(`/rest/v1/lists?select=data,version&${mine}`);
        const row = rows && rows[0];
        if (!row) {
          try {
            await request('/rest/v1/lists', {
              method: 'POST',
              body: { user_id: session.user.id, data: state, version: 1 },
              headers: { Prefer: 'return=minimal' },
            });
            break;
          } catch (error) {
            if (error.status === 409) continue;
            throw error;
          }
        }
        const remote = normalize(row.data);
        const merged = merge(state, remote);
        if (!canApplyRemote()) {
          syncAgain = true;
          break;
        }
        applyMerged(merged);
        if (JSON.stringify(merged) === JSON.stringify(remote)) break;
        const updated = await request(`/rest/v1/lists?${mine}&version=eq.${row.version}`, {
          method: 'PATCH',
          body: { data: merged, version: row.version + 1, updated_at: new Date().toISOString() },
          headers: { Prefer: 'return=representation' },
        });
        if (updated && updated.length) break;
      }
      setSyncStatus('synced');
    } catch (error) {
      if (!session) return; // signed out because the sign-in expired
      setSyncStatus(error instanceof TypeError ? 'offline' : 'error', error.message);
    } finally {
      syncing = false;
      if (syncAgain) {
        syncAgain = false;
        scheduleSync(500);
      }
    }
  }

  function setSyncStatus(status, message = '') {
    syncStatus = status;
    syncMessage = message;
    renderSync();
  }

  function renderSync() {
    const text = $('sync-text');
    const action = $('sync-action');
    const signOut = $('sync-signout');
    if (!SYNC || !session) {
      text.textContent = syncMessage || 'Saved in this browser only.';
      action.hidden = !SYNC;
      action.textContent = 'Sign in to sync';
      signOut.hidden = true;
      return;
    }
    const who = (session.user && session.user.email) || 'your account';
    text.textContent = {
      syncing: 'Syncing…',
      synced: `Synced as ${who}.`,
      offline: 'Offline. Changes will sync when you’re back.',
      error: `Couldn’t sync${syncMessage ? ` (${syncMessage})` : ''}.`,
    }[syncStatus] || `Signed in as ${who}.`;
    action.hidden = syncStatus !== 'error' && syncStatus !== 'offline';
    action.textContent = 'Try again';
    signOut.hidden = false;
  }

  $('sync-action').addEventListener('click', () => {
    if (session) sync();
    else openSyncSheet();
  });

  $('sync-signout').addEventListener('click', async () => {
    clearTimeout(syncTimer);
    try {
      // "local" ends only this device's sign-in; your other devices stay signed in.
      await request('/auth/v1/logout?scope=local', { method: 'POST' });
    } catch {
      // Signing out on this device is what matters; the server session simply expires.
    }
    signOutLocally();
  });

  // ---------- sign-in sheet ----------

  const syncSheet = $('sync-sheet');

  // Steps: enter your email → the link is sent (tap it on this device) → optionally type a code instead.
  // Supabase's built-in emails contain only the link; a code appears only with a custom email template.
  let signInEmail = '';
  let signInStep = 'email';

  function showSignInStep(step) {
    signInStep = step;
    $('row-email').hidden = step !== 'email';
    $('f-email').required = step === 'email';
    $('row-code').hidden = step !== 'code';
    $('f-code').required = step === 'code';
    $('row-have-code').hidden = step !== 'sent';
    $('sync-restart').hidden = step === 'email';
    const submit = $('sync-submit');
    submit.hidden = step === 'sent';
    submit.disabled = false;
    submit.textContent = step === 'code' ? 'Sign in' : 'Send link';
    $('sync-cancel').textContent = step === 'sent' ? 'Done' : 'Cancel';
    $('sync-note').textContent = {
      email: 'Enter your email and you’ll get a sign-in link. Open it on this device, then do the same on your other devices.',
      sent: `We sent a sign-in link to ${signInEmail}. Open the email on this device and tap the link.`,
      code: `Type the code from the email sent to ${signInEmail}.`,
    }[step];
    ({ email: $('f-email'), sent: $('sync-cancel'), code: $('f-code') })[step].focus();
  }

  $('sync-have-code').addEventListener('click', () => showSignInStep('code'));

  function openSyncSheet() {
    $('sync-form').reset();
    syncSheet.showModal();
    showSignInStep('email');
  }

  $('sync-cancel').addEventListener('click', () => syncSheet.close());

  $('sync-restart').addEventListener('click', () => {
    $('f-code').value = '';
    showSignInStep('email');
    $('f-email').value = signInEmail;
  });

  async function sendSignInEmail() {
    const email = $('f-email').value.trim();
    if (!email) return;
    const submit = $('sync-submit');
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const back = location.origin + location.pathname;
      await request(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, {
        method: 'POST',
        auth: false,
        body: { email, create_user: true },
      });
      signInEmail = email;
      showSignInStep('sent');
    } catch (error) {
      $('sync-note').textContent = `Couldn’t send the link (${error instanceof TypeError ? 'no connection' : error.message}). Try again in a moment.`;
      submit.disabled = false;
      submit.textContent = 'Send link';
    }
  }

  async function verifySignInCode() {
    const token = $('f-code').value.replace(/\s+/g, '');
    if (!/^[0-9]{6,10}$/.test(token)) {
      $('sync-note').textContent = 'Type the code from the email: just the digits.';
      $('f-code').focus();
      return;
    }
    const submit = $('sync-submit');
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const result = await request('/auth/v1/verify', {
        method: 'POST',
        auth: false,
        body: { type: 'email', email: signInEmail, token },
      });
      syncSheet.close();
      completeSignIn(result, result.user);
    } catch (error) {
      $('sync-note').textContent =
        error instanceof TypeError
          ? 'No connection. Try again in a moment.'
          : 'That code didn’t work. Check it, or tap Start over to get a new one.';
      submit.disabled = false;
      submit.textContent = 'Sign in';
      $('f-code').select();
    }
  }

  $('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (signInStep === 'email') sendSignInEmail();
    else if (signInStep === 'code') verifySignInCode();
  });

  // Shared by the code and the link: keep the sign-in, find out who it is, then sync.
  function completeSignIn(tokens, user) {
    setSession(tokens, user ? { id: user.id, email: user.email } : null);
    setSyncStatus('syncing');
    if (session.user) {
      sync();
      return;
    }
    request('/auth/v1/user')
      .then((found) => {
        session.user = { id: found.id, email: found.email };
        storeSession();
        sync();
      })
      .catch((error) => setSyncStatus('error', error.message));
  }

  // Coming back from the email link: the sign-in arrives in the address after "#".
  function finishSignIn() {
    if (!SYNC) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const clean = () => history.replaceState(null, '', `${location.pathname}${location.search}#home`);
    if (params.get('access_token') && params.get('refresh_token')) {
      clean();
      completeSignIn(
        { access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_in: params.get('expires_in') },
        null
      );
    } else if (params.get('error_description') || params.get('error')) {
      clean();
      setSyncStatus('idle', `Sign-in didn’t work (${params.get('error_description') || params.get('error')}). Try sending a new link.`);
    }
  }

  // ---------- go ----------

  loadSession();
  finishSignIn();
  countInPending = currentRoute().name === 'countdowns';
  render();
  renderSync();
  if (session && session.user) sync();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
  window.addEventListener('online', () => sync());
  setInterval(() => {
    if (document.visibilityState === 'visible') sync();
  }, 60 * 1000);
})();
