/**
 * Patronus Easter egg — Expecto Patronum. A silvery doe GALLOPS across the
 * screen (a 12-frame Eadweard Muybridge motion-study, extracted to a glowing
 * silhouette — its legs actually move) trailing mist, while the spell
 * "אקספקטו פטרונום" glows beneath a wand. Cast by 3 rapid taps on the version
 * badge in the header (wired in app.ts, same idiom as the other easter eggs).
 *
 * Self-contained: no app/store dependencies. The sprite strip lives in the
 * code-split ./patronus-doe-sprite module and is dynamically imported on first
 * cast, so its ~128KB never weighs on the main bundle. Appends a transient,
 * fully click-through overlay to document.body and removes it when the cast
 * ends. All visuals live in style.css under the gm-patronus-* section. Honors
 * prefers-reduced-motion with a stationary, single-frame fade.
 */

const FLIGHT_MS = 4600;
const REDUCED_MS = 3000;
const SPARK_EVERY_MS = 70;

let _active = false;

export async function castPatronus(): Promise<void> {
  if (_active) return;
  _active = true;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Lazy-load the (code-split) sprite so its data URL only loads on first cast.
  let sprite: { DOE_SPRITE: string };
  try {
    sprite = await import('./patronus-doe-sprite');
  } catch {
    _active = false;
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = `gm-patronus-overlay${reduced ? ' gm-patronus-reduced' : ''}`;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="gm-patronus-veil"></div>
    <div class="gm-patronus-x">
      <div class="gm-patronus-y">
        <div class="gm-patronus-doe"></div>
      </div>
    </div>
    <div class="gm-patronus-spell">
      <div class="gm-patronus-spell-inner">
        ${wandSvg()}
        <span class="gm-patronus-spell-text" data-text="אקספקטו פטרונום">אקספקטו פטרונום</span>
      </div>
    </div>`;
  const doe = overlay.querySelector('.gm-patronus-doe') as HTMLElement;
  doe.style.backgroundImage = `url(${sprite.DOE_SPRITE})`;
  document.body.appendChild(overlay);

  // Misty silver trail — sparks spawn at the doe's live position and drift
  // backward (the doe gallops leftward), fading as they fall behind.
  let sparkTimer: ReturnType<typeof setInterval> | null = null;
  if (!reduced) {
    let tick = 0;
    sparkTimer = setInterval(() => {
      tick++;
      const r = doe.getBoundingClientRect();
      if (r.width === 0) return;
      // Emit from just behind the body (the doe faces/gallops left).
      const cx = r.left + r.width * 0.7;
      const cy = r.top + r.height * 0.5;
      spawnSpark(overlay, cx, cy, false);
      if (tick % 2 === 0) spawnSpark(overlay, cx, cy, true);
    }, SPARK_EVERY_MS);
  }

  setTimeout(
    () => {
      if (sparkTimer) clearInterval(sparkTimer);
      overlay.remove();
      _active = false;
    },
    (reduced ? REDUCED_MS : FLIGHT_MS) + 700,
  );
}

function spawnSpark(overlay: HTMLElement, cx: number, cy: number, wisp: boolean): void {
  const s = document.createElement('div');
  s.className = wisp ? 'gm-patronus-spark gm-patronus-wisp' : 'gm-patronus-spark';
  const size = wisp ? 12 + Math.random() * 14 : 3 + Math.random() * 5;
  const jx = (Math.random() - 0.5) * 30;
  const jy = (Math.random() - 0.5) * 30;
  s.style.width = `${size.toFixed(1)}px`;
  s.style.height = `${size.toFixed(1)}px`;
  s.style.left = `${(cx + jx).toFixed(1)}px`;
  s.style.top = `${(cy + jy).toFixed(1)}px`;
  // Drift backward (to the right — the doe gallops leftward) and slightly down.
  s.style.setProperty('--dx', `${(20 + Math.random() * 55).toFixed(0)}px`);
  s.style.setProperty('--dy', `${(-12 + Math.random() * 34).toFixed(0)}px`);
  s.style.animationDuration = `${((wisp ? 1.1 : 0.8) + Math.random() * 0.5).toFixed(2)}s`;
  s.addEventListener('animationend', () => s.remove(), { once: true });
  overlay.appendChild(s);
}

/**
 * A slim wand held beside the spell caption, tip glowing up toward the words —
 * the implement that cast the doe. Drawn pointing up-left.
 */
function wandSvg(): string {
  return `<svg class="gm-patronus-wand" viewBox="0 0 92 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <line class="gm-patronus-wand-stick" x1="12" y1="42" x2="70" y2="12"/>
    <circle class="gm-patronus-wand-tip" cx="72" cy="11" r="4"/>
    <g class="gm-patronus-wand-spark">
      <path d="M72 1 L72 21 M62 11 L82 11 M65 4 L79 18 M79 4 L65 18"/>
    </g>
  </svg>`;
}
