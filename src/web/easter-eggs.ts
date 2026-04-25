/**
 * Easter eggs — magical effects when a Harry Potter (or Star Wars) character
 * name is added (or removed) as a participant. Pure CSS + tiny particle/SVG
 * spawner.
 *
 * Variants:
 *   - trio       : Harry, Hermione, Ron — gold Gryffindor sparkles
 *   - dumbledore : Albus Dumbledore — white flash + ripple ring + bigger gold
 *   - darkwizard : Voldemort, Tom Riddle, Draco — green Slytherin smoke + dark
 *                  Voldemort & Tom Riddle additionally summon a Dark Mark.
 *   - professor  : McGonagall, Hagrid, Snape, Flitwick, Slughorn — warm gold
 *   - sith       : Darth Vader — red vignette + Vader helmet summons in.
 *
 * Removal triggers a gentler farewell effect — same color family but quieter.
 * Dumbledore's farewell drifts phoenix feathers down the screen.
 */

type Variant = 'trio' | 'dumbledore' | 'darkwizard' | 'professor' | 'sith';

interface Preset {
  variant: Variant;
  spell: string;
  farewell: string;
  /** Voldemort, Tom Riddle — fade in a Dark Mark watermark during the cast. */
  darkMark?: boolean;
  /** Dumbledore — drift phoenix feathers during the farewell. */
  feathersOnFarewell?: boolean;
}

interface CharacterEntry {
  names: string[];
  preset: Preset;
}

const CHARACTERS: CharacterEntry[] = [
  // — The Trio —
  {
    names: ['harry potter', 'הארי פוטר'],
    preset: {
      variant: 'trio',
      spell: 'Expecto Patronum!',
      farewell: 'Mischief Managed.',
    },
  },
  {
    names: ['hermione granger', "הרמיוני גריינג'ר", 'הרמיוני גריינגר'],
    preset: {
      variant: 'trio',
      spell: 'Wingardium Leviosa!',
      farewell: 'Mischief Managed.',
    },
  },
  {
    names: ['ron weasley', 'רון וויזלי', 'רון ויזלי'],
    preset: {
      variant: 'trio',
      spell: 'Eat Slugs!',
      farewell: 'Mischief Managed.',
    },
  },

  // — Dumbledore (special) —
  {
    names: ['albus dumbledore', 'אלבוס דמבלדור'],
    preset: {
      variant: 'dumbledore',
      spell: 'Lumos Maxima!',
      farewell: 'Until the very end.',
      feathersOnFarewell: true,
    },
  },

  // — Dark wizards (green) —
  {
    names: ['lord voldemort', 'voldemort', 'לורד וולדמורט', 'וולדמורט'],
    preset: {
      variant: 'darkwizard',
      spell: 'Avada Kedavra!',
      farewell: 'He shall not be named.',
      darkMark: true,
    },
  },
  {
    names: ['tom riddle', 'tom marvolo riddle', 'טום רידל'],
    preset: {
      variant: 'darkwizard',
      spell: 'I am Lord Voldemort',
      farewell: 'Just a memory.',
      darkMark: true,
    },
  },
  {
    names: ['draco malfoy', 'דראקו מאלפוי'],
    preset: {
      variant: 'darkwizard',
      spell: 'You Mudblood!',
      farewell: 'Mischief Managed.',
    },
  },

  // — Hogwarts professors (shared visual, individual spells) —
  {
    names: ['minerva mcgonagall', 'מנרווה מקגונגל', 'מינרווה מקונגל'],
    preset: {
      variant: 'professor',
      spell: '10 points to Gryffindor!',
      farewell: 'Class dismissed.',
    },
  },
  {
    names: ['rubeus hagrid', 'hagrid', 'רובאוס האגריד', 'האגריד'],
    preset: {
      variant: 'professor',
      spell: 'Yer a wizard!',
      farewell: 'See yeh later.',
    },
  },
  {
    names: ['severus snape', 'snape', 'סוורוס סנייפ', 'סנייפ'],
    preset: {
      variant: 'professor',
      spell: '10 points from Gryffindor',
      farewell: 'Off you go.',
    },
  },
  {
    names: ['filius flitwick', 'פיליוס פליטוויק', 'פיליוס פליטיק'],
    preset: {
      variant: 'professor',
      spell: 'Splendid! 10 points to Ravenclaw!',
      farewell: 'Class dismissed.',
    },
  },
  {
    names: ['horace slughorn', 'הוראס סלאגהורן', 'הוראס סלהגורון'],
    preset: {
      variant: 'professor',
      spell: '10 points to Slytherin!',
      farewell: 'Class dismissed.',
    },
  },

  // — Sith Lord (Star Wars crossover) —
  {
    names: [
      'darth vader',
      'vader',
      'דארת ווידר',
      'דארת ויידר',
      "דארת' ויידר",
      'דארת וויידר',
      'דארת ואדר',
    ],
    preset: {
      variant: 'sith',
      spell: 'I am your father',
      farewell: 'Join the dark side',
    },
  },
];

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findPreset(name: string): Preset | null {
  const n = normalize(name);
  for (const c of CHARACTERS) {
    if (c.names.some((x) => normalize(x) === n)) return c.preset;
  }
  return null;
}

export interface AnchorPoint {
  x: number;
  y: number;
}

/** Trigger the cast (add) effect if the name matches a known character. */
export function triggerCharacterEffect(name: string, anchor: AnchorPoint, rowEl: Element | null): boolean {
  const preset = findPreset(name);
  if (!preset) return false;
  runMainCast(preset, anchor, rowEl);
  return true;
}

/** Trigger the farewell (remove) effect if the name matches a known character. */
export function triggerCharacterFarewell(name: string, anchor: AnchorPoint): boolean {
  const preset = findPreset(name);
  if (!preset) return false;
  runFarewell(preset, anchor);
  return true;
}

// ─── Main cast (add) ───────────────────────────────────────────────────────

function runMainCast(preset: Preset, anchor: AnchorPoint, rowEl: Element | null): void {
  const { variant } = preset;
  const cx = anchor.x;
  const cy = anchor.y;

  // Backdrop. Dumbledore + non-Dark-Mark dark wizards (Draco) get the snappy
  // flash. Dark Mark casts (Voldemort / Tom Riddle) get a slower vignette
  // that closes in on the screen — more ominous, less Halloween clip-art.
  if (variant === 'dumbledore' || (variant === 'darkwizard' && !preset.darkMark)) {
    const flash = document.createElement('div');
    flash.className = `ee-flash ee-flash--${variant === 'dumbledore' ? 'white' : 'dark'}`;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 950);
  }

  if (preset.darkMark) {
    const vignette = document.createElement('div');
    vignette.className = 'ee-mark-vignette';
    document.body.appendChild(vignette);
    setTimeout(() => vignette.remove(), 3500);

    const mark = document.createElement('div');
    mark.className = 'ee-dark-mark';
    mark.innerHTML = DARK_MARK_SVG;
    document.body.appendChild(mark);
    setTimeout(() => mark.remove(), 3500);
  }

  // Darth Vader — red vignette closing in + helmet materializes from blur.
  if (variant === 'sith') {
    const vignette = document.createElement('div');
    vignette.className = 'ee-sith-vignette';
    document.body.appendChild(vignette);
    setTimeout(() => vignette.remove(), 3500);

    const helmet = document.createElement('div');
    helmet.className = 'ee-vader-helmet';
    helmet.innerHTML = VADER_HELMET_SVG;
    document.body.appendChild(helmet);
    setTimeout(() => helmet.remove(), 3500);
  }

  // Dumbledore: expanding ripple ring from the click point
  if (variant === 'dumbledore') {
    const ring = document.createElement('div');
    ring.className = 'ee-ring';
    ring.style.left = `${cx}px`;
    ring.style.top = `${cy}px`;
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 1200);
  }

  // Particle burst
  const particleCount =
    variant === 'dumbledore' ? 40 : variant === 'darkwizard' ? 24 : variant === 'sith' ? 22 : 28;
  const particleClass =
    variant === 'dumbledore'
      ? 'ee-particle--gold-large'
      : variant === 'darkwizard'
        ? 'ee-particle--green'
        : variant === 'professor'
          ? 'ee-particle--warm'
          : variant === 'sith'
            ? 'ee-particle--red'
            : 'ee-particle--gold';

  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('span');
    p.className = `ee-particle ${particleClass}`;
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 200;
    const dx = Math.cos(angle) * dist;
    let dy = Math.sin(angle) * dist;
    if (variant === 'darkwizard') dy -= 100 + Math.random() * 60;
    if (variant === 'professor') dy -= 30 + Math.random() * 30;
    if (variant === 'sith') dy += 30 + Math.random() * 50; // sparks fall like embers
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.setProperty('--ee-dx', `${dx}px`);
    p.style.setProperty('--ee-dy', `${dy}px`);
    p.style.setProperty('--ee-delay', `${Math.random() * 140}ms`);
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1900);
  }

  // Spell text overlay — duration scales with text length. For Dark Mark
  // and Sith casts, hold the text back ~900ms so it lands once the iconic
  // figure has materialized rather than fighting the summon for attention.
  const spellDurationMs = Math.min(4200, 1200 + preset.spell.length * 90);
  const spellDelayMs = preset.darkMark || variant === 'sith' ? 900 : 0;
  setTimeout(() => {
    const text = document.createElement('div');
    text.className = `ee-spell-text ee-spell-text--${variant}`;
    text.textContent = preset.spell;
    text.style.animationDuration = `${spellDurationMs}ms`;
    document.body.appendChild(text);
    setTimeout(() => text.remove(), spellDurationMs + 150);
  }, spellDelayMs);

  // Row glow (matches variant)
  if (rowEl) {
    const glowClass = `ee-row-glow--${variant}`;
    rowEl.classList.add('ee-row-glow', glowClass);
    setTimeout(() => {
      rowEl.classList.remove('ee-row-glow', glowClass);
    }, 3600);
  }
}

// ─── Farewell (remove) ─────────────────────────────────────────────────────

function runFarewell(preset: Preset, anchor: AnchorPoint): void {
  const { variant } = preset;
  const cx = anchor.x;
  const cy = anchor.y;

  // Dumbledore: phoenix feathers drift down across the screen.
  if (preset.feathersOnFarewell) {
    spawnPhoenixFeathers();
  }

  // Voldemort/Tom Riddle: faint Dark Mark dissolves slowly.
  if (preset.darkMark) {
    const mark = document.createElement('div');
    mark.className = 'ee-dark-mark ee-dark-mark--farewell';
    mark.innerHTML = DARK_MARK_SVG;
    document.body.appendChild(mark);
    setTimeout(() => mark.remove(), 2200);
  }

  // Vader: faint helmet dissolves slowly.
  if (variant === 'sith') {
    const helmet = document.createElement('div');
    helmet.className = 'ee-vader-helmet ee-vader-helmet--farewell';
    helmet.innerHTML = VADER_HELMET_SVG;
    document.body.appendChild(helmet);
    setTimeout(() => helmet.remove(), 2200);
  }

  // Gentle particle puff (fewer, slower than the cast).
  const particleClass =
    variant === 'dumbledore'
      ? 'ee-particle--gold-large'
      : variant === 'darkwizard'
        ? 'ee-particle--green'
        : variant === 'professor'
          ? 'ee-particle--warm'
          : variant === 'sith'
            ? 'ee-particle--red'
            : 'ee-particle--gold';
  const count = 10;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = `ee-particle ee-particle--farewell ${particleClass}`;
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 80;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 40;
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.setProperty('--ee-dx', `${dx}px`);
    p.style.setProperty('--ee-dy', `${dy}px`);
    p.style.setProperty('--ee-delay', `${Math.random() * 120}ms`);
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 2200);
  }

  // Farewell text — gentler than the cast.
  const text = document.createElement('div');
  text.className = `ee-farewell-text ee-farewell-text--${variant}`;
  text.textContent = preset.farewell;
  const durationMs = Math.min(3800, 1400 + preset.farewell.length * 70);
  text.style.animationDuration = `${durationMs}ms`;
  document.body.appendChild(text);
  setTimeout(() => text.remove(), durationMs + 150);
}

function spawnPhoenixFeathers(): void {
  const count = 14;
  for (let i = 0; i < count; i++) {
    const f = document.createElement('div');
    f.className = 'ee-feather';
    f.innerHTML = PHOENIX_FEATHER_SVG;
    f.style.left = `${5 + Math.random() * 90}vw`;
    f.style.setProperty('--ee-feather-drift', `${(Math.random() - 0.5) * 80}px`);
    f.style.setProperty('--ee-feather-spin', `${(Math.random() - 0.5) * 720}deg`);
    f.style.animationDelay = `${Math.random() * 700}ms`;
    f.style.animationDuration = `${2400 + Math.random() * 1800}ms`;
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 4500);
  }
}

// ─── Inline SVGs ───────────────────────────────────────────────────────────

const VADER_HELMET_SVG = `
<svg viewBox="0 0 200 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="ee-vader-aura" cx="50%" cy="40%" r="62%">
      <stop offset="0%" stop-color="#ff5060" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="#5a0a14" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ee-vader-fill" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#262626"/>
      <stop offset="50%" stop-color="#0d0d0d"/>
      <stop offset="100%" stop-color="#000"/>
    </linearGradient>
  </defs>

  <ellipse cx="100" cy="115" rx="96" ry="125" fill="url(#ee-vader-aura)"/>

  <!-- Helmet silhouette: dome + side flares + chin guard -->
  <path d="M 100 12
           C 70 12, 48 38, 44 70
           C 42 92, 46 110, 52 124
           L 56 138
           Q 50 150, 52 162
           L 62 178
           C 64 192, 76 204, 92 208
           L 108 208
           C 124 204, 136 192, 138 178
           L 148 162
           Q 150 150, 144 138
           L 148 124
           C 154 110, 158 92, 156 70
           C 152 38, 130 12, 100 12 Z"
        fill="url(#ee-vader-fill)" stroke="#3a3a3a" stroke-width="1.6" stroke-linejoin="round"/>

  <!-- Dome highlights (subtle catch on top-left) -->
  <path d="M 64 32 Q 80 18, 100 18" stroke="#5a5a5a" stroke-width="1.5" fill="none" opacity="0.5"/>
  <path d="M 50 64 Q 56 50, 68 42" stroke="#4a4a4a" stroke-width="1" fill="none" opacity="0.4"/>

  <!-- Eye lenses: trapezoidal, angled into a menacing inverse-V -->
  <path d="M 56 88 L 92 78 L 92 100 L 58 108 Z"
        fill="#000" stroke="#3a3a3a" stroke-width="1.2"/>
  <path d="M 144 88 L 108 78 L 108 100 L 142 108 Z"
        fill="#000" stroke="#3a3a3a" stroke-width="1.2"/>

  <!-- Eye lens red glints (subtle reflection) -->
  <path d="M 60 92 L 86 86" stroke="#ff3b50" stroke-width="0.9" opacity="0.55"/>
  <path d="M 140 92 L 114 86" stroke="#ff3b50" stroke-width="0.9" opacity="0.55"/>

  <!-- Nose ridge between eye lenses -->
  <path d="M 100 84 L 94 122 L 100 128 L 106 122 Z"
        fill="#1a1a1a" stroke="#3a3a3a" stroke-width="0.8"/>

  <!-- Mouth grille backdrop -->
  <rect x="78" y="138" width="44" height="32" rx="2"
        fill="#0a0a0a" stroke="#3a3a3a" stroke-width="1.2"/>

  <!-- Grille vertical bars -->
  <g stroke="#3a3a3a" stroke-width="1" fill="none">
    <line x1="84" y1="140" x2="84" y2="168"/>
    <line x1="92" y1="140" x2="92" y2="168"/>
    <line x1="100" y1="140" x2="100" y2="168"/>
    <line x1="108" y1="140" x2="108" y2="168"/>
    <line x1="116" y1="140" x2="116" y2="168"/>
  </g>

  <!-- Side temple intake vents -->
  <rect x="46" y="124" width="10" height="14" rx="1.5"
        fill="#0a0a0a" stroke="#3a3a3a" stroke-width="0.8"/>
  <rect x="144" y="124" width="10" height="14" rx="1.5"
        fill="#0a0a0a" stroke="#3a3a3a" stroke-width="0.8"/>

  <!-- Side red status lights -->
  <circle cx="51" cy="148" r="2" fill="#ff3b50" opacity="0.85"/>
  <circle cx="149" cy="148" r="2" fill="#ff3b50" opacity="0.85"/>

  <!-- Chin guard -->
  <path d="M 78 170 L 122 170 L 118 196 L 100 208 L 82 196 Z"
        fill="#0a0a0a" stroke="#3a3a3a" stroke-width="1.4"/>

  <!-- Chin highlight seam -->
  <path d="M 88 178 L 112 178" stroke="#3a3a3a" stroke-width="0.6" opacity="0.6"/>
</svg>`;

const DARK_MARK_SVG = `
<svg viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="ee-mark-aura" cx="50%" cy="38%" r="62%">
      <stop offset="0%" stop-color="#9ad6b8" stop-opacity="0.42"/>
      <stop offset="60%" stop-color="#1a4030" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ee-skull-fill" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1c4630"/>
      <stop offset="100%" stop-color="#06180e"/>
    </linearGradient>
    <linearGradient id="ee-snake-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#b4dec3"/>
      <stop offset="55%" stop-color="#5a8d6c"/>
      <stop offset="100%" stop-color="#1a3a2a"/>
    </linearGradient>
  </defs>

  <ellipse cx="100" cy="116" rx="96" ry="132" fill="url(#ee-mark-aura)"/>

  <!-- Cranium silhouette: rounded top, narrowing to jaw and chin -->
  <path d="M 100 14
           C 60 14, 36 46, 36 88
           C 36 118, 44 142, 54 162
           L 60 175
           Q 65 185, 74 192
           L 80 215
           Q 100 224, 120 215
           L 126 192
           Q 135 185, 140 175
           L 146 162
           C 156 142, 164 118, 164 88
           C 164 46, 140 14, 100 14 Z"
        fill="url(#ee-skull-fill)" stroke="#9ad6b8" stroke-width="1.8" stroke-linejoin="round"/>

  <!-- Cranial sutures -->
  <path d="M 100 18 Q 96 42, 102 70 Q 105 92, 100 110"
        stroke="#9ad6b8" stroke-width="0.6" fill="none" opacity="0.45"/>
  <path d="M 56 100 Q 50 116, 56 132"
        stroke="#9ad6b8" stroke-width="0.5" fill="none" opacity="0.32"/>
  <path d="M 144 100 Q 150 116, 144 132"
        stroke="#9ad6b8" stroke-width="0.5" fill="none" opacity="0.32"/>

  <!-- Eye sockets — slanted, deeply hollow -->
  <path d="M 64 76 Q 80 64, 94 82 Q 96 102, 88 116 Q 76 122, 66 116 Q 56 108, 56 96 Q 56 84, 64 76 Z"
        fill="#000" stroke="#9ad6b8" stroke-width="1.4"/>
  <path d="M 136 76 Q 120 64, 106 82 Q 104 102, 112 116 Q 124 122, 134 116 Q 144 108, 144 96 Q 144 84, 136 76 Z"
        fill="#000" stroke="#9ad6b8" stroke-width="1.4"/>

  <!-- Faint glints inside the sockets -->
  <ellipse cx="76" cy="100" rx="2.6" ry="4" fill="#9ad6b8" opacity="0.42"/>
  <ellipse cx="124" cy="100" rx="2.6" ry="4" fill="#9ad6b8" opacity="0.42"/>

  <!-- Cheek hollow shading -->
  <path d="M 56 145 Q 64 158, 76 162" stroke="#9ad6b8" stroke-width="1" fill="none" opacity="0.5"/>
  <path d="M 144 145 Q 136 158, 124 162" stroke="#9ad6b8" stroke-width="1" fill="none" opacity="0.5"/>

  <!-- Nasal aperture -->
  <path d="M 100 124 Q 92 144, 95 158 Q 100 164, 105 158 Q 108 144, 100 124 Z"
        fill="#000" stroke="#9ad6b8" stroke-width="1.1"/>

  <!-- Tooth row backdrop -->
  <rect x="74" y="178" width="52" height="22" fill="#000" stroke="#9ad6b8" stroke-width="1.2"/>

  <!-- Individual gritted teeth -->
  <g fill="#1a3a2a" stroke="#9ad6b8" stroke-width="0.6">
    <path d="M 74 178 L 78 196 L 82 178 Z"/>
    <path d="M 82 178 L 86 198 L 90 178 Z"/>
    <path d="M 90 178 L 94 196 L 98 178 Z"/>
    <path d="M 98 178 L 102 198 L 106 178 Z"/>
    <path d="M 106 178 L 110 196 L 114 178 Z"/>
    <path d="M 114 178 L 118 198 L 122 178 Z"/>
    <path d="M 122 178 L 126 196 L 124 178 Z"/>
  </g>

  <!-- Serpent emerging from the mouth — sweeping double curve -->
  <path d="M 100 220
           C 76 232, 60 254, 80 266
           C 102 276, 132 264, 140 244
           C 146 226, 124 220, 112 232"
        stroke="url(#ee-snake-grad)" stroke-width="11" stroke-linecap="round" fill="none"/>

  <!-- Scale stipple highlight -->
  <path d="M 100 220 C 76 232, 60 254, 80 266 C 102 276, 132 264, 140 244 C 146 226, 124 220, 112 232"
        stroke="#0a1f12" stroke-width="2.2" stroke-linecap="round"
        stroke-dasharray="0.7 4" fill="none" opacity="0.65"/>

  <!-- Snake head — diamond/arrow shape -->
  <path d="M 112 232 L 122 226 L 126 232 L 122 240 L 114 240 Z"
        fill="#5a8d6c" stroke="#b4dec3" stroke-width="1.2"/>

  <!-- Snake eye -->
  <ellipse cx="119" cy="231" rx="1.4" ry="1.1" fill="#dfffea"/>
  <circle cx="119" cy="231" r="0.5" fill="#000"/>

  <!-- Forked tongue -->
  <path d="M 126 232 L 132 230 L 134 227 M 126 232 L 132 234 L 134 237"
        stroke="#7a1818" stroke-width="1.1" fill="none" stroke-linecap="round"/>
</svg>`;

const PHOENIX_FEATHER_SVG = `
<svg viewBox="0 0 24 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="ee-feather-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fff8d0"/>
      <stop offset="40%" stop-color="#ffd966"/>
      <stop offset="100%" stop-color="#c9501a"/>
    </linearGradient>
  </defs>
  <path d="M 12 2 Q 22 18 18 38 Q 14 52 12 58 Q 10 52 6 38 Q 2 18 12 2 Z"
        fill="url(#ee-feather-grad)" stroke="#9c4012" stroke-width="0.6"/>
  <line x1="12" y1="6" x2="12" y2="56" stroke="#9c4012" stroke-width="0.6"/>
</svg>`;
