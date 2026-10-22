// @ts-nocheck -- UI glue like routines-view.js; routines-data.js holds the checked, tested model of the When row.
// ui-src/src/chat/when-row.js. The "When" row (days, then times, then a plain preview of the next two runs), shared by the
// routine sheet and the reading radar sheet. `whenRowMethods` are mixed into each sheet class, so both read `this.when`
// (routines-data.js When), `this.whenBox` and `this.e`, and call `this.paintWhen()` whenever a choice changes which controls show.
import { installStyle } from './dom-helpers.js';
import { DAY_KINDS, PICK_DAYS, MAX_TIMES, nextFreeTime, ordinal, previewText, scheduleProblem, scheduleFromWhen } from './routines-data.js';

export const whenRowMethods = {
  /** The When row: rebuilt whenever a choice changes which controls show; the preview alone refreshes while typing. */
  paintWhen() {
    const w = this.when;
    const box = this.whenBox;
    box.replaceChildren();
    const select = (cls, options, value, onChange) => {
      const pick = this.e('select', `sb-sk-in ${cls}`);
      for (const [v, l] of options) { const o = this.e('option', '', l); o.value = String(v); pick.append(o); }
      pick.value = String(value);
      pick.addEventListener('change', () => { onChange(pick.value); this.paintWhen(); });
      return pick;
    };
    const input = (cls, type, value, onInput, extra = {}) => {
      const i = this.e('input', `sb-sk-in ${cls}`);
      i.type = type; i.value = value;
      Object.assign(i, extra);
      i.addEventListener('input', () => { onInput(i.value); this.syncPreview(); });
      return i;
    };
    const row = (...nodes) => { const r = this.e('div', 'sb-rt-whenrow'); r.append(...nodes); box.append(r); return r; };

    const daysRow = row(select('sb-rt-days', DAY_KINDS, w.days, (v) => { w.days = v; }));
    if (w.days === 'some') {
      for (const [id, label] of PICK_DAYS) {
        const on = w.weekdays.includes(id);
        const b = this.e('button', `sb-rt-source${on ? ' is-on' : ''}`, label);
        b.setAttribute('type', 'button'); b.dataset.weekday = String(id); b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => {
          w.weekdays = w.weekdays.includes(id) ? w.weekdays.filter((d) => d !== id) : [...w.weekdays, id];
          b.classList.toggle('is-on', w.weekdays.includes(id)); b.setAttribute('aria-pressed', String(w.weekdays.includes(id))); this.syncPreview();
        });
        daysRow.append(b);
      }
    } else if (w.days === 'every') {
      daysRow.append(this.e('span', 'sb-rt-at', 'every'), input('sb-rt-n', 'number', String(w.n), (v) => { w.n = Number(v); }, { min: '2', max: '30' }),
        this.e('span', 'sb-rt-at', 'days, starting'), input('sb-rt-from', 'date', w.from, (v) => { w.from = v; }));
    } else if (w.days === 'monthly') {
      const opts = [...Array.from({ length: 28 }, (_, i) => [i + 1, `the ${ordinal(i + 1)}`]), [-1, 'the last day']];
      for (const extra of [29, 30, 31]) if (w.day === extra) opts.push([extra, `day ${extra}`]);
      daysRow.append(this.e('span', 'sb-rt-at', 'on'), select('sb-rt-day', opts, w.day, (v) => { w.day = Number(v); }));
    }

    const timesRow = row(select('sb-rt-mode', [['at', 'At set times'], ['hourly', 'Every few hours']], w.mode, (v) => { w.mode = v; }));
    if (w.mode === 'at') {
      w.times.forEach((time, index) => {
        const chip = this.e('span', 'sb-rt-timechip');
        const t = input('sb-rt-time', 'time', time, (v) => { w.times[index] = v; });
        const x = this.e('button', 'sb-rt-source sb-rt-timex', '\u00d7');
        x.setAttribute('type', 'button'); x.setAttribute('aria-label', `Remove ${time}`); x.disabled = w.times.length < 2;
        x.addEventListener('click', () => { w.times.splice(index, 1); this.paintWhen(); });
        chip.append(t, x);
        timesRow.append(chip);
      });
      const add = this.e('button', 'sb-rt-source sb-rt-addtime', '+ Add time');
      add.setAttribute('type', 'button'); add.disabled = w.times.length >= MAX_TIMES;
      add.addEventListener('click', () => { w.times.push(nextFreeTime(w.times)); this.paintWhen(); });
      timesRow.append(add);
    } else {
      timesRow.append(this.e('span', 'sb-rt-at', 'every'), input('sb-rt-hours', 'number', String(w.every), (v) => { w.every = Number(v); }, { min: '1', max: '12' }),
        this.e('span', 'sb-rt-at', 'hours between'), input('sb-rt-time sb-rt-hfrom', 'time', w.hFrom, (v) => { w.hFrom = v; }),
        this.e('span', 'sb-rt-at', 'and'), input('sb-rt-time sb-rt-hto', 'time', w.hTo, (v) => { w.hTo = v; }));
    }
    this.previewLine = this.e('div', 'sb-rt-preview');
    box.append(this.previewLine);
    this.syncPreview();
  },

  syncPreview() {
    const schedule = scheduleFromWhen(this.when);
    const problem = scheduleProblem(schedule);
    this.previewLine.classList.toggle('is-error', Boolean(problem));
    this.previewLine.textContent = problem ?? previewText(schedule);
  }
};

export function installWhenStyle(doc) {
  installStyle(doc, 'second-brain-when-row-style', WHEN_CSS);
}

// Obsidian gives every button a nowrap label, a fill and a fixed height: the day pills need `white-space: normal`.
const WHEN_CSS = `
.sb-rt-when { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.sb-ai .sb-rt-source { white-space: normal; height: auto; box-shadow: none; font: inherit; cursor: pointer; padding: 3px 10px; border: 1px solid var(--sb-ui-line); border-radius: 12px; background: transparent; color: var(--sb-ui-muted); }
.sb-ai .sb-rt-source.is-on { background: var(--sb-ui-hover); color: var(--sb-ui-text); border-color: var(--sb-ui-accent); }
.sb-rt-whenrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sb-rt-when .sb-sk-in, .sb-rt-when .sb-rt-time { width: auto; }
.sb-rt-when .sb-rt-n, .sb-rt-when .sb-rt-hours { width: 4.5em; }
.sb-rt-timechip { display: inline-flex; align-items: center; gap: 2px; }
.sb-ai .sb-rt-source:disabled { opacity: 0.45; cursor: default; }
.sb-rt-preview { color: var(--sb-ui-muted); font-size: 12px; overflow-wrap: anywhere; }
.sb-rt-preview.is-error { color: var(--sb-ui-danger); }
.sb-rt-at { color: var(--sb-ui-muted); }
`;
