// Share text + downloadable score card (canvas). Pure functions, no DOM deps
// other than the temporary canvas used to export the PNG.

import { STR } from './i18n.js';

const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), tpl);

export function compatibility(room) {
  const total = room?.total || room?.questions?.length || 0;
  const matches = room?.matches || 0;
  return { total, matches, pct: total > 0 ? Math.round((matches / total) * 100) : 0 };
}

export function buildShareText(room, lang = 'en') {
  const { total, matches, pct } = compatibility(room);
  return fill(STR[lang].shareText, {
    host: room?.hostName || 'Host',
    guest: room?.guestName || 'Partner',
    matches, total, pct,
  });
}

export async function shareResults(room, lang, onDone, onFail) {
  const text = buildShareText(room, lang);
  if (navigator.share) {
    try {
      await navigator.share({ title: STR[lang].docTitle, text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    onDone?.(STR[lang].toastCopied);
  } catch {
    onFail?.(STR[lang].toastShareFailed);
  }
}

function heart(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 30, size / 30);
  ctx.beginPath();
  ctx.moveTo(0, 10);
  ctx.bezierCurveTo(-16, -2, -14, -14, -6, -14);
  ctx.bezierCurveTo(-2, -14, 0, -10, 0, -8);
  ctx.bezierCurveTo(0, -10, 2, -14, 6, -14);
  ctx.bezierCurveTo(14, -14, 16, -2, 0, 10);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function downloadScoreCard(room, lang = 'en') {
  const { total, matches, pct } = compatibility(room);
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2b1437');
  bg.addColorStop(0.5, '#43204d');
  bg.addColorStop(1, '#5a2740');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const colors = ['#ff8fb8', '#cfa9ff', '#ff5e8a', '#b985f5', '#ffb3cd'];
  for (let i = 0; i < 44; i++) {
    heart(ctx, Math.random() * W, Math.random() * H, 10 + Math.random() * 28, colors[i % colors.length]);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 4;
  roundRect(ctx, 70, 70, W - 140, H - 140, 60);
  ctx.fill(); ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd9e8';
  ctx.font = '700 42px Quicksand, sans-serif';
  ctx.fillText('W H O   K N O W S   W H O   B E T T E R ?', W / 2, 175);
  ctx.font = '700 92px "Dancing Script", "Kantumruy Pro", cursive';
  const grad = ctx.createLinearGradient(200, 0, W - 200, 0);
  grad.addColorStop(0, '#ff8fb8');
  grad.addColorStop(1, '#d3a9ff');
  ctx.fillStyle = grad;
  ctx.fillText('Heart Sync', W / 2, 285);

  ctx.font = '90px serif';
  ctx.fillText(pct >= 70 ? '💞' : '💗', W / 2, 420);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 68px "Dancing Script", "Kantumruy Pro", cursive';
  ctx.fillText(`${room?.hostName || 'Host'}  &  ${room?.guestName || 'Partner'}`, W / 2, 520);

  const cx = W / 2, cy = 830, r = 150;
  ctx.lineWidth = 30;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  const ring = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  ring.addColorStop(0, '#ff5e8a'); ring.addColorStop(1, '#a05ef0');
  ctx.strokeStyle = ring;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (pct / 100)); ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 96px Quicksand, sans-serif';
  ctx.fillText(`${pct}%`, cx, cy + 16);
  ctx.font = '600 30px Quicksand, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText('HEART  SYNC', cx, cy + 62);

  ctx.fillStyle = '#ffb3cd';
  ctx.font = '700 54px Quicksand, sans-serif';
  ctx.fillText(`${matches} / ${total}`, W / 2, 1090);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = '600 30px Quicksand, sans-serif';
  ctx.fillText('M A T C H E D   A N S W E R S', W / 2, 1140);

  ctx.font = '600 26px Quicksand, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(window.location.host || 'Who Knows Who Better?', W / 2, H - 110);

  const a = document.createElement('a');
  a.download = 'who-knows-who-better-results.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
}
