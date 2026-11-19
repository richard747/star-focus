/* Star Focus timer.
   Remaining time is always (endsAt - Date.now()), never a tick counter.
   When the phone locks or the page is hidden, the clock still moves, and the
   next paint jumps to the right phase. A fresh open more than an hour after
   the saved phase ended does not replay a forgotten night of stars. */
(() => {
  'use strict';

  const STORAGE_KEY = 'star-focus';
  const MIN_MINUTES = 1;
  const MAX_MINUTES = 60;
  const ABANDON_MS = 60 * 60 * 1000;
  const MAX_STARS_PER_CATCHUP = 6;
  const STAR_PATH = 'M12 1.7 14.9 7.8 21.5 8.6 16.6 13.1 17.9 19.7 12 16.5 6.1 19.7 7.4 13.1 2.5 8.6 9.1 7.8Z';

  const phaseLabel = document.getElementById('phase-label');
  const phaseText = document.getElementById('phase-text');
  const phaseHint = document.getElementById('phase-hint');
  const timer = document.getElementById('timer');
  const ring = document.getElementById('ring');
  const timeEl = document.getElementById('time');
  const statusEl = document.getElementById('status');
  const starRow = document.getElementById('star-row');
  const starCaption = document.getElementById('star-caption');
  const primaryBtn = document.getElementById('primary');
  const resetBtn = document.getElementById('reset');
  const skipBtn = document.getElementById('skip');
  const muteBtn = document.getElementById('mute');
  const openSettingsBtn = document.getElementById('open-settings');
  const settings = document.getElementById('settings');
  const workInput = document.getElementById('work-min');
  const breakInput = document.getElementById('break-min');
  const workDec = document.getElementById('work-dec');
  const workInc = document.getElementById('work-inc');
  const breakDec = document.getElementById('break-dec');
  const breakInc = document.getElementById('break-inc');
  const settingsPreview = document.getElementById('settings-preview');
  const chimeToggle = document.getElementById('chime-toggle');
  const clearStarsBtn = document.getElementById('clear-stars');
  const live = document.getElementById('live');

  const state = {
    workMin: 10,
    breakMin: 3,
    muted: false,
    stars: 0,
    phase: 'work',
    mode: 'idle',
    endsAt: null,
    remainingMs: 10 * 60 * 1000,
  };

  let audioCtx = null;
  let audioPrimed = false;
  let wakeLock = null;
  let rafId = 0;
  let intervalId = 0;
  let renderedPhase = null;
  let paintedPhase = null;
  let shownStars = -1;
  let announceTimer = 0;
  let clearArmed = false;
  let clearTimer = 0;

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function durationMs(phase) {
    const minutes = phase === 'break' ? state.breakMin : state.workMin;
    return minutes * 60 * 1000;
  }

  function setFresh() {
    state.mode = 'idle';
    state.phase = 'work';
    state.endsAt = null;
    state.remainingMs = durationMs('work');
  }

  function persist() {
    const payload = {
      workMin: state.workMin,
      breakMin: state.breakMin,
      muted: state.muted,
      stars: state.stars,
      mode: state.mode,
      phase: state.phase,
      endsAt: state.endsAt,
      remainingMs: state.mode === 'running' && state.endsAt != null
        ? Math.max(0, state.endsAt - Date.now())
        : state.remainingMs,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      /* Storage can be blocked. The timer still runs for this visit. */
    }
  }

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') saved = {};
    state.workMin = clampInt(saved.workMin, MIN_MINUTES, MAX_MINUTES, 10);
    state.breakMin = clampInt(saved.breakMin, MIN_MINUTES, MAX_MINUTES, 3);
    state.muted = saved.muted === true;
    state.stars = clampInt(saved.stars, 0, 999, 0);

    const phase = saved.phase === 'break' ? 'break' : 'work';
    if (saved.mode === 'running' && Number.isFinite(saved.endsAt)) {
      if (Date.now() - saved.endsAt > ABANDON_MS) {
        setFresh();
        return;
      }
      state.mode = 'running';
      state.phase = phase;
      state.endsAt = saved.endsAt;
      state.remainingMs = Math.max(0, saved.endsAt - Date.now());
      return;
    }
    if (saved.mode === 'paused') {
      state.mode = 'paused';
      state.phase = phase;
      state.endsAt = null;
      const max = durationMs(phase);
      const rem = Number(saved.remainingMs);
      state.remainingMs = Number.isFinite(rem) ? Math.min(max, Math.max(0, rem)) : max;
      return;
    }
    setFresh();
  }

  function alignFrom(start, phaseAtStart, now) {
    const workLen = durationMs('work');
    const breakLen = durationMs('break');
    const cycle = workLen + breakLen;
    if (cycle <= 0) {
      state.endsAt = now + 60000;
      return;
    }
    const elapsed = Math.max(0, now - start);
    const cycles = Math.floor(elapsed / cycle);
    const rem = elapsed - cycles * cycle;
    const origin = start + cycles * cycle;
    if (phaseAtStart === 'work') {
      if (rem < workLen) {
        state.phase = 'work';
        state.endsAt = origin + workLen;
      } else {
        state.phase = 'break';
        state.endsAt = origin + workLen + breakLen;
      }
    } else if (rem < breakLen) {
      state.phase = 'break';
      state.endsAt = origin + breakLen;
    } else {
      state.phase = 'work';
      state.endsAt = origin + breakLen + workLen;
    }
    if (state.endsAt <= now) state.endsAt = now + 1000;
  }

  function catchUp(now) {
    const at = now == null ? Date.now() : now;
    if (state.mode !== 'running' || state.endsAt == null) {
      return { crossed: 0, gained: 0 };
    }
    if (at < state.endsAt) return { crossed: 0, gained: 0 };

    const starsBefore = state.stars;
    let crossed = 0;
    let guard = 0;
    while (at >= state.endsAt && guard < 4000) {
      if (state.phase === 'work') state.stars = Math.min(999, state.stars + 1);
      state.phase = state.phase === 'work' ? 'break' : 'work';
      const len = durationMs(state.phase);
      if (len <= 0) break;
      state.endsAt += len;
      crossed += 1;
      guard += 1;
    }
    if (guard >= 4000 && at >= state.endsAt) {
      const len = durationMs(state.phase);
      alignFrom(state.endsAt - len, state.phase, at);
      crossed += 1;
    }
    if (state.stars - starsBefore > MAX_STARS_PER_CATCHUP) {
      state.stars = starsBefore + MAX_STARS_PER_CATCHUP;
    }
    const gained = state.stars - starsBefore;
    if (crossed) persist();
    return { crossed, gained };
  }

  function remainingNow(now) {
    const at = now == null ? Date.now() : now;
    if (state.mode === 'running' && state.endsAt != null) {
      return Math.max(0, state.endsAt - at);
    }
    return Math.max(0, state.remainingMs);
  }

  function ceilSeconds(ms) {
    const clamped = Math.max(0, Math.round(ms));
    if (clamped === 0) return 0;
    return Math.floor((clamped + 999) / 1000);
  }

  function formatRemaining(ms) {
    const total = ceilSeconds(ms);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function spoken(ms) {
    const total = ceilSeconds(ms);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    const minutePart = minutes === 1 ? '1 minute' : minutes + ' minutes';
    const secondPart = seconds === 1 ? '1 second' : seconds + ' seconds';
    return minutePart + ' ' + secondPart;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function paintRing(progress) {
    const radius = Number(ring.getAttribute('r'));
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.min(1, Math.max(0, progress));
    ring.dataset.progress = clamped.toFixed(4);
    // A full circle has no dash, so the closed path does not grow a stray cap.
    // A partial ring is a dash of the remaining length only. A dash as long as the
    // whole circumference wraps the seam and leaves a floating rounded cap.
    if (clamped >= 0.999) {
      ring.style.strokeDasharray = 'none';
      ring.style.strokeDashoffset = '0';
      return;
    }
    const visible = circumference * clamped;
    ring.style.strokeDasharray = visible + ' ' + circumference;
    ring.style.strokeDashoffset = '0';
  }

  function renderStars() {
    if (shownStars === state.stars) return;
    const increased = shownStars !== -1 && state.stars > shownStars;
    shownStars = state.stars;
    const slots = 5;
    const filled = Math.min(state.stars, slots);
    const parts = [];
    for (let i = 0; i < slots; i += 1) {
      const on = i < filled;
      const isNew = increased && on && i === filled - 1 && state.stars <= slots;
      const cls = 'star' + (on ? ' is-on' : '') + (isNew ? ' is-new' : '');
      parts.push('<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"></path></svg>');
    }
    starRow.innerHTML = parts.join('');
  }

  function maybePop() {
    if (renderedPhase !== null && renderedPhase !== state.phase) {
      phaseLabel.classList.remove('is-pop');
      void phaseLabel.offsetWidth;
      phaseLabel.classList.add('is-pop');
    }
    renderedPhase = state.phase;
  }

  function syncThemeColor() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg && meta.getAttribute('content') !== bg) meta.setAttribute('content', bg);
  }

  function renderChime() {
    muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', state.muted ? 'Turn chime on' : 'Turn chime off');
    chimeToggle.setAttribute('aria-checked', state.muted ? 'false' : 'true');
    chimeToggle.setAttribute('aria-label', state.muted ? 'Chime off' : 'Chime on');
    setText(chimeToggle, state.muted ? 'Off' : 'On');
  }

  function render() {
    const left = remainingNow();
    const total = durationMs(state.phase);
    const progress = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
    paintRing(progress);

    setText(timeEl, formatRemaining(left));
    const phaseName = state.phase === 'work' ? 'Focus time' : 'Break time';
    setText(phaseText, phaseName);
    setText(phaseHint, state.phase === 'work' ? 'One thing at a time' : 'Rest your eyes');

    let status = 'Ready';
    if (state.mode === 'running') status = state.phase === 'work' ? 'Keep going' : 'Have a rest';
    else if (state.mode === 'paused') status = 'Paused';
    setText(statusEl, status);

    const primary = state.mode === 'running' ? 'Pause' : state.mode === 'paused' ? 'Resume' : 'Start';
    setText(primaryBtn, primary);

    const skipLabel = state.phase === 'work' ? 'Skip to break time' : 'Skip to focus time';
    if (skipBtn.getAttribute('aria-label') !== skipLabel) skipBtn.setAttribute('aria-label', skipLabel);

    const caption = state.stars === 0 ? 'No stars yet' : state.stars === 1 ? '1 star' : state.stars + ' stars';
    setText(starCaption, caption);
    renderStars();

    document.documentElement.dataset.phase = state.phase;
    document.documentElement.dataset.mode = state.mode;

    const label = phaseName + ', ' + spoken(left) + ' remaining';
    if (timer.getAttribute('aria-label') !== label) timer.setAttribute('aria-label', label);

    const title = state.mode === 'idle' ? 'Star Focus' : formatRemaining(left) + ' · ' + (state.phase === 'work' ? 'Focus' : 'Break');
    if (document.title !== title) document.title = title;

    renderChime();
    maybePop();
    if (document.documentElement.dataset.phase !== paintedPhase) {
      paintedPhase = document.documentElement.dataset.phase;
      syncThemeColor();
    }
  }

  function announce(message) {
    window.clearTimeout(announceTimer);
    live.textContent = '';
    announceTimer = window.setTimeout(() => {
      live.textContent = message;
    }, 40);
  }

  function celebrate(gained) {
    chime(state.phase);
    const name = state.phase === 'work' ? 'Focus time.' : 'Break time.';
    let message = name;
    if (gained === 1) message += ' You earned a star.';
    else if (gained > 1) message += ' You earned ' + gained + ' stars.';
    announce(message);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    if (intervalId) window.clearInterval(intervalId);
    rafId = 0;
    intervalId = 0;
  }

  function tick() {
    if (state.mode !== 'running') return;
    const result = catchUp();
    render();
    if (result.crossed) celebrate(result.gained);
  }

  function startLoop() {
    stopLoop();
    const frame = () => {
      if (state.mode !== 'running') return;
      tick();
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);
    intervalId = window.setInterval(tick, 250);
  }

  async function requestWakeLock() {
    if (state.mode !== 'running') return;
    if (!('wakeLock' in navigator)) return;
    if (wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } catch (err) {
      wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    if (!lock) return;
    try {
      await lock.release();
    } catch (err) {
      /* already released */
    }
  }

  function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (!audioPrimed) {
      const buffer = audioCtx.createBuffer(1, 1, 22050);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start();
      audioPrimed = true;
    }
  }

  function tone(ctx, freq, start, duration, peak, type) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function chime(phase) {
    if (state.muted || !audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime + 0.02;
    const rising = phase === 'break';
    const notes = rising ? [392, 523.25, 659.25] : [659.25, 523.25, 392];
    tone(audioCtx, notes[0] / 2, t0, 0.55, 0.03, 'sine');
    notes.forEach((freq, index) => {
      tone(audioCtx, freq, t0 + index * 0.12, 0.62, 0.075, 'sine');
    });
  }

  function begin() {
    state.endsAt = Date.now() + Math.max(0, state.remainingMs);
    state.mode = 'running';
    const result = catchUp();
    if (!result.crossed) state.remainingMs = Math.max(0, state.endsAt - Date.now());
    persist();
    render();
    startLoop();
    requestWakeLock();
    if (result.crossed) celebrate(result.gained);
    else announce((state.phase === 'work' ? 'Focus time' : 'Break time') + ' started.');
  }

  function pause() {
    state.remainingMs = Math.max(0, state.endsAt - Date.now());
    state.endsAt = null;
    state.mode = 'paused';
    stopLoop();
    releaseWakeLock();
    persist();
    render();
    announce('Paused. ' + spoken(state.remainingMs) + ' left.');
  }

  function onPrimary() {
    unlockAudio();
    if (state.mode === 'running') pause();
    else begin();
  }

  function reset() {
    unlockAudio();
    stopLoop();
    releaseWakeLock();
    setFresh();
    persist();
    render();
    announce('Reset. Focus time is ready.');
  }

  function skip() {
    unlockAudio();
    state.phase = state.phase === 'work' ? 'break' : 'work';
    state.remainingMs = durationMs(state.phase);
    if (state.mode === 'running') state.endsAt = Date.now() + state.remainingMs;
    else state.endsAt = null;
    persist();
    render();
    chime(state.phase);
    announce(state.phase === 'work' ? 'Focus time.' : 'Break time.');
  }

  function toggleMute() {
    unlockAudio();
    state.muted = !state.muted;
    persist();
    render();
    if (!state.muted) chime(state.phase);
    announce(state.muted ? 'Chime off.' : 'Chime on.');
  }

  function draftFromInputs() {
    return {
      workMin: clampInt(workInput.value, MIN_MINUTES, MAX_MINUTES, state.workMin),
      breakMin: clampInt(breakInput.value, MIN_MINUTES, MAX_MINUTES, state.breakMin),
    };
  }

  function updatePreview() {
    const draft = draftFromInputs();
    setText(settingsPreview, 'Focus ' + draft.workMin + ' min · Break ' + draft.breakMin + ' min');
  }

  function applyDurationChange() {
    if (state.mode === 'idle') {
      state.remainingMs = durationMs(state.phase);
      state.endsAt = null;
    } else if (state.mode === 'paused') {
      state.remainingMs = Math.min(state.remainingMs, durationMs(state.phase));
    } else if (state.mode === 'running' && state.endsAt != null) {
      const left = state.endsAt - Date.now();
      const max = durationMs(state.phase);
      if (left > max) state.endsAt = Date.now() + max;
    }
    render();
  }

  function commitDraft() {
    const draft = draftFromInputs();
    workInput.value = String(draft.workMin);
    breakInput.value = String(draft.breakMin);
    updatePreview();
    if (draft.workMin === state.workMin && draft.breakMin === state.breakMin) return;
    state.workMin = draft.workMin;
    state.breakMin = draft.breakMin;
    applyDurationChange();
    persist();
  }

  function bump(input, delta) {
    const next = clampInt(Number(input.value) + delta, MIN_MINUTES, MAX_MINUTES, MIN_MINUTES);
    input.value = String(next);
    updatePreview();
    commitDraft();
  }

  function openSettings() {
    unlockAudio();
    workInput.value = String(state.workMin);
    breakInput.value = String(state.breakMin);
    updatePreview();
    renderChime();
    if (typeof settings.showModal === 'function') {
      if (!settings.open) settings.showModal();
    } else {
      settings.setAttribute('open', '');
    }
  }

  function onVisible() {
    if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    const result = catchUp();
    render();
    if (result.crossed) celebrate(result.gained);
    if (state.mode === 'running') {
      startLoop();
      requestWakeLock();
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {
      console.error('Service worker registration failed');
    });
  }

  primaryBtn.addEventListener('click', onPrimary);
  resetBtn.addEventListener('click', reset);
  skipBtn.addEventListener('click', skip);
  muteBtn.addEventListener('click', toggleMute);
  chimeToggle.addEventListener('click', toggleMute);
  openSettingsBtn.addEventListener('click', openSettings);

  workDec.addEventListener('click', () => bump(workInput, -1));
  workInc.addEventListener('click', () => bump(workInput, 1));
  breakDec.addEventListener('click', () => bump(breakInput, -1));
  breakInc.addEventListener('click', () => bump(breakInput, 1));
  workInput.addEventListener('input', updatePreview);
  breakInput.addEventListener('input', updatePreview);
  workInput.addEventListener('change', commitDraft);
  breakInput.addEventListener('change', commitDraft);
  workInput.addEventListener('focus', () => workInput.select());
  breakInput.addEventListener('focus', () => breakInput.select());

  settings.addEventListener('close', commitDraft);
  settings.addEventListener('click', (event) => {
    const rect = settings.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) settings.close();
  });

  clearStarsBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      clearStarsBtn.textContent = 'Tap again to clear stars';
      clearTimer = window.setTimeout(() => {
        clearArmed = false;
        clearStarsBtn.textContent = 'Clear stars';
      }, 2500);
      return;
    }
    window.clearTimeout(clearTimer);
    clearArmed = false;
    clearStarsBtn.textContent = 'Clear stars';
    state.stars = 0;
    shownStars = -1;
    persist();
    render();
    announce('Stars cleared.');
  });

  document.addEventListener('pointerdown', () => {
    unlockAudio();
    if (state.mode === 'running') requestWakeLock();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persist();
      return;
    }
    onVisible();
  });

  window.addEventListener('pageshow', onVisible);
  window.addEventListener('pagehide', persist);

  load();
  catchUp();
  render();
  if (state.mode === 'running') {
    startLoop();
    requestWakeLock();
  }

  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker);
})();
