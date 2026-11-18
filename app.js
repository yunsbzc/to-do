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
      return { id: k.id, name: str(saved && saved.name).trim() || k.name };
    });
    for (const k of arr(data.kinds)) {
      const id = str(k && k.id);
      const name = str(k && k.name).trim();
      if (id && name && id !== COUNTDOWN && !kinds.some((x) => x.id === id)) kinds.push({ id, name });
    }

    const items = arr(data.items)
      .filter((i) => i && str(i.title).trim())
      .map((i) => {
        const state = STATES.includes(i.state) ? i.state : 'open';
        return {
          id: str(i.id) || uid(),
          kind: kinds.some((k) => k.id === i.kind) ? i.kind : 'do',
          title: str(i.title).trim(),
          note: str(i.note).trim(),
          due: parseDate(str(i.due)) ? i.due : '',
          state,
          next: state !== 'done' && !!i.next,
          createdAt: num(i.createdAt) ?? Date.now(),
          doneAt: state === 'done' ? num(i.doneAt) ?? Date.now() : null,
        };
      });

    const countdowns = arr(data.countdowns)
      .filter((c) => c && str(c.name).trim() && parseDate(str(c.date)))
      .map((c) => ({ id: str(c.id) || uid(), name: str(c.name).trim(), date: c.date }));

    return { kinds, items, countdowns };
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

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable (e.g. private mode): the page still works for this visit.
    }
  }

  let state = load();
  let doneFilter = 'all';
  const completing = new Set(); // ids of to-dos mid-way through the completion animation
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let countMode = 'days'; // how the hero countdown counts; tapping the numeral cycles it
  let countInPending = false; // play the count-in once each time the Countdowns page is opened

  // ---------- helpers ----------

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
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

  // Applies a change, then offers to take it back for a few seconds.
  function changeWithUndo(message, mutate) {
    const before = JSON.stringify(state);
    mutate();
    commit();
    $('toast-text').textContent = message;
    undoAction = () => {
      state = normalize(JSON.parse(before));
      commit();
    };
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
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
  function openButton(label, title, sub, tag, onclick) {
    const button = el(
      'button',
      { type: 'button', className: 'open', ariaLabel: label, onclick },
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
    const li = el('li', { className: pending ? 'completing' : '' });
    const tick = el('input', {
      type: 'checkbox',
      checked: pending,
      disabled: pending,
      ariaLabel: `Mark ${item.title} as done`,
      onchange: () => completeItem(item, li, tick),
    });

    li.append(
      el('label', { className: 'tick' }, tick),
      openButton(`Edit ${item.title}`, item.title, sub, dueBadge(item), () => openSheet({ item })),
      ...[showFlag && el('button', {
          type: 'button',
          className: 'flag',
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
      { className: days < 0 ? 'past' : '' },
      el(
        'button',
        { type: 'button', className: 'open', ariaLabel: `Edit ${c.name}`, onclick: () => openSheet({ countdown: c }) },
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
        { className: 'list-link', href },
        el('span', { className: 'title', textContent: title }),
        el('span', { className: 'count', textContent: String(count) })
      )
    );
  }

  const backHome = () => el('a', { className: 'eyebrow', href: '#home', textContent: '‹ Home' });

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
        .map((i) => ({ days: daysUntil(i.due), title: i.title, sub: kindName(i.kind), open: () => openSheet({ item: i }) })),
      ...state.countdowns
        .filter((c) => !nextEvent || c !== nextEvent.c)
        .map((c) => ({ days: daysUntil(c.date), title: c.name, sub: 'Countdown', open: () => openSheet({ countdown: c }) }))
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
            el('li', {}, openButton(`Edit ${c.title}`, c.title, c.sub, dueTag(c.days), c.open))
          )
        )
      );
    }

    nodes.push(
      ...section(
        'Lists',
        state.kinds.map((k) =>
          linkRow(`#list/${encodeURIComponent(k.id)}`, k.name, active.filter((i) => i.kind === k.id).length)
        )
      ),
      el(
        'div',
        { className: 'view-actions' },
        el('button', { type: 'button', className: 'text-button', textContent: 'New list', onclick: () => openListSheet() })
      ),
      ...section('More', [
        linkRow('#countdowns', 'Countdowns', state.countdowns.filter((c) => daysUntil(c.date) >= 0).length),
        linkRow('#done', 'Done', state.items.length - active.length),
      ])
    );

    return nodes;
  }

  function listView(kind) {
    const items = state.items.filter((i) => i.kind === kind.id && i.state !== 'done');
    const doing = items.filter((i) => i.state === 'doing');
    const open = items.filter((i) => i.state === 'open');
    const row = (i) => itemRow(i, { showFlag: true });

    const nodes = [head(backHome(), kind.name, items.length ? `${items.length} to do` : '')];

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
        el('button', { type: 'button', className: 'text-button', textContent: 'Rename list', onclick: () => openListSheet(kind) }),
        !DEFAULT_KINDS.some((k) => k.id === kind.id) &&
          el('button', {
            type: 'button',
            className: 'text-button',
            textContent: 'Delete this list',
            onclick: () => {
              changeWithUndo(`${quote(kind.name)} list deleted`, () => {
                state.kinds = state.kinds.filter((k) => k.id !== kind.id);
                state.items = state.items.filter((i) => i.kind !== kind.id);
              });
              location.hash = '#home';
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
      { type: 'button', className: 'hero-event', ariaLabel: `Edit ${c.name}`, onclick: () => openSheet({ countdown: c }) },
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
      const nodes = [head(backHome(), 'Countdowns', '')];
      if (!all.length) nodes.push(emptyState('Nothing to look forward to yet. Press + to add a date.'));
      if (past.length) nodes.push(...section('Past', past.map((i) => countdownRow(i.c, i.days))));
      return nodes;
    }

    // The soonest event gets the page; the page title is kept for screen readers.
    const nodes = [
      el('header', { className: 'view-head' }, backHome(), el('h1', { className: 'sr-only', textContent: 'Countdowns' })),
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

    const nodes = [head(backHome(), 'Done', allDone.length ? `${allDone.length} finished` : '')];

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
                  onchange: () =>
                    changeWithUndo(`${quote(item.title)} moved back to ${kindName(item.kind)}`, () => {
                      item.state = 'open';
                      item.doneAt = null;
                    }),
                })
              ),
              el(
                'button',
                { type: 'button', className: 'open', ariaLabel: `Edit ${item.title}`, onclick: () => openSheet({ item }) },
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
    if (hash === 'countdowns' || hash === 'done') return { name: hash };
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

  function render() {
    renderedDay = startOfToday().toDateString();
    const route = currentRoute();
    const views = {
      home: () => ['To Do', homeView()],
      list: () => [`${route.kind.name} · To Do`, listView(route.kind)],
      countdowns: () => ['Countdowns · To Do', countdownsView()],
      done: () => ['Done · To Do', doneView()],
    };
    const [title, nodes] = views[route.name]();
    document.title = title;
    $('view').replaceChildren(...nodes);
  }

  window.addEventListener('hashchange', () => {
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

  function syncSheetMode() {
    const isCountdown = currentKind() === COUNTDOWN;
    const editingItem = !!(editing && editing.item);
    $('row-note').hidden = isCountdown;
    $('row-next').hidden = isCountdown;
    $('row-state').hidden = !editingItem;
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

    $('sheet-form').reset();

    // Kind chips. A countdown can't become a to-do (or back), so they are locked when editing one.
    const selected = item ? item.kind : countdown ? COUNTDOWN : kind;
    const options = [...state.kinds.map((k) => [k.id, k.name]), ...(item ? [] : [[COUNTDOWN, 'Countdown']])];
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

  $('f-kind').addEventListener('change', syncSheetMode);
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
      if (editing && editing.countdown) Object.assign(editing.countdown, { name: title, date: due });
      else state.countdowns.push({ id: uid(), name: title, date: due });
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
      if (editing && editing.item) {
        const item = editing.item;
        fields.doneAt = newState === 'done' ? item.doneAt ?? Date.now() : null;
        Object.assign(item, fields);
      } else {
        state.items.unshift({ id: uid(), createdAt: Date.now(), doneAt: null, ...fields });
      }
    }

    sheet.close();
    commit();
  });

  $('sheet-delete').addEventListener('click', () => {
    if (!editing) return;
    const { item, countdown } = editing;
    sheet.close();
    changeWithUndo(`${quote(item ? item.title : countdown.name)} deleted`, () => {
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
      alert("That file doesn't look like a backup from this page.");
      return;
    }
    const total = incoming.items.length + incoming.countdowns.length;
    if (!confirm(`Replace everything here with the backup (${plural(total, 'item')})?`)) return;
    hideToast();
    state = incoming;
    commit();
  });

  // Pick up changes made in another tab of the same browser.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || document.querySelector('dialog[open]')) return;
    hideToast();
    state = load();
    render();
  });

  // ---------- go ----------

  countInPending = currentRoute().name === 'countdowns';
  render();
})();
