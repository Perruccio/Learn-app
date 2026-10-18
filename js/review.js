// Flashcard review session (spaced repetition with FSRS).

import { $, el, clamp, toast } from './util.js?v=3d7374a80e17';
import {
  NEW_PER_DAY,
  Rating,
  State,
  dayKey,
  deviceId,
  fromFsrsCard,
  humanInterval,
  isDue,
  isNew,
  newIntroducedToday,
  renderRich,
  scheduler,
  toFsrsCard,
} from './cards.js?v=3d7374a80e17';

const RATINGS = [
  { rating: Rating.Again, label: 'Di nuovo', key: '1', cls: 'again' },
  { rating: Rating.Hard, label: 'Difficile', key: '2', cls: 'hard' },
  { rating: Rating.Good, label: 'Bene', key: '3', cls: 'good' },
  { rating: Rating.Easy, label: 'Facile', key: '4', cls: 'easy' },
];
const REQUEUE_WINDOW_MS = 20 * 60 * 1000;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Counts for the library summary: {due, fresh, total, byDeck: {deck: {due, fresh}}}. */
export function summarize(decks, sync, now = Date.now()) {
  const out = { due: 0, fresh: 0, total: decks.cards.length, byDeck: {} };
  const newLeft = {};
  for (const card of decks.cards) {
    const doc = sync.load(card.dir).doc;
    newLeft[card.dir] ??= Math.max(0, NEW_PER_DAY - newIntroducedToday(doc, now));
    const s = doc.cards[card.id];
    const deck = (out.byDeck[card.deck || card.stem] ??= { due: 0, fresh: 0 });
    if (isNew(s)) {
      if (newLeft[card.dir] > 0) {
        newLeft[card.dir]--;
        out.fresh++;
        deck.fresh++;
      }
    } else if (isDue(s, now)) {
      out.due++;
      deck.due++;
    }
  }
  return out;
}

export class ReviewSession {
  constructor({ sync, onExit }) {
    this.sync = sync;
    this.onExit = onExit;
    this.root = $('#view-review');
    this.queue = [];
    this.current = null;
    this.revealed = false;
    this.history = [];
    this.done = 0;
    this._bind();
  }

  attach(sync) {
    this.sync = sync;
  }

  // ------------------------------------------------------------------ queue

  start(decks) {
    const now = Date.now();
    const learning = [];
    const reviews = [];
    const fresh = [];
    const newLeft = {};
    for (const card of decks.cards) {
      const doc = this.sync.load(card.dir).doc;
      newLeft[card.dir] ??= Math.max(0, NEW_PER_DAY - newIntroducedToday(doc, now));
      const s = doc.cards[card.id];
      if (isNew(s)) {
        if (newLeft[card.dir] > 0) {
          newLeft[card.dir]--;
          fresh.push(card);
        }
      } else if (isDue(s, now)) {
        (s.state === State.Review ? reviews : learning).push(card);
      }
    }
    // Interleave: learning first, then reviews from all decks shuffled, with a new card every 3 reviews.
    const mixed = [];
    const rev = shuffle(reviews);
    let n = 0;
    while (rev.length || fresh.length) {
      if (fresh.length && (n % 4 === 3 || !rev.length)) mixed.push(fresh.shift());
      else mixed.push(rev.shift());
      n++;
    }
    this.queue = [...learning, ...mixed].map((card) => ({ card, readyAt: 0 }));
    this.history = [];
    this.done = 0;
    this._next();
  }

  _next() {
    const now = Date.now();
    let i = this.queue.findIndex((q) => q.readyAt <= now);
    if (i < 0 && this.queue.length) {
      // Only cards still in their learning step are left: show the earliest one.
      i = this.queue.reduce((best, q, k) => (q.readyAt < this.queue[best].readyAt ? k : best), 0);
    }
    this.current = i >= 0 ? this.queue.splice(i, 1)[0].card : null;
    this.revealed = false;
    this._render();
  }

  rate(rating) {
    if (!this.current || !this.revealed) return;
    const card = this.current;
    const now = new Date();
    const doc = this.sync.load(card.dir).doc;
    const before = doc.cards[card.id] || null;
    const wasNew = isNew(before);
    const result = scheduler.next(toFsrsCard(before, now), now, rating);
    const after = fromFsrsCard(card.id, result.card);
    const day = dayKey(now.getTime());
    const device = deviceId();
    this.history.push({ card, before, wasNew, day, device, queue: this.queue.map((q) => ({ ...q })) });
    if (this.history.length > 30) this.history.shift();
    this.sync.mutate(
      card.dir,
      (d) => {
        d.cards[card.id] = after;
        d.days[day] ??= {};
        const c = (d.days[day][device] ??= { reviews: 0, new: 0 });
        c.reviews++;
        if (wasNew) c.new++;
      },
      { silent: true },
    );
    if (after.due - now.getTime() < REQUEUE_WINDOW_MS) this.queue.push({ card, readyAt: after.due });
    this.done++;
    this._next();
  }

  undo() {
    const last = this.history.pop();
    if (!last) return;
    const { card, before, wasNew, day, device } = last;
    this.sync.mutate(
      card.dir,
      (d) => {
        // Restore the previous state with a fresh timestamp so the undo wins the merge.
        d.cards[card.id] = before
          ? { ...before, updatedAt: Date.now() }
          : { ...fromFsrsCard(card.id, toFsrsCard(null)), updatedAt: Date.now() };
        const c = d.days[day]?.[device];
        if (c) {
          c.reviews = Math.max(0, c.reviews - 1);
          if (wasNew) c.new = Math.max(0, c.new - 1);
        }
      },
      { silent: true },
    );
    if (this.current) last.queue.unshift({ card: this.current, readyAt: 0 });
    this.queue = last.queue;
    this.current = card;
    this.revealed = false;
    this.done = Math.max(0, this.done - 1);
    this._render();
  }

  reveal() {
    if (!this.current || this.revealed) return;
    this.revealed = true;
    this._render();
  }

  // ------------------------------------------------------------------ UI

  _bind() {
    $('#review-card').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      this.reveal();
    });
    $('#review-show').addEventListener('click', () => this.reveal());
    $('#review-undo').addEventListener('click', () => this.undo());
    $('#review-back').addEventListener('click', () => this.onExit());
    $('#review-finish').addEventListener('click', () => this.onExit());
    const bar = $('#review-ratings');
    for (const r of RATINGS) {
      bar.append(
        el(
          'button',
          { type: 'button', class: `rate rate-${r.cls}`, dataset: { rating: r.rating }, onclick: () => this.rate(r.rating) },
          el('span', { class: 'rate-label' }, r.label),
          el('span', { class: 'rate-ivl' }),
        ),
      );
    }
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden || e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === ' ' || e.key === 'Enter') && !this.revealed) {
        e.preventDefault();
        this.reveal();
      } else if (this.revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        this.rate(Number(e.key));
      } else if (e.key === ' ' && this.revealed) {
        e.preventDefault();
        this.rate(Rating.Good);
      } else if (e.key === 'z' || e.key === 'u') {
        this.undo();
      } else if (e.key === 'Escape') {
        this.onExit();
      }
    });
  }

  _render() {
    const card = this.current;
    $('#review-undo').disabled = this.history.length === 0;
    const remaining = this.queue.length + (card ? 1 : 0);
    $('#review-count').textContent = card ? `${remaining} da fare · ${this.done} fatte` : '';
    $('#review-done').hidden = !!card;
    $('#review-stage').hidden = !card;
    if (!card) {
      $('#review-done-text').textContent =
        this.done === 0 ? 'Niente da ripassare adesso.' : `Hai ripassato ${this.done} ${this.done === 1 ? 'carta' : 'carte'}.`;
      return;
    }
    const doc = this.sync.load(card.dir).doc;
    const s = doc.cards[card.id];
    $('#review-meta').textContent = [card.deck, card.stem, isNew(s) ? 'nuova' : null].filter(Boolean).join(' · ');
    renderRich($('#review-front'), card.front);
    const back = $('#review-back-text');
    back.hidden = !this.revealed;
    $('#review-divider').hidden = !this.revealed;
    if (this.revealed) renderRich(back, card.back);
    $('#review-show').hidden = this.revealed;
    $('#review-ratings').hidden = !this.revealed;
    if (this.revealed) {
      const now = new Date();
      const preview = scheduler.repeat(toFsrsCard(s, now), now);
      for (const b of $('#review-ratings').children) {
        const r = Number(b.dataset.rating);
        b.querySelector('.rate-ivl').textContent = humanInterval(clamp(preview[r].card.due.getTime() - now.getTime(), 0, Infinity));
      }
    }
  }
}

export function warnIfLocked(decks) {
  if (!decks.cards.length && decks.locked) toast('Le carte si sbloccano quando segni come fatta la sessione corrispondente.');
}
