/* ============================================================
   WHO KNOWS WHO BETTER? ❤️ — two-player heart-sync quiz
   UI + gameplay controller. Transport lives in js/backend/*,
   room rules in js/room-service.js, strings in js/i18n.js.
   ============================================================ */
'use strict';

import { QUESTION_BANK } from './js/question-bank.js';
import { STR } from './js/i18n.js';
import { getBackend, getLocalBackend, isFirebaseConfigured } from './js/backend/index.js';
import { RoomService, ANSWER_MS, AUTO_GRACE_MS, roleOf } from './js/room-service.js';
import { createAudioEngine } from './js/audio.js';
import { downloadScoreCard, shareResults, compatibility } from './js/share-card.js';

/* ───────── Helpers ───────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), tpl);
const otherRole = (role) => (role === 'host' ? 'guest' : 'host');
const CATEGORIES = ['favorites', 'food', 'love', 'personality', 'memories', 'daily', 'funny'];
const CAT_KEYS = {
  favorites: 'catFavorites', food: 'catFood', love: 'catLove', personality: 'catPersonality',
  memories: 'catMemories', daily: 'catDaily', funny: 'catFunny',
};
const PREFS = { theme: 'wkhwb-theme', lang: 'wkhwb-lang', name: 'wkhwb-pname', avatar: 'wkhwb-avatar', avatarMode: 'wkhwb-avatar-mode', photo: 'wkhwb-profile-photo', muted: 'wkhwb-muted', volume: 'wkhwb-volume' };
const PACKS_KEY = 'wkhwb-packs-v2';
const ACTIVE_PACK_KEY = 'wkhwb-active-pack-v2';
const ERROR_KEYS = {
  notfound: 'errRoomNotFound', full: 'errRoomFull', started: 'errRoomStarted', expired: 'errRoomNotFound',
  answered: 'errAlreadyAnswered', late: 'errAnswerLate', access: 'errGeneric', waiting: 'errRoomNotFound',
  conflict: 'errGeneric', notready: 'errGeneric', early: 'errGeneric',
};

const t = (key) => STR[state.lang][key] || key;
const fillT = (key, vars) => fill(t(key), vars);
const nowMs = () => (state.service ? state.service.now() : Date.now());

/* ───────── State ───────── */
const state = {
  lang: 'en',
  muted: false,
  uid: null,
  backend: null,
  service: null,
  connectionStatus: 'connecting',
  localBannerDismissed: false,
  roomCode: null,
  roomUnsub: null,
  room: null,
  role: null,
  createSource: 'builtin',
  createCount: 20,
  createCategory: 'all',
  createAvatar: '🐻',
  joinAvatar: '🐰',
  profilePhoto: '',
  avatarMode: 'emoji',
  autoTried: new Set(),
  autoGameId: null,
  renderedKey: null,
  lastRevealIndex: -1,
  reactionTimer: null,
  timerRaf: null,
  audioRevealKey: null,
  revealSceneTimer: null,
  presenceTimer: null,
  awayTimer: null,
  resultsCelebrated: false,
  resultsRoomId: null,
  packs: [],
  activePackId: null,
  editingId: null,
  loadingDepth: 0,
  confirmResolve: null,
  packResolve: null,
};

const audio = createAudioEngine();

/* ───────── Prefs + packs (local persistence) ───────── */
function savePref(k, v) { try { localStorage.setItem(PREFS[k], v); } catch { /* ignore */ } }
function loadPref(k) { try { return localStorage.getItem(PREFS[k]); } catch { return null; } }

function newPack(name) {
  return { id: 'p_' + Math.random().toString(36).slice(2, 10), name, questions: [] };
}
function loadPacks() {
  let packs = [];
  try { packs = JSON.parse(localStorage.getItem(PACKS_KEY) || '[]'); } catch { packs = []; }
  if (!Array.isArray(packs) || !packs.length) {
    packs = [newPack(STR[state.lang].packDefault)];
  }
  state.packs = packs.map((p) => ({
    id: p.id || 'p_' + Math.random().toString(36).slice(2, 10),
    name: p.name || STR[state.lang].packDefault,
    questions: Array.isArray(p.questions) ? p.questions : [],
  }));
  const savedActive = loadPref(ACTIVE_PACK_KEY);
  state.activePackId = state.packs.some((p) => p.id === savedActive) ? savedActive : state.packs[0].id;
}
function savePacks() {
  try {
    localStorage.setItem(PACKS_KEY, JSON.stringify(state.packs));
    localStorage.setItem(ACTIVE_PACK_KEY, state.activePackId);
  } catch { /* storage full/blocked */ }
}
function activePack() {
  return state.packs.find((p) => p.id === state.activePackId) || state.packs[0];
}
function activeQuestions() {
  return activePack()?.questions || [];
}
function catLabel(cat) { return t(CAT_KEYS[cat] || 'catFavorites'); }

/* ───────── Premium custom dropdowns ───────── */
const customDropdowns = new Map();
const CHECK_SVG = '<svg class="custom-dropdown-check" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 10"/></svg>';
const CHEVRON_SVG = '<svg class="custom-dropdown-chevron" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

function enabledDropdownOptions(dd) {
  return [...dd.menu.querySelectorAll('.custom-dropdown-option:not(.is-disabled)')];
}
function refreshCustomDropdown(select) {
  const dd = customDropdowns.get(select);
  if (!dd) return;
  const previousValue = select.value;
  dd.menu.innerHTML = '';
  [...select.options].forEach((option, index) => {
    const item = document.createElement('div');
    item.className = 'custom-dropdown-option';
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '-1');
    item.dataset.index = String(index);
    item.setAttribute('aria-selected', String(option.selected));
    if (option.disabled) item.classList.add('is-disabled');
    item.innerHTML = `<span class="custom-dropdown-option-label">${esc(option.textContent)}</span>${CHECK_SVG}`;
    item.addEventListener('click', () => {
      if (option.disabled) return;
      selectDropdownValue(dd, index);
    });
    item.addEventListener('mouseenter', () => setActiveDropdownOption(dd, item));
    dd.menu.appendChild(item);
  });
  if (!dd.menu.children.length) {
    const empty = document.createElement('div');
    empty.className = 'custom-dropdown-empty';
    empty.textContent = '—';
    dd.menu.appendChild(empty);
  }
  if ([...select.options].some((option) => option.value === previousValue)) select.value = previousValue;
  syncCustomDropdown(select);
}
function syncCustomDropdown(select) {
  const dd = customDropdowns.get(select);
  if (!dd) return;
  const selected = select.selectedOptions[0];
  dd.label.textContent = selected ? selected.textContent : '';
  dd.toggle.disabled = select.disabled;
  [...dd.menu.children].forEach((item) => {
    if (!item.classList.contains('custom-dropdown-option')) return;
    const option = select.options[Number(item.dataset.index)];
    const selectedOption = Boolean(option && option.selected);
    item.classList.toggle('is-selected', selectedOption);
    item.setAttribute('aria-selected', String(selectedOption));
  });
}
function positionCustomDropdown(dd) {
  const rect = dd.toggle.getBoundingClientRect();
  const width = Math.max(rect.width, Math.min(320, window.innerWidth - 24));
  dd.menu.style.width = `${Math.min(width, window.innerWidth - 24)}px`;
  dd.menu.style.left = `${Math.min(Math.max(12, rect.left), window.innerWidth - parseFloat(dd.menu.style.width) - 12)}px`;
  const menuHeight = Math.min(dd.menu.scrollHeight, 240, window.innerHeight * .48);
  const below = window.innerHeight - rect.bottom - 10;
  const above = rect.top - 10;
  const top = below >= menuHeight || below >= above ? rect.bottom + 8 : rect.top - menuHeight - 8;
  dd.menu.style.top = `${Math.max(8, top)}px`;
  dd.menu.style.maxHeight = `${Math.min(240, window.innerHeight - 16)}px`;
}
function setActiveDropdownOption(dd, item) {
  [...dd.menu.querySelectorAll('.custom-dropdown-option')].forEach((option) => option.classList.toggle('is-active', option === item));
  dd.activeOption = item || null;
}
function closeAllCustomDropdowns(except = null, restoreFocus = false) {
  customDropdowns.forEach((dd) => {
    if (except && dd === except) return;
    if (!dd.isOpen) return;
    dd.isOpen = false;
    dd.toggle.setAttribute('aria-expanded', 'false');
    dd.menu.classList.remove('is-open');
    if (restoreFocus) dd.toggle.focus();
  });
}
function openCustomDropdown(dd, direction = 'selected') {
  closeAllCustomDropdowns(dd);
  positionCustomDropdown(dd);
  dd.isOpen = true;
  dd.toggle.setAttribute('aria-expanded', 'true');
  dd.menu.classList.add('is-open');
  const options = enabledDropdownOptions(dd);
  const selected = options.find((item) => item.classList.contains('is-selected'));
  const index = direction === 'last' ? options.length - 1 : direction === 'first' ? 0 : Math.max(0, options.indexOf(selected));
  setActiveDropdownOption(dd, options[index] || null);
  options[index]?.focus({ preventScroll: true });
}
function toggleCustomDropdown(dd) {
  if (dd.isOpen) closeAllCustomDropdowns(null, true);
  else openCustomDropdown(dd);
}
function selectDropdownValue(dd, nativeIndex, restoreFocus = true) {
  if (!dd.select.options[nativeIndex]) return;
  dd.select.selectedIndex = nativeIndex;
  syncCustomDropdown(dd.select);
  dd.select.dispatchEvent(new Event('change', { bubbles: true }));
  closeAllCustomDropdowns();
  if (restoreFocus) dd.toggle.focus();
}
function stepCustomDropdown(dd, direction) {
  const options = enabledDropdownOptions(dd);
  if (!options.length) return;
  const current = options.indexOf(dd.activeOption);
  const next = current < 0 ? (direction > 0 ? 0 : options.length - 1) : (current + direction + options.length) % options.length;
  setActiveDropdownOption(dd, options[next]);
  options[next].focus({ preventScroll: true });
}
function createCustomDropdown(select) {
  if (!select || customDropdowns.has(select)) return;
  const label = select.id ? document.querySelector(`label[for="${select.id}"]`) : null;
  const wrapper = document.createElement('div');
  wrapper.className = 'custom-dropdown';
  wrapper.dataset.selectId = select.id || '';
  select.before(wrapper);
  wrapper.appendChild(select);
  select.classList.add('custom-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'custom-dropdown-toggle';
  toggle.setAttribute('aria-haspopup', 'listbox');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', label?.textContent.trim() || select.getAttribute('aria-label') || 'Select');
  toggle.innerHTML = `<span class="custom-dropdown-label"></span>${CHEVRON_SVG}`;
  const valueId = `${select.id || 'select'}-dropdown-menu`;
  toggle.setAttribute('aria-controls', valueId);
  wrapper.appendChild(toggle);

  const menu = document.createElement('div');
  menu.id = valueId;
  menu.className = 'custom-dropdown-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', toggle.getAttribute('aria-label'));
  document.body.appendChild(menu);

  const dd = { select, wrapper, toggle, label: toggle.querySelector('.custom-dropdown-label'), menu, isOpen: false, activeOption: null };
  customDropdowns.set(select, dd);

  toggle.addEventListener('click', (event) => { event.stopPropagation(); toggleCustomDropdown(dd); });
  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); dd.isOpen ? stepCustomDropdown(dd, 1) : openCustomDropdown(dd, 'selected'); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); dd.isOpen ? stepCustomDropdown(dd, -1) : openCustomDropdown(dd, 'last'); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleCustomDropdown(dd); }
    else if (event.key === 'Escape' && dd.isOpen) { event.preventDefault(); closeAllCustomDropdowns(null, true); }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); stepCustomDropdown(dd, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepCustomDropdown(dd, -1); }
    else if (event.key === 'Home') { event.preventDefault(); const option = enabledDropdownOptions(dd)[0]; setActiveDropdownOption(dd, option); option?.focus({ preventScroll: true }); }
    else if (event.key === 'End') { event.preventDefault(); const options = enabledDropdownOptions(dd); const option = options.at(-1); setActiveDropdownOption(dd, option); option?.focus({ preventScroll: true }); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const option = dd.activeOption?.classList.contains('custom-dropdown-option') ? dd.activeOption : enabledDropdownOptions(dd)[0]; if (option) selectDropdownValue(dd, Number(option.dataset.index)); }
    else if (event.key === 'Escape') { event.preventDefault(); closeAllCustomDropdowns(null, true); }
    else if (event.key === 'Tab') closeAllCustomDropdowns();
  });
  const observer = new MutationObserver(() => refreshCustomDropdown(select));
  observer.observe(select, { childList: true, subtree: true, characterData: true });
  refreshCustomDropdown(select);
}
function enhanceCustomDropdowns() {
  $$('select').forEach((select) => createCustomDropdown(select));
}
document.addEventListener('pointerdown', (event) => {
  for (const dd of customDropdowns.values()) {
    if (dd.isOpen && !event.target.closest('.custom-dropdown-menu') && !event.target.closest('.custom-dropdown-toggle')) closeAllCustomDropdowns();
  }
}, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAllCustomDropdowns(null, true); });
document.addEventListener('scroll', (event) => {
  if (event.target && event.target.closest && event.target.closest('.custom-dropdown-menu')) return;
  customDropdowns.forEach((dd) => { if (dd.isOpen) positionCustomDropdown(dd); });
}, true);
window.addEventListener('resize', () => closeAllCustomDropdowns());

const MAX_PHOTO_FILE = 5 * 1024 * 1024;
const PHOTO_SIZE = 160;
function avatarMarkup(avatar, photo, fallback = '🐻') {
  return photo ? `<img class="avatar-photo" src="${esc(photo)}" alt="" />` : esc(avatar || fallback);
}
function setAvatarVisual(el, avatar, photo, fallback = '🐻', shine = false) {
  if (!el) return;
  el.innerHTML = `${avatarMarkup(avatar, photo, fallback)}${shine ? '<span class="avatar-shine"></span>' : ''}`;
  el.classList.toggle('has-photo', !!photo);
}
function currentProfilePhoto() {
  return state.avatarMode === 'photo' ? state.profilePhoto : '';
}
function syncAvatarPickers() {
  ['create', 'join'].forEach((target) => {
    const photoBtn = $(`#${target}-avatar-picker .avatar-photo-choice`);
    const img = photoBtn?.querySelector('.avatar-photo-preview');
    const placeholder = photoBtn?.querySelector('.avatar-photo-placeholder');
    const change = photoBtn?.querySelector('.avatar-photo-change');
    const remove = photoBtn?.querySelector('.avatar-photo-remove');
    if (!photoBtn || !img) return;
    const selected = Boolean(state.profilePhoto) && state.avatarMode === 'photo';
    img.src = state.profilePhoto || '';
    img.hidden = !state.profilePhoto;
    if (placeholder) placeholder.hidden = Boolean(state.profilePhoto);
    if (change) change.hidden = !state.profilePhoto;
    if (remove) remove.hidden = !state.profilePhoto;
    photoBtn.classList.toggle('selected', selected);
    photoBtn.setAttribute('aria-checked', String(selected));
    const emojiState = target === 'create' ? state.createAvatar : state.joinAvatar;
    $$(`#${target}-avatar-picker .avatar-choice[data-avatar]`).forEach((btn) => {
      const emojiSelected = state.avatarMode !== 'photo' && btn.dataset.avatar === emojiState;
      btn.classList.toggle('selected', emojiSelected);
      btn.setAttribute('aria-checked', String(emojiSelected));
    });
  });
}
function setProfilePhoto(dataUrl) {
  state.profilePhoto = dataUrl || '';
  state.avatarMode = dataUrl ? 'photo' : 'emoji';
  savePref('photo', state.profilePhoto);
  savePref('avatarMode', state.avatarMode);
  syncAvatarPickers();
}
function removeProfilePhoto() {
  setProfilePhoto('');
  showToast(t('photoRemoved'));
}
function fileToResizedDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error('photoInvalid')); return; }
    if (file.size > MAX_PHOTO_FILE) { reject(new Error('photoTooLarge')); return; }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = PHOTO_SIZE;
        canvas.height = PHOTO_SIZE;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff0f6';
        ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
        URL.revokeObjectURL(objectUrl);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('photoFailed')); return; }
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('photoFailed'));
          reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.82);
      } catch {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('photoFailed'));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('photoFailed')); };
    img.src = objectUrl;
  });
}
async function handlePhotoFile(file) {
  try {
    const dataUrl = await fileToResizedDataUrl(file);
    setProfilePhoto(dataUrl);
    showToast(t('photoSaved'));
  } catch (err) {
    const key = ['photoInvalid', 'photoTooLarge'].includes(err?.message) ? err.message : 'photoFailed';
    showToast(t(key));
  }
}

/* ───────── Screens, toast, loading ───────── */
function showScreen(id) {
  closeAllCustomDropdowns();
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
  if (id !== 'screen-game') audio.setScene('romantic');
}

let toastTimer = null;
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function showLoading(message) {
  state.loadingDepth++;
  $('#loading-text').textContent = message || t('loading');
  $('#loading-overlay').hidden = false;
}
function hideLoading() {
  state.loadingDepth = Math.max(0, state.loadingDepth - 1);
  if (state.loadingDepth === 0) $('#loading-overlay').hidden = true;
}

function setJoinStatus(message, type = '') {
  const el = $('#join-status');
  el.textContent = message || '';
  el.className = `form-status ${type}`.trim();
}

/* ───────── Dialogs ───────── */
function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}
function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function confirmDialog(title, body) {
  return new Promise((resolve) => {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body || '';
    state.confirmResolve = resolve;
    openDialog(dialog);
  });
}
function settleConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  closeDialog($('#confirm-dialog'));
  resolve?.(value);
}

function askPackName(initial = '') {
  return new Promise((resolve) => {
    const dialog = $('#pack-dialog');
    const input = $('#pack-name-input');
    input.value = initial;
    state.packResolve = resolve;
    openDialog(dialog);
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}
function settlePackName(value) {
  const resolve = state.packResolve;
  state.packResolve = null;
  closeDialog($('#pack-dialog'));
  resolve?.(value);
}

function openPreview(questions) {
  const list = $('#preview-list');
  list.innerHTML = '';
  const lang = state.lang;
  if (!questions || !questions.length) {
    list.innerHTML = `<li class="empty">${esc(t('noQuestions'))}</li>`;
  } else {
    questions.forEach((q) => {
      const li = document.createElement('li');
      const opts = q.options.map((o, i) => {
        const text = o[lang] || o.en;
        const mark = q.preferred === i ? ` <span class="pref-mark">♥ ${esc(t('preferredTag'))}</span>` : '';
        return `${String.fromCharCode(65 + i)}. ${esc(text)}${mark}`;
      }).join(' · ');
      li.innerHTML = `${esc(q.q[lang] || q.q.en)}<small>${opts}</small>`;
      list.appendChild(li);
    });
  }
  $('#preview-title').textContent = t('previewTitle');
  $('#preview-sub').textContent = t('previewHint');
  openDialog($('#preview-dialog'));
}

/* ───────── Welcome intro ───────── */
const WELCOME_HEART_SVG = '<svg viewBox="0 0 32 29" aria-hidden="true"><path d="M16 28C7.4 22 1.2 16.8 1.2 9.2 1.2 4.4 5 1 9.8 1c2.8 0 4.9 1.4 6.2 3.6C17.3 2.4 19.4 1 22.2 1 27 1 30.8 4.4 30.8 9.2c0 7.6-6.3 12.8-14.8 18.8z"/></svg>';
function runWelcomeIntro() {
  const intro = $('#welcome-intro');
  const layer = $('#welcome-particles');
  const finish = () => {
    document.body.classList.remove('intro-active');
    intro?.classList.add('intro-exit');
    window.setTimeout(() => { if (intro) intro.hidden = true; }, 700);
  };
  if (!intro) return;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !layer) {
    document.body.classList.remove('intro-active');
    intro.hidden = true;
    return;
  }
  const heartColors = ['#ff72a3', '#ff9fbe', '#f3a0ff', '#d58cff', '#ffb3cd'];
  for (let i = 0; i < 20; i++) {
    const heart = document.createElement('span');
    heart.className = 'inline-float-heart';
    heart.innerHTML = WELCOME_HEART_SVG;
    heart.style.setProperty('--x', `${Math.random() * 100}vw`);
    heart.style.setProperty('--y', `${48 + Math.random() * 58}vh`);
    heart.style.setProperty('--size', `${12 + Math.random() * 24}px`);
    heart.style.setProperty('--color', pick(heartColors));
    heart.style.setProperty('--opacity', (0.38 + Math.random() * 0.42).toFixed(2));
    heart.style.setProperty('--drift', `${(Math.random() - 0.5) * 210}px`);
    heart.style.setProperty('--rotate', `${18 + Math.random() * 72}deg`);
    heart.style.setProperty('--duration', `${7.4 + Math.random() * 4.8}s`);
    heart.style.setProperty('--delay', `${-Math.random() * 4.5}s`);
    layer.appendChild(heart);
  }
  for (let i = 0; i < 48; i++) {
    const sparkle = document.createElement('span');
    sparkle.className = 'sparkle-particle';
    sparkle.style.setProperty('--x', `${Math.random() * 100}%`);
    sparkle.style.setProperty('--y', `${Math.random() * 100}%`);
    sparkle.style.setProperty('--size', `${1.5 + Math.random() * 3.8}px`);
    sparkle.style.setProperty('--opacity', (0.45 + Math.random() * 0.5).toFixed(2));
    sparkle.style.setProperty('--drift-x', `${(Math.random() - 0.5) * 90}px`);
    sparkle.style.setProperty('--drift-y', `${-28 + Math.random() * 70}px`);
    sparkle.style.setProperty('--duration', `${1.8 + Math.random() * 2.4}s`);
    sparkle.style.setProperty('--delay', `${-Math.random() * 3.5}s`);
    layer.appendChild(sparkle);
  }
  window.setTimeout(() => intro.classList.add('intro-exit'), 3800);
  window.setTimeout(finish, 4550);
}

/* ───────── Floating hearts ───────── */
function spawnFloatingHearts() {
  const layer = $('#hearts-bg');
  const glyphs = ['♥', '♥', '♥', '♡', '♥'];
  const colors = ['#ff5e8a', '#ff8fb8', '#cfa9ff', '#b985f5', '#ffb3cd'];
  for (let i = 0; i < 20; i++) {
    const h = document.createElement('span');
    h.className = 'float-heart';
    h.textContent = pick(glyphs);
    h.style.left = `${Math.random() * 100}vw`;
    h.style.fontSize = `${12 + Math.random() * 24}px`;
    h.style.color = pick(colors);
    h.style.setProperty('--heart-opacity', (0.22 + Math.random() * 0.3).toFixed(2));
    h.style.animationDuration = `${12 + Math.random() * 10}s`;
    h.style.animationDelay = `${-Math.random() * 16}s`;
    layer.appendChild(h);
  }
}

/* ───────── i18n ───────── */
function applyStaticTranslations() {
  closeAllCustomDropdowns();
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $$('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder)); });
  document.title = t('docTitle');
  document.documentElement.lang = state.lang;
  $('#mute-btn').setAttribute('aria-label', t('muteLabel'));
  $('#theme-toggle').setAttribute('aria-label', t('themeLabel'));
  $('#volume-btn').setAttribute('aria-label', t('volumeAria'));
  $('#volume-btn').setAttribute('title', t('volumeAria'));
  $('#volume-popover').setAttribute('aria-label', t('volumeLabel'));
  $('#volume-range').setAttribute('aria-label', t('volumeAria'));
  renderConnBadge();
  if (state.room) renderRoom(state.room, { force: true });
  if ($('#screen-dashboard').classList.contains('active')) renderDashboard();
  if ($('#preview-dialog').open) openPreview(state.room?.questions || []);
}
function setLang(lang) {
  state.lang = lang;
  savePref('lang', lang);
  $('#lang-en').classList.toggle('active', lang === 'en');
  $('#lang-km').classList.toggle('active', lang === 'km');
  $('#lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  $('#lang-km').setAttribute('aria-pressed', String(lang === 'km'));
  applyStaticTranslations();
  updateCreateHint();
}

/* ───────── Theme + audio ───────── */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#moon-icon').style.display = theme === 'dark' ? 'none' : '';
  $('#sun-icon').style.display = theme === 'dark' ? '' : 'none';
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  savePref('theme', next);
  applyTheme(next);
  audio.play('click');
}
function setMuted(muted) {
  state.muted = muted;
  audio.setMuted(muted);
  $('#sound-on-icon').style.display = muted ? 'none' : '';
  $('#sound-off-icon').style.display = muted ? '' : 'none';
  $('#mute-btn').setAttribute('aria-pressed', String(muted));
  savePref('muted', muted ? '1' : '0');
}

function setVolume(value) {
  const nextValue = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const range = $('#volume-range');
  const output = $('#volume-value');
  audio.setVolume(nextValue / 100);
  if (range) range.value = String(nextValue);
  if (output) output.textContent = `${nextValue}%`;
  savePref('volume', String(nextValue));
}
function closeVolumePopover() {
  const popover = $('#volume-popover');
  const button = $('#volume-btn');
  if (popover) popover.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
}

/* ───────── Connection badge ───────── */
function setConnectionStatus(status) {
  state.connectionStatus = status;
  renderConnBadge();
}
function updateLocalBanner(show) {
  const banner = $('#local-banner');
  banner.hidden = !show || state.localBannerDismissed;
}
function renderConnBadge() {
  const badge = $('#conn-badge');
  const text = $('#conn-text');
  badge.classList.remove('local', 'offline', 'connecting');

  if (state.connectionStatus === 'error') {
    badge.hidden = true;
    updateLocalBanner(false);
    return;
  }

  badge.hidden = false;
  if (state.connectionStatus === 'connecting') {
    badge.classList.add('connecting');
    text.textContent = t('connConnecting');
    updateLocalBanner(false);
    return;
  }

  if (!navigator.onLine && state.connectionStatus === 'online') {
    badge.classList.add('offline');
    text.textContent = t('connOffline');
    updateLocalBanner(false);
    return;
  }

  if (state.connectionStatus === 'local' || state.backend?.kind === 'local') {
    badge.classList.add('local');
    text.textContent = t('connLocal');
    updateLocalBanner(true);
    return;
  }

  text.textContent = t('connOnline');
  updateLocalBanner(false);
}

function showConnectionError() {
  state.connectionStatus = 'error';
  state.backend = null;
  state.service = null;
  hideLoading();
  renderConnBadge();
  showScreen('screen-setup-error');
}

async function retryConnection() {
  const button = $('#retry-connection-btn');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  showLoading(t('loading'));
  try {
    await connectBackend();
    hideLoading();
  } catch (e) {
    console.error('Firebase reconnect failed:', e);
    showConnectionError();
  } finally {
    if (button) button.disabled = false;
  }
}

async function useLocalDemo() {
  showLoading(t('loading'));
  try {
    const backend = await getLocalBackend();
    state.backend = backend;
    state.uid = backend.uid;
    state.service = new RoomService(backend);
    setConnectionStatus('local');
    state.localBannerDismissed = false;
    updateLocalBanner(true);
    hideLoading();
    showScreen('screen-home');
    updateCreateHint();
  } catch (e) {
    hideLoading();
    console.error('Local Demo boot failed:', e);
    showToast(t('errLocalMode'));
  }
}

async function routeAfterConnect() {
  const roomParam = roomCodeFromUrl();
  if (roomParam) $('#join-code').value = roomParam;
  if (!roomParam) { showScreen('screen-home'); return; }

  try {
    const room = await state.service.getRoom(roomParam);
    if (room && roleOf(room, state.uid)) {
      attachRoom(roomParam);
    } else if (room) {
      setJoinStatus(`${t('lobbyHost')}: ${room.hostName}`, 'success');
      showScreen('screen-join');
    } else {
      showToast(t('errRoomNotFound'));
      showScreen('screen-join');
    }
  } catch (e) {
    console.error('Room lookup failed:', e);
    showToast(t('errGeneric'));
    showScreen('screen-join');
  }
}

async function connectBackend() {
  setConnectionStatus('connecting');
  const backend = await getBackend();
  state.backend = backend;
  state.uid = backend.uid;
  state.service = new RoomService(backend);
  state.connectionStatus = backend.kind === 'local' ? 'local' : 'online';
  state.localBannerDismissed = false;
  renderConnBadge();
  updateCreateHint();
  await routeAfterConnect();
}

/* ───────── Room handlers ───────── */
function roomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

async function createRoom() {
  const name = $('#create-name').value.trim().slice(0, 18) || t('defaultPlayer');
  const questions = buildQuestionSet();
  if (!questions.length) {
    updateCreateHint(true);
    showToast(t('errNeedCustom'));
    return;
  }
  savePref('name', name);
  savePref('avatar', state.createAvatar);
  audio.unlock();
  audio.play('tada');
  showLoading(t('loadingRoom'));
  try {
    const code = await state.service.createRoom({
      name,
      avatar: state.createAvatar,
      photo: currentProfilePhoto(),
      source: state.createSource,
      count: state.createCount,
      category: state.createCategory,
      questions,
    });
    hideLoading();
    attachRoom(code);
    showScreen('screen-lobby');
  } catch (e) {
    hideLoading();
    console.error(e);
    showToast(state.connectionStatus === 'local' ? t('errStorage') : t('errGeneric'));
  }
}

async function joinRoom(codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { setJoinStatus(t('errBadCode'), 'error'); showToast(t('errBadCode')); return; }
  const name = $('#join-name').value.trim().slice(0, 18) || t('defaultPlayer');
  savePref('name', name);
  savePref('avatar', state.joinAvatar);
  audio.unlock();
  audio.play('click');
  setJoinStatus(t('joining'), 'loading');
  showLoading(t('loadingRoom'));
  try {
    const existing = await state.service.getRoom(code);
    if (!existing) throw { code: 'notfound' };
    if (existing.hostUid === state.uid) {
      hideLoading();
      setJoinStatus('');
      attachRoom(code);
      renderRoom(await state.service.getRoom(code));
      return;
    }
    await state.service.join(code, name, state.joinAvatar, currentProfilePhoto());
    hideLoading();
    setJoinStatus(t('toastJoined'), 'success');
    attachRoom(code);
    showToast(t('toastJoined'));
  } catch (e) {
    hideLoading();
    if (e?.code !== 'notfound') console.error('joinRoom failed:', e);
    const msg = t(ERROR_KEYS[e?.code] || 'errGeneric');
    setJoinStatus(msg, 'error');
    showToast(msg);
  }
}

function attachRoom(code) {
  detachRoom();
  state.roomCode = code;
  const lobbyCode = $('#lobby-code');
  if (lobbyCode) lobbyCode.textContent = code;
  state.renderedKey = null;
  state.lastRevealIndex = -1;
  state.autoGameId = null;
  state.autoTried.clear();
  state.audioRevealKey = null;
  clearTimeout(state.revealSceneTimer);
  state.resultsCelebrated = false;
  state.resultsRoomId = null;
  state.roomUnsub = state.service.watchRoom(code, (room) => {
    if (!room) {
      detachRoom();
      showToast(t('errGameOver'));
      showScreen('screen-home');
      return;
    }
    state.room = room;
    state.role = roleOf(room, state.uid);
    renderRoom(room);
  }, (err) => {
    console.error('room listener:', err);
    renderConnBadge();
    showToast(t('errConnect'));
  });
  clearInterval(state.presenceTimer);
  state.presenceTimer = setInterval(() => {
    if (state.roomCode && state.room && state.room.status !== 'finished') {
      state.service.ping(state.roomCode).catch(() => {});
    }
  }, 10000);
  clearInterval(state.awayTimer);
  state.awayTimer = setInterval(() => { if (state.room) renderPresence(state.room); }, 5000);
}

function detachRoom() {
  if (state.roomUnsub) state.roomUnsub();
  state.roomUnsub = null;
  state.roomCode = null;
  state.room = null;
  state.role = null;
  state.renderedKey = null;
  state.lastRevealIndex = -1;
  state.autoGameId = null;
  state.autoTried.clear();
  clearInterval(state.presenceTimer);
  clearInterval(state.awayTimer);
  clearTimeout(state.reactionTimer);
  clearTimeout(state.revealSceneTimer);
  state.audioRevealKey = null;
  cancelAnimationFrame(state.timerRaf);
  hideReaction();
}

async function leaveRoom() {
  audio.play('click');
  const ok = await confirmDialog(t('confirmLeaveTitle'), t('confirmLeaveBody'));
  if (!ok) return;
  try {
    if (state.roomCode) await state.service.leave(state.roomCode);
  } catch (e) { console.warn(e); }
  detachRoom();
  showScreen('screen-home');
}

/* ───────── Question building ───────── */
function customToGameQuestion(q) {
  return {
    q: { en: q.question, km: q.question },
    options: q.options.map((o) => ({ en: o, km: o })),
    category: q.category || 'favorites',
    preferred: Number.isInteger(q.preferred) ? q.preferred : null,
    custom: true,
  };
}
function questionSourceLabel(source) {
  return source === 'builtin' ? t('sourceBuiltin') : source === 'custom' ? t('sourceCustom') : t('sourceMixed');
}
function buildQuestionSet() {
  const category = state.createCategory;
  const customs = activeQuestions()
    .filter((q) => category === 'all' || (q.category || 'favorites') === category)
    .map(customToGameQuestion);
  const builtins = QUESTION_BANK
    .filter((q) => category === 'all' || (q.category || 'favorites') === category)
    .map((q) => ({ q: q.q, options: q.options, category: q.category || 'favorites', custom: false }));
  let pool;
  if (state.createSource === 'custom') pool = customs;
  else if (state.createSource === 'mixed') pool = [...customs, ...builtins];
  else pool = builtins;
  return shuffle(pool).slice(0, Math.min(state.createCount, pool.length));
}
function updateCreateHint(forceError = false) {
  const hint = $('#create-hint');
  const emptyState = $('#custom-empty');
  const createBtn = $('#create-room-btn');
  $('#category-row').hidden = false;
  const builtinCount = QUESTION_BANK.filter((q) => state.createCategory === 'all' || (q.category || 'favorites') === state.createCategory).length;
  const available = activeQuestions().filter((q) => state.createCategory === 'all' || (q.category || 'favorites') === state.createCategory);
  const customEmpty = state.createSource === 'custom' && !available.length;
  emptyState.hidden = !customEmpty;
  createBtn.disabled = customEmpty;
  if (customEmpty) {
    hint.textContent = '';
    hint.className = 'form-hint';
  } else if (state.createSource === 'mixed') {
    hint.textContent = fillT('mixedReady', { n: available.length, m: builtinCount });
    hint.className = 'form-hint';
  } else if (state.createSource === 'builtin') {
    hint.textContent = fillT('builtinReady', { n: builtinCount });
    hint.className = 'form-hint';
  } else {
    hint.textContent = `${available.length} · ${t('dashCount').replace('{n}', available.length)}`;
    hint.className = 'form-hint';
  }
  if (forceError && !customEmpty) hint.className = 'form-hint error';
}

/* ───────── Lobby ───────── */
function renderLobby(room) {
  const role = state.role;
  if (!role) { showScreen('screen-home'); return; }
  const codeChanged = $('#lobby-code').textContent !== room.code;
  $('#lobby-code').textContent = room.code;
  if (codeChanged) {
    $('#lobby-code').style.animation = 'none';
    void $('#lobby-code').offsetWidth;
    $('#lobby-code').style.animation = '';
  }

  setAvatarVisual($('#lobby-host-avatar'), room.hostAvatar || '🐻', room.hostPhoto, '🐻', true);
  const guestAvatarEl = $('#lobby-guest-avatar');
  setAvatarVisual(guestAvatarEl, room.guestAvatar || '🐰', room.guestPhoto, '🐰', true);

  $('#lobby-host-name').textContent = `${room.hostName}${role === 'host' ? ` · ${t('slotYou')}` : ''}`;
  $('#lobby-guest-name').textContent = room.guestUid
    ? `${room.guestName}${role === 'guest' ? ` · ${t('slotYou')}` : ''}`
    : t('lobbyWaiting');

  $('#lobby-guest-card').classList.toggle('joined', !!room.guestUid);
  guestAvatarEl.classList.toggle('empty', !room.guestUid);
  $('#lobby-host-presence').hidden = false;
  $('#lobby-host-presence').lastElementChild.textContent = t('ready');
  const guestPresence = $('#lobby-guest-presence');
  guestPresence.hidden = !room.guestUid;
  guestPresence.lastElementChild.textContent = room.guestUid ? t('ready') : t('notReady');

  const joined = !!room.guestUid;
  $('.lobby-status span:last-child') && ($('#lobby-status span:last-child').textContent = joined ? t('lobbyJoined') : t('lobbyWaitingFor'));
  $('#lobby-status').classList.toggle('joined', joined);

  const sourceLabel = questionSourceLabel(room.source);
  const total = room.questions?.length || room.total || 0;
  $('#lobby-settings').textContent = fill(t('lobbySettingsFmt'), { n: total, source: sourceLabel });

  const startBtn = $('#lobby-start-btn');
  startBtn.disabled = !(role === 'host' && joined);
  startBtn.querySelector('span:first-child').textContent = role === 'host' ? t('startGame') : t('startGameWait');
  $('#lobby-preview-btn').hidden = role !== 'host';

  if (!$('#screen-lobby').classList.contains('active')) showScreen('screen-lobby');
  state.renderedKey = `lobby:${room.code}`;
  hideReaction();
  renderPresence(room);
}

function setPresencePill(el, timestamp) {
  if (!el) return;
  const online = Boolean(timestamp) && nowMs() - timestamp <= 45000;
  el.classList.toggle('away', !online);
  el.lastElementChild.textContent = online ? t('ready') : t('awayLabel');
}
function renderPresence(room) {
  if (!room) { $('#away-banner').hidden = true; return; }
  const hostPill = $('#lobby-host-presence');
  if (hostPill) setPresencePill(hostPill, room.lastSeen?.host);
  const guestPill = $('#lobby-guest-presence');
  if (guestPill) {
    guestPill.hidden = !room.guestUid;
    if (room.guestUid) setPresencePill(guestPill, room.lastSeen?.guest);
  }
  if (room.status !== 'playing') { $('#away-banner').hidden = true; return; }
  const role = state.role;
  if (!role) return;
  const partner = otherRole(role);
  const partnerUid = partner === 'host' ? room.hostUid : room.guestUid;
  if (!partnerUid) return;
  const last = room.lastSeen?.[partner] || 0;
  $('#away-banner').hidden = nowMs() - last <= 45000;
}

async function startGame() {
  const room = state.room;
  if (!room) return;
  if (state.role !== 'host') { showToast(t('startGameWait')); return; }
  if (!room.guestUid) { showToast(t('lobbyWaitingFor')); return; }
  audio.unlock();
  audio.play('tada');
  try {
    await state.service.start(state.roomCode);
  } catch (e) {
    console.error(e);
    showToast(t(ERROR_KEYS[e?.code] || 'errGeneric'));
  }
}

/* ───────── Game ───────── */
function renderRoom(room, opts = {}) {
  if (!room) return;
  if (!roleOf(room, state.uid)) { showScreen('screen-home'); return; }
  if (room.status === 'waiting') return renderLobby(room);
  if (room.status === 'playing') return renderGame(room, opts);
  return renderResults(room);
}

function renderGame(room, opts = {}) {
  const role = state.role;
  const gameId = `${room.code}:${room.createdAt}`;
  if (state.autoGameId !== gameId) {
    state.autoGameId = gameId;
    state.autoTried.clear();
  }
  const index = room.index || 0;
  const phase = room.phase;
  const lang = state.lang;
  const q = room.questions?.[index];
  const myAnswer = room.answers?.[role] ?? null;
  const partner = otherRole(role);
  const partnerAnswer = room.answers?.[partner] ?? null;
  const reveal = phase === 'reveal' && room.roundResult;

  // Music follows the round: suspense while guessing, a sting on reveal,
  // then a warm bed under the result before the next question.
  const audioKey = `${room.code}:${room.createdAt}:${index}`;
  if (phase === 'answer') audio.setScene('suspense');
  if (reveal) {
    audio.reveal(!!room.roundResult.match, audioKey);
    if (state.audioRevealKey !== audioKey) {
      state.audioRevealKey = audioKey;
      clearTimeout(state.revealSceneTimer);
      state.revealSceneTimer = setTimeout(() => {
        if (state.room?.phase === 'reveal') audio.setScene('romantic');
      }, 1400);
    }
  }

  $('#strip-host-score').textContent = room.matches || 0;
  $('#strip-guest-score').textContent = room.matches || 0;
  $('#strip-host-name').textContent = room.hostName;
  $('#strip-guest-name').textContent = room.guestName;
  setAvatarVisual($('#strip-host-avatar'), room.hostAvatar || '🐻', room.hostPhoto, '🐻');
  setAvatarVisual($('#strip-guest-avatar'), room.guestAvatar || '🐰', room.guestPhoto, '🐰');
  $('#match-pill').textContent = `${room.matches || 0} 💞`;
  $('#progress-fill').style.width = `${Math.round(((index + (reveal ? 1 : 0)) / Math.max(1, room.total)) * 100)}%`;
  $('#q-counter').textContent = fillT('questionOf', { i: Math.min(index + 1, room.total), total: room.total });

  const key = `${room.code}:${index}:${phase}:${lang}:${meRoleKey(room)}`;
  const keyChanged = state.renderedKey !== key || opts.force;
  if (keyChanged) {
    state.renderedKey = key;
    state.lastRevealIndex = -1;
    $('#question-kicker').textContent = t('bothAnswering');
    $('#question-text').textContent = q ? q.q[lang] || q.q.en : '';
    $('#question-prompt').textContent = t('answerPrompt');

    const grid = $('#options-grid');
    grid.innerHTML = '';
    if (q) {
      const letters = ['A', 'B', 'C', 'D'];
      q.options.forEach((option, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option-btn';
        btn.dataset.index = String(i);
        btn.innerHTML = `<span class="option-letter">${letters[i]}</span><span class="option-text">${esc(option[lang] || option.en)}</span>`;
        btn.addEventListener('click', () => onAnswerPicked(i));
        grid.appendChild(btn);
      });
    }
    const card = $('#question-card');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }

  const canAnswer = phase === 'answer' && myAnswer == null && !!state.role;
  $$('#options-grid .option-btn').forEach((b, i) => {
    b.disabled = !canAnswer;
    b.classList.toggle('is-locked', myAnswer != null && i === myAnswer);
    b.classList.toggle('is-picked', myAnswer != null && i === myAnswer);
    b.setAttribute('aria-pressed', String(myAnswer === i));
  });
  $('#options-grid').classList.toggle('locked', myAnswer != null);

  const waiting = $('#waiting-state');
  const waitingText = $('#waiting-text');
  waiting.hidden = !(phase === 'answer' && myAnswer != null);
  $('#options-grid').style.display = phase === 'answer' ? '' : 'none';
  if (phase === 'answer' && myAnswer != null) {
    waitingText.textContent = partnerAnswer != null
      ? t('partnerAnswerReady')
      : fillT('waitingPartnerAnswer', { name: partner === 'host' ? room.hostName : room.guestName });
  }

  // Reveal panel
  const panel = $('#reveal-panel');
  panel.hidden = !reveal;
  $('.timer-wrap').hidden = !!reveal;
  if (reveal) {
    const lang2 = lang;
    const hostOption = q?.options?.[room.roundResult.host];
    const guestOption = q?.options?.[room.roundResult.guest];
    const hostText = hostOption ? (hostOption[lang2] || hostOption.en) : '—';
    const guestText = guestOption ? (guestOption[lang2] || guestOption.en) : '—';
    setAvatarVisual($('#pick-host-avatar'), room.hostAvatar || '🐻', room.hostPhoto, '🐻');
    setAvatarVisual($('#pick-guest-avatar'), room.guestAvatar || '🐰', room.guestPhoto, '🐰');
    $('#pick-host-label').textContent = room.hostName;
    $('#pick-guest-label').textContent = room.guestName;
    $('#pick-host-answer').textContent = hostText;
    $('#pick-guest-answer').textContent = guestText;
    const isMatch = !!room.roundResult.match;
    panel.classList.toggle('match', isMatch);
    panel.classList.toggle('mismatch', !isMatch);
    $('#pick-host-card').classList.toggle('matched', isMatch);
    $('#pick-guest-card').classList.toggle('matched', isMatch);
    $('#pick-host-card').classList.toggle('unmatched', !isMatch);
    $('#pick-guest-card').classList.toggle('unmatched', !isMatch);
    $('#reveal-title').textContent = isMatch ? t('revealMatch') : t('revealMismatch');
    $('#reveal-sub').textContent = isMatch
      ? fillT('matchSub', { answer: hostText })
      : t('mismatchSub');
    const isLast = index + 1 >= room.total;
    $('#next-btn span').textContent = isLast ? t('finishGame') : t('nextQuestion');
    if (state.lastRevealIndex !== index) {
      state.lastRevealIndex = index;
      showReaction(isMatch);
    }
  } else if (state.lastRevealIndex !== index) {
    hideReaction();
  }

  renderPresence(room);
  startTimerLoop();
  if (!$('#screen-game').classList.contains('active')) showScreen('screen-game');
}

function meRoleKey(room) {
  const role = state.role || 'x';
  const answers = room.answers || {};
  return `${role}:${answers[role] ?? '-'}:${answers.host ?? '-'}:${answers.guest ?? '-'}`;
}

function onAnswerPicked(choice) {
  const room = state.room;
  if (!room || room.phase !== 'answer') return;
  if (room.answers?.[state.role] != null) { showToast(t('errAlreadyAnswered')); return; }
  audio.unlock();
  audio.play('lock');
  $$('#options-grid .option-btn').forEach((b) => { b.disabled = true; });
  answer(choice);
}

async function answer(choice, { auto = false, forRole = null } = {}) {
  try {
    await state.service.submit(state.roomCode, choice, { auto, forRole });
  } catch (e) {
    const code = e?.code;
    if (code === 'answered') showToast(t('errAlreadyAnswered'));
    else if (code === 'late') showToast(t('errAnswerLate'));
    else if (code !== 'conflict' && code !== 'early') { console.warn(e); showToast(t('errGeneric')); }
    if (state.room) renderGame(state.room, { force: true });
  }
}

function maybeAutoPick(room) {
  if (!room || room.status !== 'playing' || room.phase !== 'answer') return;
  const role = state.role;
  if (!role) return;
  const now = nowMs();
  if (now < (room.timerEndsAt || 0)) return;
  const answers = room.answers || {};
  const partner = otherRole(role);
  const partnerUid = partner === 'host' ? room.hostUid : room.guestUid;

  const myKey = `me:${room.index}`;
  if (answers[role] == null && !state.autoTried.has(myKey)) {
    state.autoTried.add(myKey);
    answer(Math.floor(Math.random() * 4), { auto: true });
    showToast(t('timeUp'));
  }
  const partnerKey = `them:${room.index}`;
  if (partnerUid && answers[partner] == null && now > room.timerEndsAt + AUTO_GRACE_MS && !state.autoTried.has(partnerKey)) {
    state.autoTried.add(partnerKey);
    answer(Math.floor(Math.random() * 4), { auto: true, forRole: partner });
  }
}

async function nextQuestion() {
  audio.play('click');
  const btn = $('#next-btn');
  btn.disabled = true;
  try {
    await state.service.advance(state.roomCode);
  } catch (e) {
    console.warn('advance:', e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

/* ───────── Timer ───────── */
function startTimerLoop() {
  cancelAnimationFrame(state.timerRaf);
  const fillEl = $('#timer-fill');
  const numEl = $('#timer-num');
  const wrap = $('.timer-wrap');
  const CIRC = 213.63;
  const tick = () => {
     const room = state.room;
     if (room && room.status === 'playing' && room.phase === 'answer') {
       const remaining = Math.max(0, (room.timerEndsAt || 0) - nowMs());
       const frac = Math.max(0, Math.min(1, remaining / ANSWER_MS));
       fillEl.style.strokeDashoffset = String(CIRC * (1 - frac));
       numEl.textContent = String(Math.ceil(remaining / 1000));
       const urgent = remaining <= 6000;
       fillEl.classList.toggle('urgent', urgent);
       wrap.classList.toggle('urgent', urgent);
       audio.countdown(remaining, `${room.code}:${room.createdAt}:${room.index}`, true);
       if (remaining <= 0) maybeAutoPick(room);
     } else {
       fillEl.style.strokeDashoffset = '0';
       numEl.textContent = '–';
       wrap.classList.remove('urgent');
       audio.countdown(0, null, false);
     }
    state.timerRaf = requestAnimationFrame(tick);
  };
  state.timerRaf = requestAnimationFrame(tick);
}

/* ───────── Reaction overlay ───────── */
function hideReaction() {
  clearTimeout(state.reactionTimer);
  const overlay = $('#reaction-overlay');
  overlay.classList.remove('show', 'match', 'mismatch', 'correct', 'wrong');
}
function showReaction(isMatch) {
  const overlay = $('#reaction-overlay');
  overlay.classList.remove('show', 'match', 'mismatch', 'correct', 'wrong');
  void overlay.offsetWidth;
  overlay.classList.add(isMatch ? 'correct' : 'wrong', 'show');
  const lang = state.lang;
  $('#reaction-emoji').textContent = isMatch ? pick(['🥰', '😍', '🤩', '💞', '😘']) : pick(['🙈', '😜', '💔', '😵‍💫', '🤭']);
  $('#reaction-headline').textContent = pick(isMatch ? STR[lang].correctHeadlines : STR[lang].wrongHeadlines);
  $('#reaction-sub').textContent = pick(isMatch ? STR[lang].correctSubs : STR[lang].wrongSubs);
  $('#reaction-points').textContent = isMatch ? '💞' : '💔';
  clearTimeout(state.reactionTimer);
  state.reactionTimer = setTimeout(hideReaction, 1900);
}

/* ───────── Results ───────── */
function avgTime(results, role) {
  const values = (results || []).map((r) => r[`${role}Ms`]).filter((n) => Number.isFinite(n));
  if (!values.length) return '–';
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `${(avg / 1000).toFixed(1)}s`;
}

function renderResults(room) {
  cancelAnimationFrame(state.timerRaf);
  const { total, matches, pct } = compatibility({ ...room, total: room.total, matches: room.matches });
  const lang = state.lang;
  const results = room.results || [];

  $('#result-host-name').textContent = room.hostName;
  $('#result-guest-name').textContent = room.guestName;
  $('#result-host-score').textContent = matches;
  $('#result-guest-score').textContent = matches;
  $('#result-host-total').textContent = `/${total}`;
  $('#result-guest-total').textContent = `/${total}`;
  setAvatarVisual($('#result-host-avatar'), room.hostAvatar || '🐻', room.hostPhoto, '🐻');
  setAvatarVisual($('#result-guest-avatar'), room.guestAvatar || '🐰', room.guestPhoto, '🐰');
  const canRematch = state.role === 'host';
  $('#rematch-btn').disabled = !canRematch;
  $('#return-lobby-btn').disabled = !canRematch;
  $('#result-host-time').textContent = avgTime(results, 'host');
  $('#result-guest-time').textContent = avgTime(results, 'guest');

  $('#compat-title').textContent = fillT('compatTitle', { pct });
  $('#compat-sub').textContent =
    pct >= 90 ? t('compatHigh') : pct >= 70 ? t('compatGood') : pct >= 40 ? t('compatMid') : t('compatLow');

  const bestList = $('#best-matches');
  const missList = $('#mismatch-list');
  bestList.innerHTML = '';
  missList.innerHTML = '';
  const matched = results.filter((r) => r.match);
  const missed = results.filter((r) => !r.match);

  if (matched.length) {
    matched.slice(0, 6).forEach((r) => {
      const q = room.questions?.[r.index];
      if (!q) return;
      const option = q.options[r.host]?.[lang] || q.options[r.host]?.en || '—';
      const preferred = q.preferred === r.host ? ` <span class="pref-mark">♥ ${esc(t('preferredTag'))}</span>` : '';
      const li = document.createElement('li');
      li.innerHTML = `${esc(q.q[lang] || q.q.en)} — “${esc(option)}”${preferred}`;
      bestList.appendChild(li);
    });
  } else {
    bestList.innerHTML = `<li class="empty">${esc(t('bestMatchesEmpty'))}</li>`;
  }

  if (missed.length) {
    missed.slice(0, 6).forEach((r) => {
      const q = room.questions?.[r.index];
      if (!q) return;
      const hostText = q.options[r.host]?.[lang] || q.options[r.host]?.en || '—';
      const guestText = q.options[r.guest]?.[lang] || q.options[r.guest]?.en || '—';
      const li = document.createElement('li');
      li.className = 'miss';
      li.innerHTML = `${esc(q.q[lang] || q.q.en)}<br><small>${esc(fillT('mismatchLine', { a: room.hostName, x: hostText, b: room.guestName, y: guestText }))}</small>`;
      missList.appendChild(li);
    });
  } else {
    missList.innerHTML = `<li class="empty">${esc(t('mismatchesEmpty'))}</li>`;
  }

  $('#verdict-text').textContent = pct >= 90 ? t('compatHigh') : pct >= 70 ? t('compatGood') : pct >= 40 ? t('compatMid') : t('compatLow');
  showScreen('screen-results');

  if (state.resultsRoomId !== `${room.code}:${room.createdAt}`) {
    state.resultsRoomId = `${room.code}:${room.createdAt}`;
    state.resultsCelebrated = false;
  }
  if (!state.resultsCelebrated) {
    state.resultsCelebrated = true;
    hideReaction();
    audio.play('tada');
    launchConfetti();
    animateLoveRing(pct);
  }
}

function animateLoveRing(pct) {
  const ring = $('#ring-fill');
  const label = $('#love-pct');
  const circumference = 2 * Math.PI * 50;
  ring.style.strokeDasharray = String(circumference);
  ring.style.strokeDashoffset = String(circumference);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ring.style.strokeDashoffset = String(circumference * (1 - pct / 100));
  }));
  const duration = 1500;
  const start = performance.now();
  const tick = (now) => {
    const delta = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(2, -8 * delta);
    label.textContent = `${Math.round(eased * pct)}%`;
    if (delta < 1) requestAnimationFrame(tick);
    else label.textContent = `${pct}%`;
  };
  requestAnimationFrame(tick);
}

function launchConfetti() {
  const layer = $('#confetti-layer');
  layer.innerHTML = '';
  const pieces = ['♥', '💖', '💕', '💗', '🌹', '✨', '💘'];
  for (let i = 0; i < 44; i++) {
    const span = document.createElement('span');
    span.className = 'confetti';
    span.textContent = pick(pieces);
    span.style.left = `${Math.random() * 100}vw`;
    span.style.fontSize = `${0.9 + Math.random() * 1.2}rem`;
    span.style.animationDuration = `${3 + Math.random() * 2.5}s`;
    span.style.animationDelay = `${Math.random() * 1.2}s`;
    layer.appendChild(span);
  }
  setTimeout(() => { layer.innerHTML = ''; }, 6000);
}

async function rematch() {
  const room = state.room;
  if (!room) return;
  if (state.role !== 'host') { showToast(t('rematchHostOnly')); return; }
  audio.play('tada');
  const questions = buildQuestionSet();
  if (!questions.length) { showToast(t('errNeedCustom')); return; }
  try {
    await state.service.rematch(state.roomCode, questions);
  } catch (e) {
    console.error(e);
    showToast(t(ERROR_KEYS[e?.code] || 'errGeneric'));
  }
}

async function returnToLobby() {
  const room = state.room;
  if (!room) return;
  if (state.role !== 'host') { showToast(t('rematchHostOnly')); return; }
  audio.play('click');
  showLoading(t('loadingRoom'));
  try {
    await state.service.returnToLobby(state.roomCode);
    hideLoading();
  } catch (e) {
    hideLoading();
    console.error(e);
    showToast(t(ERROR_KEYS[e?.code] || 'errGeneric'));
  }
}

/* ───────── Share ───────── */
function shareCurrent() {
  if (!state.room) return;
  audio.play('click');
  shareResults(state.room, state.lang, (msg) => showToast(msg), (msg) => showToast(msg));
}
function downloadCard() {
  if (!state.room) return;
  audio.play('click');
  try {
    downloadScoreCard(state.room, state.lang);
    showToast(t('cardDownloaded'));
  } catch (e) {
    console.error(e);
    showToast(t('errGeneric'));
  }
}

/* ───────── Lobby helpers ───────── */
async function copyRoomCode() {
  const code = $('#lobby-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast(t('toastCodeCopied'));
  } catch { showToast(t('toastShareFailed')); }
}
async function shareInvite() {
  const code = $('#lobby-code').textContent;
  const link = `${window.location.origin}${window.location.pathname}?room=${code}`;
  audio.play('click');
  if (navigator.share) {
    try {
      await navigator.share({ title: t('docTitle'), text: `${t('inviteBtn')} — ${code}`, url: link });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    showToast(t('toastLinkCopied'));
  } catch { showToast(t('toastShareFailed')); }
}

/* ───────── Dashboard · packs & questions ───────── */
function renderPackBar() {
  const select = $('#pack-select');
  select.innerHTML = '';
  state.packs.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.name} (${p.questions.length})`;
    select.appendChild(option);
  });
  select.value = state.activePackId;
  refreshCustomDropdown(select);
  $('#pack-delete-btn').disabled = state.packs.length <= 1;
}

function renderDashboard() {
  renderPackBar();
  const questions = activeQuestions();
  $('#dash-count').textContent = fill(t('dashCount'), { n: questions.length });
  $('#dash-empty').style.display = questions.length === 0 ? '' : 'none';

  const list = $('#questions-list');
  list.innerHTML = '';
  questions.forEach((q) => {
    const item = document.createElement('div');
    item.className = 'question-item';
    item.innerHTML = `
      <div class="question-item-top">
        <div>
          <p class="question-item-cat">${esc(catLabel(q.category))}</p>
          <p class="question-item-text">${esc(q.question)}</p>
        </div>
        <div class="question-item-actions">
          <button type="button" class="mini-btn edit" aria-label="Edit" title="Edit">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L10 16l-4 1 1-4Z"/></svg>
          </button>
          <button type="button" class="mini-btn danger delete" aria-label="Delete" title="Delete">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="question-chips">${q.options.map((o, i) => `<span class="question-chip${Number.isInteger(q.preferred) && q.preferred === i ? ' pref' : ''}">${esc(o)}${Number.isInteger(q.preferred) && q.preferred === i ? ' ♥' : ''}</span>`).join('')}</div>`;
    item.querySelector('.edit').addEventListener('click', () => startEditQuestion(q));
    item.querySelector('.delete').addEventListener('click', () => deleteQuestion(q));
    list.appendChild(item);
  });
}

function startEditQuestion(q) {
  state.editingId = q.id;
  $('#question-input').value = q.question;
  q.options.forEach((o, i) => { $(`#option-${i + 1}`).value = o; });
  $('#question-category').value = q.category || 'favorites';
  refreshCustomDropdown($('#question-category'));
  $$('input[name="preferred"]').forEach((r) => { r.checked = Number(r.value) === q.preferred; });
  $('#question-submit-label').textContent = t('saveQuestion');
  $('#cancel-edit-btn').hidden = false;
  $('#question-input').focus();
}

function resetQuestionForm() {
  state.editingId = null;
  $('#question-form').reset();
  $('#question-submit-label').textContent = t('addQuestion');
  $('#cancel-edit-btn').hidden = true;
}

function submitQuestionForm(e) {
  e.preventDefault();
  const question = $('#question-input').value.trim();
  const options = [1, 2, 3, 4].map((i) => $(`#option-${i}`).value.trim());
  if (!question || options.some((o) => !o)) { showToast(t('errEmptyFields')); return; }
  const category = $('#question-category').value;
  const preferredEl = $('input[name="preferred"]:checked');
  const preferred = preferredEl ? Number(preferredEl.value) : null;
  audio.play('click');

  const pack = activePack();
  if (!pack) return;
  if (state.editingId) {
    const q = pack.questions.find((item) => item.id === state.editingId);
    if (q) Object.assign(q, { question, options, category, preferred });
  } else {
    pack.questions.unshift({
      id: 'q_' + Math.random().toString(36).slice(2, 10),
      question, options, category, preferred, createdAt: Date.now(),
    });
  }
  savePacks();
  showToast(t('toastQuestionSaved'));
  resetQuestionForm();
  renderDashboard();
}

async function deleteQuestion(q) {
  const ok = await confirmDialog(t('confirmDeleteTitle'), t('confirmDeleteBody'));
  if (!ok) return;
  const pack = activePack();
  if (!pack) return;
  pack.questions = pack.questions.filter((item) => item.id !== q.id);
  savePacks();
  showToast(t('toastQuestionDeleted'));
  renderDashboard();
}

async function createPack() {
  const name = (await askPackName('') || '').trim().slice(0, 24);
  if (!name) return;
  const pack = newPack(name);
  state.packs.push(pack);
  state.activePackId = pack.id;
  savePacks();
  renderDashboard();
  showToast(t('packCreated'));
  audio.play('click');
}

async function renamePack() {
  const pack = activePack();
  if (!pack) return;
  const name = (await askPackName(pack.name) || '').trim().slice(0, 24);
  if (!name) return;
  pack.name = name;
  savePacks();
  renderDashboard();
  showToast(t('toastPackSaved'));
  audio.play('click');
}

async function deletePack() {
  if (state.packs.length <= 1) return;
  const ok = await confirmDialog(t('deletePack'), t('packDeleteSure'));
  if (!ok) return;
  state.packs = state.packs.filter((p) => p.id !== state.activePackId);
  state.activePackId = state.packs[0].id;
  savePacks();
  renderDashboard();
  showToast(t('packDeleted'));
}

/* ───────── Boot & wiring ───────── */
function wireEvents() {
  // Browsers only allow audio after a gesture: unlock once, then start the bed.
  const firstGesture = () => {
    audio.unlock();
    if (!$('#screen-game').classList.contains('active')) audio.setScene('romantic');
    document.removeEventListener('pointerdown', firstGesture, true);
    document.removeEventListener('keydown', firstGesture, true);
  };
  document.addEventListener('pointerdown', firstGesture, true);
  document.addEventListener('keydown', firstGesture, true);

  // Navigation
  $('#home-create-btn').addEventListener('click', () => { audio.play('click'); showScreen('screen-create'); updateCreateHint(); });
  $('#home-join-btn').addEventListener('click', () => { audio.play('click'); setJoinStatus(''); showScreen('screen-join'); });
  $('#home-dashboard-btn').addEventListener('click', () => { audio.play('click'); showScreen('screen-dashboard'); renderDashboard(); });
  $('#custom-empty-cta')?.addEventListener('click', () => { audio.play('click'); showScreen('screen-dashboard'); renderDashboard(); });
  $$('.back-btn').forEach((btn) => btn.addEventListener('click', () => {
    audio.play('click');
    detachRoom();
    showScreen(btn.dataset.goto || 'screen-home');
  }));
  $('#home-btn').addEventListener('click', () => { audio.play('click'); detachRoom(); showScreen('screen-home'); });

  // Avatar pickers
  $$('.avatar-picker').forEach((picker) => {
    picker.addEventListener('click', (e) => {
      const photoBtn = e.target.closest('.avatar-photo-choice');
      if (photoBtn) {
        const target = photoBtn.dataset.photoTarget || 'create';
        if (e.target.closest('.avatar-photo-remove')) {
          e.stopPropagation();
          removeProfilePhoto();
          audio.play('click');
          return;
        }
        if (e.target.closest('.avatar-photo-change')) {
          e.stopPropagation();
          $(`#${target}-photo-input`)?.click();
          return;
        }
        if (state.profilePhoto) {
          state.avatarMode = 'photo';
          savePref('avatarMode', state.avatarMode);
          syncAvatarPickers();
        } else {
          $(`#${target}-photo-input`)?.click();
        }
        audio.play('click');
        return;
      }
      const btn = e.target.closest('.avatar-choice[data-avatar]');
      if (!btn) return;
      const value = btn.dataset.avatar;
      state.avatarMode = 'emoji';
      savePref('avatarMode', state.avatarMode);
      if (picker.id === 'create-avatar-picker') state.createAvatar = value;
      else state.joinAvatar = value;
      savePref('avatar', value);
      syncAvatarPickers();
      audio.play('click');
    });
  });
  $$('.photo-input').forEach((input) => input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    await handlePhotoFile(file);
    e.target.value = '';
  }));

  const saveNameLive = (source, target) => {
    const value = source.value.trimStart().slice(0, 18);
    savePref('name', value);
    if (target && target.value !== value) target.value = value;
  };
  $('#create-name')?.addEventListener('input', (e) => saveNameLive(e.target, $('#join-name')));
  $('#join-name')?.addEventListener('input', (e) => saveNameLive(e.target, $('#create-name')));

  // Create controls
  $$('#screen-create .segment').forEach((btn) => btn.addEventListener('click', () => {
    state.createSource = btn.dataset.source;
    $$('#screen-create .segment').forEach((b) => {
      const sel = b === btn;
      b.classList.toggle('selected', sel);
      b.setAttribute('aria-checked', String(sel));
    });
    audio.play('click');
    updateCreateHint();
  }));
  $$('.count-option').forEach((btn) => btn.addEventListener('click', () => {
    state.createCount = Number(btn.dataset.count);
    $$('.count-option').forEach((b) => {
      const sel = b === btn;
      b.classList.toggle('selected', sel);
      b.setAttribute('aria-checked', String(sel));
    });
    audio.play('click');
  }));
  $('#create-category').addEventListener('change', (e) => {
    state.createCategory = e.target.value;
    updateCreateHint();
  });
  $('#create-room-btn').addEventListener('click', () => {
    if (!state.service) { showToast(t('resumeConnecting')); return; }
    createRoom();
  });

  // Join
  $('#join-room-btn').addEventListener('click', () => {
    if (!state.service) { showToast(t('resumeConnecting')); return; }
    joinRoom($('#join-code').value);
  });
  $('#join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(e.target.value); });

  // Lobby
  $('#copy-code-btn').addEventListener('click', copyRoomCode);
  $('#invite-share-btn').addEventListener('click', shareInvite);
  $('#lobby-preview-btn').addEventListener('click', () => {
    audio.play('click');
    openPreview(state.room?.questions || []);
  });
  $('#lobby-start-btn').addEventListener('click', startGame);
  $('#lobby-leave-btn').addEventListener('click', leaveRoom);

  // Game
  $('#next-btn').addEventListener('click', nextQuestion);

  // Results
  $('#share-btn').addEventListener('click', shareCurrent);
  $('#download-card-btn').addEventListener('click', downloadCard);
  $('#rematch-btn').addEventListener('click', rematch);
  $('#return-lobby-btn').addEventListener('click', returnToLobby);

  // Dashboard packs
  $('#pack-select').addEventListener('change', (e) => {
    state.activePackId = e.target.value;
    savePacks();
    renderDashboard();
  });
  $('#pack-new-btn').addEventListener('click', createPack);
  $('#pack-rename-btn').addEventListener('click', renamePack);
  $('#pack-preview-btn').addEventListener('click', () => {
    audio.play('click');
    openPreview(activeQuestions().map(customToGameQuestion));
  });
  $('#pack-delete-btn').addEventListener('click', deletePack);
  $('#question-form').addEventListener('submit', submitQuestionForm);
  $('#cancel-edit-btn').addEventListener('click', () => { audio.play('click'); resetQuestionForm(); });

  // Dialogs
  $$('[data-close-dialog]').forEach((btn) => btn.addEventListener('click', () => closeDialog(btn.closest('dialog'))));
  $('#confirm-yes').addEventListener('click', () => settleConfirm(true));
  $('#confirm-no').addEventListener('click', () => settleConfirm(false));
  $('#confirm-dialog').addEventListener('cancel', (e) => { e.preventDefault(); settleConfirm(false); });
  $('#pack-save-btn').addEventListener('click', () => settlePackName($('#pack-name-input').value));
  $('#pack-cancel-btn').addEventListener('click', () => settlePackName(null));
  $('#pack-close-btn')?.addEventListener('click', () => settlePackName(null));
  $('#confirm-close-btn')?.addEventListener('click', () => settleConfirm(false));
  $('#preview-close-btn')?.addEventListener('click', () => closeDialog($('#preview-dialog')));
  $('#pack-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); settlePackName($('#pack-name-input').value); }
  });
  $('#pack-dialog').addEventListener('cancel', (e) => { e.preventDefault(); settlePackName(null); });
  $$('dialog.app-dialog').forEach((dialog) => {
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      if (dialog.id === 'preview-dialog') closeDialog(dialog);
      if (dialog.id === 'pack-dialog') settlePackName(null);
      if (dialog.id === 'confirm-dialog') settleConfirm(false);
    });
  });

  // Top controls
  $('#mute-btn').addEventListener('click', () => {
    setMuted(!state.muted);
    if (!state.muted) audio.play('click');
  });
  $('#volume-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const popover = $('#volume-popover');
    const willOpen = popover?.hidden !== false;
    if (popover) popover.hidden = !willOpen;
    $('#volume-btn')?.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) audio.unlock();
    audio.play('click');
  });
  $('#volume-range')?.addEventListener('input', (e) => setVolume(e.target.value));
  $('#volume-range')?.addEventListener('change', (e) => setVolume(e.target.value));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#volume-popover') && !e.target.closest('#volume-btn')) closeVolumePopover();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVolumePopover(); });
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#lang-en').addEventListener('click', () => { if (state.lang !== 'en') { setLang('en'); audio.play('click'); } });
  $('#lang-km').addEventListener('click', () => { if (state.lang !== 'km') { setLang('km'); audio.play('click'); } });
  $('#local-banner-close').addEventListener('click', () => { state.localBannerDismissed = true; $('#local-banner').hidden = true; });
  $('#retry-connection-btn')?.addEventListener('click', retryConnection);
  $('#use-local-demo-btn')?.addEventListener('click', useLocalDemo);

  window.addEventListener('online', renderConnBadge);
  window.addEventListener('offline', renderConnBadge);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.roomCode && state.room && state.room.status !== 'finished') {
      state.service.ping(state.roomCode).catch(() => {});
    }
  });
}

function prefillPreferences() {
  const savedTheme = loadPref('theme');
  const theme = savedTheme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
  state.lang = loadPref('lang') || 'en';
  $('#lang-en').classList.toggle('active', state.lang === 'en');
  $('#lang-km').classList.toggle('active', state.lang === 'km');
  $('#lang-en').setAttribute('aria-pressed', String(state.lang === 'en'));
  $('#lang-km').setAttribute('aria-pressed', String(state.lang === 'km'));

  const savedName = loadPref('name');
  if (savedName && !$('#create-name').value) { $('#create-name').value = savedName; $('#join-name').value = savedName; }
  const savedAvatar = loadPref('avatar');
  if (savedAvatar) {
    state.createAvatar = savedAvatar;
    state.joinAvatar = savedAvatar === '🐻' ? '🐰' : savedAvatar;
  }
  state.profilePhoto = loadPref('photo') || '';
  state.avatarMode = loadPref('avatarMode') === 'photo' && state.profilePhoto ? 'photo' : 'emoji';
  syncAvatarPickers();

  const savedVolume = loadPref('volume');
  const volumeValue = savedVolume === null ? 90 : Math.max(0, Math.min(100, Number(savedVolume) || 0));
  setVolume(volumeValue);

  state.muted = loadPref('muted') === '1';
  setMuted(state.muted);
}

async function init() {
  runWelcomeIntro();
  loadPacks();
  enhanceCustomDropdowns();
  prefillPreferences();
  spawnFloatingHearts();
  wireEvents();
  applyStaticTranslations();

  showLoading(t('loading'));
  try {
    await connectBackend();
    hideLoading();
  } catch (e) {
    console.error('Backend boot failed:', e);
    if (isFirebaseConfigured) {
      showConnectionError();
    } else {
      try {
        const backend = await getLocalBackend();
        state.backend = backend;
        state.uid = backend.uid;
        state.service = new RoomService(backend);
        setConnectionStatus('local');
        hideLoading();
        await routeAfterConnect();
      } catch (localError) {
        console.error('Local Demo boot failed:', localError);
        showToast(t('errLocalMode'));
        hideLoading();
      }
    }
  }
}

init();
