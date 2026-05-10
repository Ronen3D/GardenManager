/**
 * Tutorial content — pure data. All tracks, steps, and Hebrew copy live here.
 * No DOM, no behaviour, no imports beyond types. Editing a step is a one-line
 * change in this file; the engine in `tutorial.ts` reads the data unchanged.
 */

import type { TutorialContext, TutorialTrack } from './tutorial';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const hasSchedule = (ctx: TutorialContext) => {
  const s = ctx.getSchedule() as { assignments?: unknown[] } | null;
  return s != null && (s.assignments?.length ?? 0) > 0;
};

const isLiveModeOn = (ctx: TutorialContext) => ctx.isLiveModeEnabled();

/** Look up a step by id within a track. Throws if missing — used by the
 * full-tour composer so renames in source tracks fail loudly at module load
 * instead of silently picking the wrong step via a stale array index. */
const stepById = (track: TutorialTrack, id: string) => {
  const s = track.steps.find((step) => step.id === id);
  if (!s) throw new Error(`tutorial-content: step "${id}" not found in track "${track.id}"`);
  return s;
};

// ─── Track: participants (8 steps) ───────────────────────────────────────────

const PARTICIPANTS_TRACK: TutorialTrack = {
  id: 'participants',
  label: 'משתתפים',
  icon: '👥',
  description: 'הוספה · עריכה · העדפות',
  switchToTab: 'participants',
  steps: [
    {
      id: 'p-1',
      target: 'button.tab-btn[data-tab="participants"]',
      placement: 'bottom',
      title: 'לשונית המשתתפים',
      body: 'כאן מגדירים את כל אנשי הצוות. כל משתתף שיוגדר כאן ייכלל אוטומטית בחישוב השבצ"ק — ללא משתתפים, אין מה לשבץ.',
    },
    {
      id: 'p-2',
      target: '[data-action="add-participant"]',
      placement: 'bottom',
      title: 'הוספת משתתף',
      body: 'לחץ כאן לפתיחת טופס הוספה — שם, קבוצה ורמה, ואז <strong>✓ שמור</strong>. כל שדה משפיע על המשמרות שיוצעו למשתתף.',
    },
    {
      id: 'p-3',
      target: '#add-participant-form',
      placement: 'inline-end',
      title: 'שדות מרכזיים',
      body: '<strong>שם</strong> — חופשי. <strong>קבוצה</strong> — קריטית למשימות שדורשות קבוצה אחידה (כמו אדנית). <strong>רמה</strong> — L0 (מתחיל) / L2 / L3 / L4 (בכיר); אין L1 במערכת. הרמה קובעת באילו משבצות המשתתף יוכל להשתבץ. <strong>הסמכות</strong> — פותחות גישה למשבצות מיוחדות.',
      bodyFallback:
        'בעת פתיחת טופס ההוספה תראה את השדות המרכזיים: <strong>שם</strong>, <strong>קבוצה</strong>, <strong>רמה</strong> (L0–L4), ו<strong>הסמכות</strong>. כל שדה משפיע על המשמרות שיוצעו.',
      precondition: () => !!document.querySelector('#add-participant-form'),
    },
    {
      id: 'p-4',
      target: '.pill[data-action="filter-group"]',
      placement: 'bottom',
      title: 'סינון לפי קבוצה',
      body: 'לחץ על כפתור קבוצה כדי לסנן את הטבלה ולראות רק את חבריה. שימושי לוודא שלכל קבוצה יש מספיק משתתפים ברמות הנדרשות לפני יצירת שבצ"ק.',
      bodyFallback: 'לאחר הוספת משתתפים מקבוצות שונות, יופיעו כאן כפתורי סינון לפי קבוצה.',
      precondition: () => !!document.querySelector('.pill[data-action="filter-group"]'),
    },
    {
      id: 'p-5',
      target: '.unavail-edit-toggle[data-action="toggle-blackouts"]',
      placement: 'inline-start',
      title: 'אי-זמינות',
      body: 'כאן מגדירים מתי המשתתף לא זמין — למשל יום 3 אחה"צ. המערכת תמנע אוטומטית שיבוץ במשמרות חופפות. <em>(פתחתי לך את שורת העריכה של המשתתף הראשון להדגמה.)</em>',
      bodyFallback:
        'לכל משתתף ניתן להגדיר חלונות אי-זמינות — ימים ושעות שבהם <strong>לא</strong> ישובץ. הוסף משתתף ראשון כדי לראות איפה.',
      expandFirstParticipant: true,
      precondition: () => !!document.querySelector('.unavail-edit-toggle[data-action="toggle-blackouts"]'),
    },
    {
      id: 'p-5b',
      target: '[data-field="workloadMultiplier"]',
      placement: 'inline-start',
      title: 'מקדם עומס ופק"לים',
      body: '<strong>מקדם עומס</strong> — מספר שמשנה את מטרת חלוקת השעות של המשתתף (1.0 = ברירת מחדל; 1.5 = יקבל ~50% יותר; 0.5 = ~50% פחות; טווח 0.3–5.0). תג <strong>×N</strong> בעמודת הרמה מציין שהמקדם שונה מ-1. בעמודת <strong>פק"לים</strong> — תיבות סימון להסמכות תפעוליות צמודות לאדם (מוגדרות בהגדרות ← הסמכות ופק"לים). <em>(שורת העריכה פתוחה להדגמה.)</em>',
      bodyFallback:
        'בשורת העריכה של כל משתתף יופיעו: <strong>מקדם עומס</strong> (משנה את מטרת חלוקת השעות שלו) ועמודת <strong>פק"לים</strong> (הסמכות תפעוליות נוספות).',
      expandFirstParticipant: true,
      precondition: () => !!document.querySelector('[data-field="workloadMultiplier"]'),
    },
    {
      id: 'p-6',
      target: '[data-action="enter-table-edit"]',
      placement: 'bottom',
      title: 'עריכת טבלה מהירה',
      body: 'מצב עריכת טבלה מאפשר לשנות שדות של כמה משתתפים בו-זמנית — יעיל לעדכון קבוצות או רמות בצובר. <strong>✓ אשר</strong> שומר את כל השינויים יחד. במובייל: כפתור <strong>+ מהיר</strong> פותח גיליון להוספת מספר משתתפים יחד עם ברירות מחדל משותפות.',
    },
    {
      id: 'p-6b',
      target: '.participants-table',
      placement: 'top',
      title: 'בחירה מרובה ופעולות בצובר',
      body: 'תיבות הסימון משמאל לכל שורה מאפשרות בחירה מרובה. עם בחירה ≥ 1 תופיע סרגל פעולות: <strong>מחק משתתפים</strong> ו<strong>הוסף חוסר זמינות</strong> בצובר. קיצור: לחיצה על תג קבוצה בוחרת את כל חבריה; Shift/Ctrl-click מצרפת בחירות.',
    },
    {
      id: 'p-7',
      target: '.participants-table',
      placement: 'top',
      title: 'העדפות משימה',
      body: 'בעריכת משתתף תוכל להגדיר משימה <strong>מועדפת</strong> ו<strong>פחות-מועדפת</strong>. אלו אילוצים רכים — האופטימייזר יעדיף לכבד אותם, אך אינו מחויב לכך.',
    },
    {
      id: 'p-8',
      target: '[data-action="pset-panel-toggle"]',
      placement: 'bottom',
      title: 'מערכי משתתפים',
      body: 'מערך הוא תמונת מצב של הצוות — שמות, רמות, הסמכות. שמור כמה מערכים ועבור ביניהם (החלפה אינה מוחקת שבצ"ק קיים). בפנים: <strong>📊 ייבוא Excel</strong> לטעינת רוסטר מגיליון, <strong>עדכן</strong> לשמירת שינויים על מערך פעיל (תג "שונה" מסמן זאת), <strong>שכפל / שנה שם / ייצא JSON או Excel</strong> לכל מערך.',
    },
  ],
};

// ─── Track: task-rules (9 steps) ─────────────────────────────────────────────

const TASK_RULES_TRACK: TutorialTrack = {
  id: 'task-rules',
  label: 'כללי משימות',
  icon: '📋',
  description: 'תבניות · משמרות · הגבלות',
  switchToTab: 'task-rules',
  steps: [
    {
      id: 't-1',
      target: 'button.tab-btn[data-tab="task-rules"]',
      placement: 'bottom',
      title: 'לשונית כללי משימות',
      body: 'כאן מגדירים אילו משימות קיימות וכל כללי השיבוץ שלהן. שינויים משפיעים על השבצ"ק <strong>הבא</strong> שייווצר — שבצ"ק שכבר נוצר אינו נפגע.',
    },
    {
      id: 't-2',
      target: '[data-action="toggle-add-template"]',
      placement: 'bottom',
      title: 'הוספת תבנית',
      body: 'תבנית היא "מתכון" חוזר — למשל אדנית, 3 משמרות ביום, 8 שעות כל אחת. המערכת תייצר ממנה משמרות אוטומטית לכל ימות השבצ"ק.',
    },
    {
      id: 't-3',
      target: '.template-list',
      placement: 'top',
      title: 'כרטיסיות התבניות',
      body: 'כל תבנית מוצגת ככרטיסייה. <strong>לחץ על הכותרת כדי להרחיב</strong> ולערוך — שם, מספר משמרות ביום, שעת התחלה ומשך. שעות התחלה וסיום של כל משמרת מחושבות אוטומטית.',
      bodyFallback: 'לאחר הוספת תבנית ראשונה, היא תופיע כאן ככרטיסייה הניתנת להרחבה ועריכה.',
      precondition: () => !!document.querySelector('.template-card'),
    },
    {
      id: 't-4',
      target: '.template-list',
      placement: 'top',
      title: 'משבצות',
      body: 'כל תבנית מורכבת ממשבצות — כל משבצת מייצגת תפקיד אחד שיש לאייש. לכל משבצת מגדירים: <strong>רמות מותרות</strong> (לחיצה על תג רמה מחליפה בין רגיל / <strong>~</strong> עדיפות-נמוכה / כבוי), <strong>הסמכות נדרשות</strong>, ו<strong>הסמכות אסורות</strong> (פוסלות מחזיקי הסמכה ספציפית). <em>(לחץ "+ משבצת" בתוך כרטיסיית תבנית כדי להוסיף.)</em>',
      bodyFallback:
        'בכל תבנית תוכל להוסיף משבצות — כל משבצת היא תפקיד אחד עם <strong>רמות מותרות</strong> (לכל רמה: רגיל / ~ עדיפות-נמוכה / כבוי), <strong>הסמכות נדרשות</strong>, ו<strong>הסמכות אסורות</strong>.',
      precondition: () => !!document.querySelector('.template-card'),
    },
    {
      id: 't-5',
      target: '.template-card [data-tpl-field="sameGroupRequired"]',
      placement: 'inline-start',
      title: 'קבוצה אחידה',
      body: 'כשמסומן — כל המשובצים במשמרת חייבים להיות מאותה קבוצה. מתאים למשימות שדורשות צוות מגובש, כמו אדנית.',
      bodyFallback: 'לכל תבנית יש מתג "קבוצה אחידה". כשמופעל, כל המשובצים במשמרת חייבים להגיע מאותה קבוצה.',
      expandFirstTemplate: true,
      precondition: () => !!document.querySelector('.template-card [data-tpl-field="sameGroupRequired"]'),
    },
    {
      id: 't-6',
      target: '.template-card [data-tpl-field="blocksConsecutive"]',
      placement: 'inline-start',
      title: 'חסימת רצף',
      body: 'כשמופעל — האופטימייזר ימנע משמרות "כבדות" רצופות לאותו אדם. חיוני למשימות ארוכות; השאר כבוי למשימות קצרות.',
      bodyFallback:
        'כל תבנית יכולה לחסום רצף משמרות — כשמופעל, האופטימייזר לא ישבץ את אותו משתתף לשתי משמרות כבדות רצופות.',
      expandFirstTemplate: true,
      precondition: () => !!document.querySelector('.template-card [data-tpl-field="blocksConsecutive"]'),
    },
    {
      id: 't-7',
      target: '[data-action="add-rest-rule"]',
      placement: 'bottom',
      title: 'כללי מרווח',
      body: 'כלל מרווח מגדיר מינימום שעות מנוחה בין שתי משמרות שכפופות לאותו כלל — למשל "הפסקה מינימלית 5 שעות". כלל אחד יכול לשמש מספר תבניות.',
    },
    {
      id: 't-7b',
      target: '.template-card [data-action="toggle-sleep-recovery"]',
      placement: 'inline-start',
      title: 'השלמות שינה והתאוששות (HC-15)',
      body: 'מנגנון נפרד לכללי מרווח: בוחרים אילו <strong>משמרות-טריגר</strong> בתבנית מפעילות חלון התאוששות (במספרי 1, 2, 3...), ואז <strong>שעות התאוששות</strong> שבהן לא ישובץ שום משימה אחרת בעלת עומס. לדוגמה: סיום משמרת לילה (משמרת 3) → 12 שעות בלי שיבוץ נוסף. אילוץ <strong>קשה</strong> — אם מופר, השבצ"ק פסול.',
      bodyFallback:
        'בכל תבנית יש סעיף <strong>השלמות שינה והתאוששות</strong> (HC-15) — בוחרים משמרות-טריגר ושעות התאוששות שבהן המשתתף שסיים משמרת כזו לא ישובץ למשימה אחרת.',
      expandFirstTemplate: true,
      precondition: () => !!document.querySelector('.template-card [data-action="toggle-sleep-recovery"]'),
    },
    {
      id: 't-8',
      target: '.template-card [data-action="open-load-formula"]',
      placement: 'inline-start',
      title: 'נוסחת עומס',
      body: 'קובעת כמה "כבד" נחשב כל שעה של המשמרת לחישוב חלוקת עומס בין המשתתפים. בדרך-כלל אין צורך לשנות את ברירת המחדל. אחרי הגדרה, כפתור <strong>ℹ️</strong> ליד הערך מציג את הפירוט בשפה ברורה ואזהרות אם הנוסחה התיישנה.',
      bodyFallback: 'בכל תבנית יש כפתור 🧮 לפתיחת נוסחת העומס — מגדיר כמה "כבד" נחשב כל שעה לעניין חלוקה הוגנת.',
      screenshot: { src: './tutorial/load-formula.png', alt: 'חלון נוסחת עומס — השוואה בין משימות' },
      expandFirstTemplate: true,
      precondition: () => !!document.querySelector('.template-card [data-action="open-load-formula"]'),
    },
    {
      id: 't-8b',
      target:
        '.template-card [data-action="add-load-window"], .template-card [data-action="add-load-window-and-compute"]',
      placement: 'inline-start',
      title: 'חלונות עומס מוגבר',
      body: 'מאפשרים להגדיר ש<em>חלק מהמשמרת</em> נחשב יותר עומס — למשל החלק 06:00–08:00 שוקל ×0.8, או החצי הראשון של משמרת לילה. בכל חלון: טווח שעות, משקל (0–1), ו<strong>חוסם בקצה</strong> — אם מסומן, חלון שנוגע בקצה המשמרת חוסם רצף עם משמרת סמוכה (אילוץ ברמת חלון, נפרד מ"חוסמת רצף" שברמת התבנית).',
      bodyFallback:
        'בכל תבנית ניתן להוסיף <strong>חלונות עומס מוגבר</strong> — חלקי המשמרת ששוקלים יותר. כל חלון מקבל טווח, משקל (0–1) ואופציית "חוסם בקצה".',
      expandFirstTemplate: true,
      precondition: () =>
        !!document.querySelector(
          '.template-card [data-action="add-load-window"], .template-card [data-action="add-load-window-and-compute"]',
        ),
    },
    {
      id: 't-9',
      target: '.score-card.inline-badge',
      placement: 'bottom',
      title: 'מוכנות לשיבוץ',
      body: 'תג זה מסכם את הבדיקה המקדימה הכוללת — <strong>קריטי</strong> אדום / <strong>אזהרה</strong> כתום / <strong>בסדר</strong> ירוק. בנוסף, כל כרטיסיית תבנית מציגה תג <strong>!</strong> או <strong>⚠</strong> ספציפי לתבנית עצמה (פערי כשירות, הסמכות ריקות, חוסר זמינות יומית, ועוד) — לחיצה על התג פותחת רשימה ממוקדת. ממצא קריטי ימנע יצירת שבצ"ק.',
      bodyFallback:
        'בראש הלשונית יופיע תג מוכנות — אדום / כתום / ירוק — שמסכם את הבדיקה המקדימה לפני יצירת שבצ"ק. כל תבנית גם תקבל תג ספציפי משלה.',
      precondition: () => !!document.querySelector('.score-card.inline-badge'),
    },
    {
      id: 't-10',
      target: '[data-action="tset-panel-toggle"]',
      placement: 'bottom',
      title: 'סטים של משימות',
      body: 'בדומה למערכי משתתפים: שמור גרסאות מלאות של כללי המשימות (תבניות + משימות חד-פעמיות + כללי מרווח) ועבור ביניהן. שימושי ל"חורף" / "קיץ" / "שבת". <strong>שים לב</strong>: טעינת סט מחליפה את שלושת הרכיבים ביחד. תג "שונה" מסמן שערכת את הסט הפעיל ולא שמרת.',
      bodyFallback:
        'כפתור 📋 <strong>סטים</strong> בראש הלשונית פותח את ניהול סטי-המשימות — שמירת והחלפה של גרסאות שלמות (תבניות + משימות חד-פעמיות + כללי מרווח).',
      precondition: () => !!document.querySelector('[data-action="tset-panel-toggle"]'),
    },
  ],
};

// ─── Track: schedule (15 steps) ──────────────────────────────────────────────

const SCHEDULE_TRACK: TutorialTrack = {
  id: 'schedule',
  label: 'שבצ"ק',
  icon: '📅',
  description: 'יצירה · מצב חי · חילוץ',
  switchToTab: 'schedule',
  steps: [
    {
      id: 's-1',
      target: '#btn-generate',
      placement: 'bottom',
      title: 'יצירת שבצ"ק',
      body: 'שדה "ימים" קובע את אורך התקופה (1–7 ימים). לחץ <strong>⚡ צור שבצ"ק</strong> להפעלת האופטימייזר. ההודעה "⚠ השיבוץ לא מעודכן" מופיעה כשמשנים נתונים לאחר היצירה — צור מחדש לעדכון.',
    },
    {
      id: 's-2',
      target: '#input-scenarios',
      placement: 'bottom',
      title: 'ניסיונות אופטימיזציה',
      body: 'כל ניסיון מפעיל מחזור שלם של בנייה ושיפור. ברירת המחדל (60 ניסיונות) מתאימה לצוות גדול; לצוות עד 20 משתתפים, 10–20 ניסיונות מספיקים ומסיימים תוך שניות. במהלך הריצה תופיע שכבת אופטימיזציה עם התקדמות, וכפתור <strong>לשבצ"ק (סיים עכשיו)</strong> לקבלת התוצאה הטובה ביותר עד כה.',
    },
    {
      id: 's-3',
      target: '.weekly-dashboard',
      placement: 'bottom',
      title: 'לוח מדדים',
      body: '✓ "ישים" — כל התנאים המחייבים עברו. ✗ "לא ישים" — יש הפרה שחובה לתקן. הציון הנומרי (נמוך = מאוזן יותר) מסכם קנסות מתנאים רכים. לחץ על תא האזהרות הכתום לקפיצה ישירה לחלונית ההפרות.',
      bodyFallback: 'לאחר יצירת שבצ"ק יופיע כאן לוח מדדים: ישימות (✓ / ✗), ציון מסכם, ומספר אזהרות.',
      precondition: hasSchedule,
    },
    {
      id: 's-4',
      target: '.day-navigator',
      placement: 'bottom',
      title: 'ניווט בין ימים',
      body: 'כל כרטיסייה = יום תפעולי (יום 1 עד יום 7). נקודה אדומה = יש הפרות ביום. ❄ = היום קפוא לפני עוגן מצב חי (לא ניתן לעריכה). ⏳ = היום מוקפא חלקית (מכיל את העוגן). יום 0, אם קיים, מציג שיבוצים מהשבצ"ק הקודם — לקריאה בלבד.',
      bodyFallback:
        'לאחר יצירת שבצ"ק יופיע כאן סרגל ניווט בין הימים — כל כרטיסייה = יום תפעולי. סימני אזהרה מציינים ימים עם הפרות.',
      precondition: hasSchedule,
    },
    {
      id: 's-5',
      target: '.schedule-grid-container',
      placement: 'top',
      title: 'טבלת השיבוץ',
      body: 'כל שורה = פרק זמן; כל תא = משתתף משובץ או ריק. מתחת לטבלה: תצוגת <strong>רצועות</strong> (swimlane) ו<strong>גאנט</strong>. לחיצה על שם משתתף פותחת את הכרטיס האישי שלו.',
      bodyFallback: 'טבלת השיבוץ תופיע כאן לאחר יצירת שבצ"ק. כל תא = משתתף משובץ; לחיצה על שם פותחת את הכרטיס האישי.',
      precondition: hasSchedule,
    },
    {
      id: 's-6',
      target: '.participant-sidebar',
      placement: 'inline-start',
      title: 'סרגל עומס עבודה',
      body: 'מציג שעות אפקטיביות לכל משתתף — צעירים (L0) ובכירים מוצגים בנפרד (החלק הסגלי 👤 מוסתר כברירת מחדל; הפעל אותו ע"י המתג בראש הסרגל). הפס הכהה = העומס שנצבר עד היום הנוכחי. <strong>לחץ על שם</strong> לפתיחת הכרטיס האישי. <strong>לחץ על הפס</strong> לפתיחת חלון פיזור יומי — סרגל מיני לכל יום + סימון פיק/היום.',
      bodyFallback:
        'בצד השבצ"ק יופיע סרגל עומס — שעות אפקטיביות לכל משתתף, צעירים ובכירים בנפרד. לחיצה על שם פותחת את הכרטיס האישי.',
      precondition: hasSchedule,
      mobileOverride: {
        target: '.sidebar-fab',
        body: 'במובייל סרגל העומס מוסתר — לחץ על הכפתור הצף בפינה לפתיחתו. מציג שעות אפקטיביות לכל משתתף; לחיצה על שם פותחת את הכרטיס האישי.',
      },
    },
    {
      id: 's-7',
      target: '#violations-section',
      placement: 'top',
      title: 'אזהרות והפרות',
      body: '<strong>הפרות מחייבות (HC)</strong> — שבצ"ק אינו ישים; חובה לתקן. <strong>אזהרות רכות (SC)</strong> — קנסות שמורידים את הציון אך השבצ"ק עדיין תקף. ניתן לקפל ולפתוח כל קטגוריה; הפרות מסודרות לפי יום.',
      bodyFallback:
        'אם יהיו הפרות בשבצ"ק, חלונית ההפרות תרכז אותן כאן — הפרות מחייבות (HC) שדורשות תיקון, ואזהרות רכות (SC) שגורמות לקנסות בציון.',
      precondition: hasSchedule,
    },
    {
      id: 's-8',
      target: '.schedule-grid-container',
      placement: 'top',
      title: 'החלפה ידנית',
      body: 'לחיצה על ⇄ בכל תא פותחת את בורר ההחלפות. מצב <strong>חופשי</strong> — בחר ממלא חדש למשבצת. מצב <strong>החלפה</strong> — עסקה הדדית בין שני משתתפים. תצוגה מקדימה מציגה את השפעת השינוי. סינונים: חיפוש, צ\'יפים של קבוצה/רמה, מיון. אם אין כשירים — <strong>מצב אבחון</strong> מציג את כל המסומנים עם סיבת הפסילה. תיבת <strong>"סמן ___ כלא-זמין"</strong> רושמת אוטומטית את המוחלף כלא-זמין לחלון המשבצת. כל החלפה ניתנת לביטול ב-↪ <strong>ביטול</strong> בכותרת.',
      bodyFallback:
        'בכל תא של השיבוץ יופיע כפתור ⇄ לפתיחת בורר החלפות — חופשי או הדדי, עם תצוגה מקדימה של השפעת השינוי.',
      precondition: hasSchedule,
    },
    {
      id: 's-9',
      target: '#chk-live-mode',
      placement: 'bottom',
      title: 'מצב חי',
      body: 'סמן את התיבה ובחר עוגן (יום + שעה). שיבוצים <strong>לפני</strong> העוגן — קפואים ובלתי-עבירים. שיבוצים <strong>אחריו</strong> — ניתנים לעריכה, חילוץ, והזרקת משימות חירום. הפעל בעת ניהול שבצ"ק בזמן אמת.',
      bodyFallback:
        'לאחר יצירת שבצ"ק יופיע כאן מתג <strong>מצב חי</strong>. בחר עוגן (יום + שעה) — שיבוצים לפניו קפואים, ושיבוצים אחריו ניתנים לעריכה, חילוץ והזרקת משימות חירום.',
      precondition: hasSchedule,
    },
    {
      id: 's-10',
      target: '.schedule-grid-container',
      placement: 'top',
      title: 'חילוץ — מילוי משבצת ריקה',
      body: 'במצב חי, משבצת פנויה בעתיד מציגה כפתור ⛑. האופטימייזר מחפש שרשרת החלפות (עומק 1 עד 3) שמשאירה את השבצ"ק תקף והוגן. עומק 4 מוצג רק כמוצא אחרון, עם אזהרה. גם כאן תיבת <strong>"סמן את המוחלף כלא-זמין"</strong> רושמת את היוצא לחלון המשבצת — לקיבוע ההחלטה לעתיד.',
      bodyFallback:
        'הפעל מצב חי וקבע עוגן — ואז על כל משבצת פנויה בעתיד יופיע כפתור ⛑ <strong>חילוץ</strong>. האופטימייזר מציע שרשרת החלפות שממלאת את המשבצת במינימום שיבוש.',
      precondition: (ctx) => hasSchedule(ctx) && isLiveModeOn(ctx),
    },
    {
      id: 's-10b',
      target: '#btn-where-is-everyone',
      placement: 'bottom',
      title: 'תמונת מצב — איפה כולם?',
      body: 'תצוגה ייעודית שעונה "מי איפה" בנקודת זמן בודדת — בחר יום + שעה ותראה את כל המשתתפים ממוינים ל<strong>משובצים / במנוחה / לא זמינים / פנויים</strong>. שימושי לתכנון אד-הוק וזיהוי "פנאי לא מנוצל".',
      bodyFallback:
        'לאחר יצירת שבצ"ק יופיע כפתור 👥 <strong>תמונת מצב</strong> — תצוגה שמראה איפה כל אחד נמצא בזמן ספציפי שתבחר.',
      precondition: hasSchedule,
    },
    {
      id: 's-10c',
      target: '.avail-strip-inputs-row, [data-action*="availability"], .avail-strip-chip',
      placement: 'top',
      title: 'בדיקת עתודה פנויה',
      body: 'סרגל מתקפל בין הגריד לגאנט: "מי פנוי בין שעה X לשעה Y?". סנן לפי <strong>רמה / הסמכה / קבוצה</strong>, הוסף <strong>שולי בטחון</strong> לפני/אחרי, או הפעל <strong>מצב השלמת שינה</strong> לסינון מי שעדיין בחלון התאוששות (HC-15). נקודת הכניסה למציאת ממלאי-מקום מהירים.',
      bodyFallback:
        'מתחת לטבלה יש סרגל "🕐 בדיקת עתודה פנויה" — מציג מי פנוי בטווח שעות שתבחר, עם סינון לפי רמה/הסמכה/קבוצה ותמיכה בחלונות התאוששות.',
      precondition: () => !!document.querySelector('[data-action*="availability-strip"], .avail-strip-chip'),
    },
    {
      id: 's-11',
      target: '#btn-manual-build',
      placement: 'bottom',
      title: 'בנייה ידנית',
      body: 'לחץ לפתיחת שבצ"ק ריק לאיוש ידני. בחר משבצת בטבלה — נפתח מחסן משתתפים מסונן לפי כשירות. שורת הסטטוס מציגה את התקדמות האיוש. <strong>↩ ביטול</strong> מבטל את הפעולה האחרונה.',
      screenshot: { src: './tutorial/manual-warehouse.png', alt: 'מחסן המשתתפים במצב בנייה ידנית' },
    },
    {
      id: 's-12',
      target: '#btn-snap-toggle',
      placement: 'bottom',
      title: 'שמירת שבצקים',
      body: 'שמור גרסאות בשם — להשוואה בין שיבוצים, או לשמירת טיוטה לפני ניסיון שינוי. תג "שונה" = השבצ"ק הנוכחי שונה מהגרסה השמורה. לכל גרסה: <strong>טען / עדכן (במקום) / שכפל / שנה שם / מחק</strong>. טעינה ועדכון בלחיצה אחת; מחיקה אינה הפיכה.',
      bodyFallback: 'לאחר יצירת שבצ"ק תוכל לשמור גרסאות בשם דרך כפתור 💾 — לכל גרסה: טען / עדכן / שכפל / שנה שם / מחק.',
      precondition: hasSchedule,
    },
    {
      id: 's-12b',
      target: '#btn-export-day-json, #btn-continuity-import, #continuity-chip',
      placement: 'bottom',
      title: 'יום 0 — שרשור בין שבצקים',
      body: 'הסרגל העליון מאפשר לחבר שבצקים עוקבים: <strong>📋 ייצוא יום</strong> שומר את מצב היום הנוכחי כקובץ הקשר. <strong>🔗 המשך מכאן</strong> מחיל אותו על שבצ"ק חדש. <strong>📋 חיבור לשבצ"ק קודם</strong> טוען קובץ הקשר ידנית. השבצ"ק החדש יציג כרטיסיית <strong>יום 0</strong> לקריאה בלבד — האנקור שמפעיל אילוצי גשר (HC-12, HC-14) בין השבצקים.',
      bodyFallback:
        'לאחר יצירת שבצ"ק יופיעו בסרגל העליון <strong>📋 ייצוא יום</strong> ו<strong>🔗 המשך מכאן</strong> — לחיבור בין שבצקים עוקבים, כך שהשבצ"ק החדש מכיר את היום שלפניו (יום 0) ומכבד אילוצי גשר.',
      precondition: () => !!document.querySelector('#btn-export-day-json, #btn-continuity-import, #continuity-chip'),
    },
    {
      id: 's-13',
      target: '#btn-inject-task',
      placement: 'bottom',
      title: 'משימת חירום',
      body: 'פעיל רק במצב חי. הגדר משימה חד-פעמית שלא תוכננה מראש — שם, יום, שעה, משך, רמות והסמכות נדרשות. המערכת מחפשת את השיבוץ הפחות-משבש ומציגה <strong>תוכניות מדורגות</strong> לבחירה. תיבה אופציונלית "<strong>שמור את המשימה גם במסך המשימות</strong>" משאירה אותה כמשימה חד-פעמית קבועה (תופיע ביצירת השבצ"ק הבא).',
      bodyFallback:
        'במצב חי יופיע כפתור 🚨 להזרקת משימת חירום — להוספת משימה חד-פעמית באמצע השבוע, עם שיבוץ אוטומטי לפי הכי פחות שיבוש.',
      screenshot: { src: './tutorial/inject-task.png', alt: 'חלון הזרקת משימת חירום — טופס פרטי משימה ומשבצות' },
      precondition: (ctx) => hasSchedule(ctx) && isLiveModeOn(ctx),
    },
    {
      id: 's-14',
      target: '.participant-sidebar',
      placement: 'inline-start',
      title: 'אי-זמינות עתידית (Future SOS)',
      body: 'פתח כרטיס משתתף ← <strong>🆘 סמן אי-זמינות</strong> ← בחר חלון יום ושעה. המערכת תאתר את כל השיבוצים שייפגעו ותחשב תוכנית אחת מאוחדת שמחליפה את כולם בבת-אחת — שונה מחילוץ שמטפל במשבצת בודדת.',
      bodyFallback:
        'במצב חי, אם משתתף נעדר לחלון זמן עתידי, ניתן לסמן אי-זמינות מהכרטיס שלו. המערכת תחליף את כל השיבוצים שייפגעו בתוכנית אחת מאוחדת.',
      precondition: hasSchedule,
      mobileOverride: {
        target: '.sidebar-fab',
        body: 'במובייל פתח את הסרגל הצף ← בחר משתתף ← <strong>🆘 סמן אי-זמינות</strong>. המערכת תחליף את כל השיבוצים שייפגעו בתוכנית אחת מאוחדת.',
      },
    },
    {
      id: 's-15',
      target: '#btn-export-pdf',
      placement: 'bottom',
      title: 'ייצוא',
      body: 'לחץ לפתיחת חלון הייצוא. <strong>PDF</strong> — תצוגה מודפסת (יומית מפורטת + סיכום שבועי). <strong>Excel</strong> — גיליון נתונים עם עמודות זמן, משימה ומשתתף. הייצוא זמין לכל שבצ"ק שנוצר, גם ללא מצב חי.',
      bodyFallback: 'לאחר יצירת שבצ"ק יופיע כאן כפתור 📤 לייצוא ל-PDF (תצוגה מודפסת) או Excel (גיליון נתונים).',
      precondition: hasSchedule,
    },
  ],
};

// ─── Track: algorithm (settings tab — 8 steps) ───────────────────────────────

const ALGORITHM_TRACK: TutorialTrack = {
  id: 'algorithm',
  label: 'הגדרות אלגוריתם',
  icon: '⚙',
  description: 'הגדרות · ערכות · אילוצים',
  switchToTab: 'algorithm',
  steps: [
    {
      id: 'a-1',
      target: 'button.tab-btn[data-tab="algorithm"]',
      placement: 'bottom',
      title: 'לשונית הגדרות',
      body: 'כאן מרוכזות כל הגדרות המערכת — אלגוריתם, הסמכות, מראה, ייבוא/ייצוא. כל סעיף הוא אקורדיון; השינויים נשמרים מיידית.',
    },
    {
      id: 'a-2',
      target: '#acc-tutorial',
      placement: 'bottom',
      title: 'מרכז המדריכים',
      body: 'האקורדיון הראשון הוא ספריית המדריכים. מכאן אפשר להפעיל את הסיור הכללי או מדריכים ממוקדים — חזור לכאן בכל עת.',
      openAccordion: 'acc-tutorial',
    },
    {
      id: 'a-3',
      target: '#gm-preset-select',
      placement: 'bottom',
      title: 'ערכות הגדרות שמורות',
      body: 'הרשימה מציגה ערכות הגדרות — מובנות ושמורות. בחירת ערכה טוענת אותה מיידית. <strong>💾</strong> לצד הרשימה שומר ערכה חדשה. תג "שונה" = שינית מאז הטעינה האחרונה ולא שמרת. כפתור פתיחת הפאנל המלא חושף לכל ערכה: <strong>טען / עדכן (במקום) / שכפל / שנה שם / מחק</strong>. ערכות מובנות מסומנות "מובנה" ולא ניתן למחוק או לשנות שם להן.',
      openAccordion: 'acc-algorithm',
    },
    {
      id: 'a-3b',
      target: '[data-action="algo-auto-tune"], #gm-day-start-hour',
      placement: 'inline-start',
      title: 'הגדרות כלליות — שעת תחילת יום וכיול אוטומטי',
      body: '<strong>שעת תחילת יום תפעולי</strong> (ברירת מחדל 05:00) — קובעת את גבולות "יום 1..7" בכל המערכת: תצוגה, הקפאה במצב חי, חלוקת עומס, אי-זמינות, ייצוא. שינוי בעל השפעה רחבה. <strong>🎯 כיול אוטומטי</strong> — מריץ ניסיונות מרובים שמכוונים את כל המשקלות לפי הנתונים הנוכחיים שלך (משתתפים + תבניות + הסמכות). תהליך ארוך (דקות), אך חוסך טיון ידני.',
      bodyFallback:
        'באקורדיון "הגדרות כלליות" יש <strong>שעת תחילת יום תפעולי</strong> (משפיעה על כל הגבולות ביום במערכת) וכפתור <strong>🎯 כיול אוטומטי</strong> שמכוון את כל המשקלות לפי הנתונים שלך.',
      openAccordion: ['acc-algorithm', 'acc-general'],
      precondition: () => !!document.querySelector('[data-action="algo-auto-tune"], #gm-day-start-hour'),
    },
    {
      id: 'a-4',
      target: '.algo-slider[data-action="algo-weight-slider"]',
      placement: 'inline-start',
      title: 'משקלות האלגוריתם',
      body: 'כל סליידר שואל "עד כמה חשוב" גורם מסוים — איזון עומס, איזון יומי, מנוחה. שנה בהדרגה; <strong>⟳</strong> מחזיר לברירת מחדל.',
      openAccordion: ['acc-algorithm', 'acc-weights'],
    },
    {
      id: 'a-5',
      target: 'input[data-code="HC-3"]',
      placement: 'inline-end',
      title: 'תנאים מחייבים — קו אדום',
      body: 'תנאים קשים — אם מופרים, השבצ"ק פסול. בדרך-כלל אין לנטרל אותם. ⚠ "מושבת" = המערכת תדלג על הבדיקה — נטרל רק אם אתה יודע בדיוק מה אתה עושה.',
      bodyFallback:
        'באקורדיון "תנאים מחייבים" תוכל לנטרל בדיקות HC ספציפיות. בדרך-כלל אין לעשות זאת — תנאים מחייבים הם הקו האדום של השבצ"ק.',
      openAccordion: ['acc-algorithm', 'acc-constraints'],
      precondition: () => !!document.querySelector('input[data-code="HC-3"]'),
    },
    {
      id: 'a-6',
      target: '#acc-entities',
      placement: 'bottom',
      title: 'הסמכות ופק"לים',
      body: 'הגדר אילו הסמכות קיימות (חממה, חורש, ניצן…). לכל הסמכה ניתן לבחור <strong>צבע</strong> (פלטה מובנית או הקסה אישית 🎨); ניגודיות נמוכה תידחה. <strong>פק"לים</strong> = פקלים תפעוליים — אחריות תוספתית שצמודה לאדם (למשל "מנהל קווי", "אחראי כלים"). שינויים מופיעים מיידית בלשוניות משתתפים ומשימות.',
      openAccordion: 'acc-entities',
    },
    {
      id: 'a-7',
      target: '#acc-additional',
      placement: 'top',
      title: 'מראה · אחסון · אזור סכנה',
      body: 'מתג <strong>בהיר/כהה</strong> — המדריך הנוכחי גם הוא מתאים את עצמו. <strong>ייצור שבצ"ק</strong> — קביעת מספר ניסיונות ברירת-מחדל. <strong>שימוש באחסון</strong> — דשבורד שמראה מה תופס מקום ב-localStorage (גרסאות שמורות, מערכים, סטים, ערכות), עם התראה כשהאחסון מלא. <strong>⚠ איפוס מערכת</strong> — מוחק את כל הנתונים; אל תלחץ בטעות.',
      openAccordion: 'acc-additional',
    },
    {
      id: 'a-8',
      target: '#acc-transfer',
      placement: 'top',
      title: 'ייבוא / ייצוא נתונים',
      body: 'ייצוא לקובץ JSON — לגיבוי או למחשב אחר. ייבוא = החלפה מלאה. ייצוא Excel/PDF זמינים גם מלשונית השבצ"ק.',
      openAccordion: 'acc-transfer',
    },
  ],
};

// ─── Track: profile (5 steps + guard) ────────────────────────────────────────

const PROFILE_TRACK: TutorialTrack = {
  id: 'profile',
  label: 'כרטיס משתתף',
  icon: '🪪',
  description: 'דורש שבצ"ק קיים',
  requiresSchedule: true,
  guardMessage: 'כרטיס משתתף זמין רק לאחר יצירת שבצ"ק. צור שבצ"ק תחילה, ואז חזור למדריך זה.',
  enterView: 'profile',
  steps: [
    {
      id: 'pr-1',
      target: '[data-action="back-to-schedule"]',
      placement: 'inline-end',
      title: 'כרטיס משתתף — ניווט',
      body: 'הגעת לכאן בלחיצה על שם משתתף בגריד או בסרגל הצד. כפתור <strong>↩ חזרה</strong> מחזיר ללשונית השבצ"ק בכל עת. המידע נקרא מהשבצ"ק הקפוא — תואם בדיוק למה שמוצג בלשונית הראשית.',
    },
    {
      id: 'pr-2',
      target: '.profile-kpi-hero',
      placement: 'bottom',
      title: 'עומס אפקטיבי',
      body: 'המספר הגדול הוא סך שעות העומס <strong>המשוקלל</strong> — לא שעות גולמיות (חלונות עומס משפיעים על המשקל; משימות בלי עומס לא נספרות כלל). זה המספר שהאלגוריתם מנסה לאזן בין המשתתפים. בכותרת מעליה — תגי <strong>הסמכות</strong>, <strong>פק"לים</strong>, ו-❤/🚫 ל<strong>העדפות משימה</strong> (אם הוגדרו).',
    },
    {
      id: 'pr-3',
      target: '.profile-left',
      placement: 'inline-end',
      title: 'לו"ז אישי',
      body: 'כל שיבוצי המשתתף, ממוינים לפי יום. יום 0 (אם קיים) מציג שיבוצים מלפני תחילת השבצ"ק — לקריאה בלבד, לצורך הקשר. תווית <strong>← יום N</strong> = משמרת חוצת ימים. במצב חי, לכל שיבוץ עתידי כפתור <strong>⛑</strong> (חילוץ של אותה משבצת) ולכל שיבוץ עבר אייקון <strong>🧊</strong> (קפוא). לחיצה על שם משימה פותחת את לוח המשימה.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'pr-4',
      target: '.profile-right',
      placement: 'inline-start',
      title: 'מדדים ואי-זמינות',
      body: 'כרטיס המדדים: <strong>אחוז ניצול</strong> כללי לכל התקופה (יחסית לשעות הזמינות של המשתתף — צבוע ירוק/כתום/אדום לפי סף), ופירוט שעות לכל סוג משימה. כרטיס אי-הזמינות מאחד שלוש רמות: כללים קבועים, אי-זמינות עתידית (סקופ-שבצ"ק), ושינויי הסמכה. <strong>🆘 סמן אי-זמינות</strong> ו-<strong>📜 שינוי הסמכה</strong> מציגים אנקור למצב חי אוטומטית אם הוא כבוי, ומחשבים תוכנית מאוחדת שמחליפה את כל השיבוצים שייפגעו. <strong>הסר</strong> ליד כל רשומה מבטל אותה.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'pr-5',
      target: null,
      placement: 'center',
      title: 'סיום',
      body: 'כעת אתה יודע לקרוא את הכרטיס האישי. כדי לראות מבט-על על משימה ספציפית, לחץ על תג משימה בגריד השבצ"ק. <strong>↩ חזרה</strong> מחזיר למסך הראשי.',
    },
  ],
};

// ─── Track: task-panel (5 steps + guard) ─────────────────────────────────────

const TASK_PANEL_TRACK: TutorialTrack = {
  id: 'task-panel',
  label: 'לוח משימה',
  icon: '🗂',
  description: 'דורש שבצ"ק קיים',
  requiresSchedule: true,
  guardMessage: 'לוח משימה זמין רק לאחר יצירת שבצ"ק. צור שבצ"ק תחילה, ואז חזור למדריך זה.',
  enterView: 'task-panel',
  steps: [
    {
      id: 'tp-1',
      target: '.task-panel-topbar',
      placement: 'bottom',
      title: 'לוח משימה — מבט-על',
      body: 'הכותרת מציגה את שם המשימה, תגי תכונות (קבוצה אחידה, חוסמת רצף), וחלונות עומס מוגבר. לצידה: מדדי מפתח — מספר המשמרות ומצב המילוי.',
    },
    {
      id: 'tp-2',
      target: '.tp-needs-attention',
      placement: 'bottom',
      title: 'משבצות לא מאוישות',
      body: 'כרטיס זה מופיע רק כשיש משבצות לא מאוישות. כל שורה מציגה: יום, שעה, ותת-צוות — מיפוי מהיר של מה שחסר. למילוי: עבור לציר הזמן למטה ולחץ על המשבצת הריקה.',
      bodyFallback: 'אם למשימה יש משבצות לא מאוישות, יופיע כאן כרטיס "🚨 דרוש שיבוץ" עם פירוט המשבצות החסרות.',
      precondition: () => !!document.querySelector('.tp-needs-attention'),
    },
    {
      id: 'tp-3',
      target: '.task-panel-timeline-card',
      placement: 'inline-start',
      title: 'ציר זמן שבועי',
      body: 'כל שורה = יום, עמודות = שעות. פסים כתומים = חלונות עומס מוגבר. ריחוף מעל משמרת מציג את פרטיה. משמרות שחוצות חצות מופיעות ביום הבא עם תווית <strong>↩ המשך</strong>. בכל תא משובץ: <strong>🆘 חילוץ</strong> ו-<strong>⇄ החלפה</strong> זמינים ישירות מכאן (במצב חי, שיבוצי עבר מוצגים עם 🧊 במקום).',
      mobileOverride: {
        target: '.tp-day-stack',
        placement: 'top',
        body: 'במובייל ציר הזמן מוצג כערימת ימים — היום הראשון וכל יום עם משבצות ריקות נפתחים אוטומטית. תג <strong>🔥</strong> ליד שעות המשמרת = חלון עומס מוגבר. לחץ על תא משובץ ל-🆘 חילוץ או ⇄ החלפה.',
      },
    },
    {
      id: 'tp-4',
      target: '.tp-req-list',
      placement: 'inline-start',
      title: 'דרישות משבצת',
      body: 'מרכז את הדרישות לכל משבצת — מספר ממלאים, רמות מותרות (תג ~ = עדיפות נמוכה), הסמכות נדרשות, ותת-צוות. כאן רואים בדיוק מי כשיר לכל תפקיד.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'tp-5',
      target: '.metrics-breakdown',
      placement: 'inline-start',
      title: 'מי עובד הכי הרבה?',
      body: 'גרף עמודות מציג שעות ומספר משמרות לכל משתתף שעבד במשימה זו. לחיצה על שם פותחת את הכרטיס האישי שלו. מתחת: תכונות המשימה — משקל עומס, חלונות מוגברים, ופרק מנוחה.',
      mobileOverride: { placement: 'top' },
    },
  ],
};

// ─── Track: full-tour (curated subset across tabs) ───────────────────────────

const FULL_TOUR_TRACK: TutorialTrack = {
  id: 'full-tour',
  label: 'סיור כללי',
  icon: '📖',
  description: 'כל הלשוניות · ~36 שלבים',
  steps: [
    // Welcome
    {
      id: 'ft-welcome',
      target: null,
      placement: 'center',
      title: 'ברוך הבא ל-Garden Manager',
      body: 'סיור קצר (~6 דק׳) על חלקי המערכת — איך מגדירים משתתפים, איך נוצר השבצ"ק, ואיפה ההגדרות. ניתן לצאת בכל שלב, ולחזור מאוחר יותר מלשונית <strong>הגדרות</strong>. הסיור לא חוסם את הממשק — תוכל ללחוץ על כל כפתור שאני מציין.',
    },
    // Participants subset
    { ...stepById(PARTICIPANTS_TRACK, 'p-1'), id: 'ft-p-1', switchToTab: 'participants' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-2'), id: 'ft-p-2' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-4'), id: 'ft-p-4' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-5'), id: 'ft-p-5' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-8'), id: 'ft-p-8' },
    // Task-rules subset (now includes t-7b — Sleep & Recovery is HC-15, must be in tour)
    { ...stepById(TASK_RULES_TRACK, 't-1'), id: 'ft-t-1', switchToTab: 'task-rules' },
    { ...stepById(TASK_RULES_TRACK, 't-2'), id: 'ft-t-2' },
    { ...stepById(TASK_RULES_TRACK, 't-3'), id: 'ft-t-3' },
    { ...stepById(TASK_RULES_TRACK, 't-5'), id: 'ft-t-5' },
    { ...stepById(TASK_RULES_TRACK, 't-7b'), id: 'ft-t-7b' },
    { ...stepById(TASK_RULES_TRACK, 't-9'), id: 'ft-t-9' },
    {
      id: 'ft-one-time',
      target: '[data-action="toggle-add-onetime"]',
      placement: 'bottom',
      title: 'משימות חד-פעמיות',
      body: 'בנוסף לתבניות הקבועות, ניתן להוסיף משימות חד-פעמיות — אירועים חריגים ביום ושעה ספציפיים, שאינם חוזרים. למשל: סיור קבוצתי, אירוח, או משמרת מילואים. יופיעו בשבצ"ק הבא שייווצר.',
      bodyFallback:
        'בתחתית לשונית "כללי משימות" יש סעיף <strong>משימות חד-פעמיות</strong> — אירועים חריגים ביום ושעה ספציפיים, שאינם חוזרים. נכנסים לשבצ"ק הבא שייווצר.',
      precondition: () => !!document.querySelector('[data-action="toggle-add-onetime"]'),
    },
    // Bridge step before the schedule block
    {
      id: 'ft-schedule-intro',
      target: null,
      placement: 'center',
      title: 'הצעדים הבאים: לשונית השבצ"ק',
      body: 'אם אין לך עדיין שבצ"ק, ניתן ללחוץ <strong>⚡ צור שבצ"ק</strong> בלשונית הבאה לפני שתמשיך — תראה את כל הלוחות שאני מתאר בפעולה. אפשר גם להמשיך עכשיו ולחזור מאוחר יותר.',
      switchToTab: 'schedule',
    },
    // Schedule subset (now includes s-12b — Day 0 / continuity is a header feature)
    { ...stepById(SCHEDULE_TRACK, 's-1'), id: 'ft-s-1' },
    { ...stepById(SCHEDULE_TRACK, 's-3'), id: 'ft-s-3' },
    { ...stepById(SCHEDULE_TRACK, 's-4'), id: 'ft-s-4' },
    { ...stepById(SCHEDULE_TRACK, 's-5'), id: 'ft-s-5' },
    { ...stepById(SCHEDULE_TRACK, 's-6'), id: 'ft-s-6' },
    { ...stepById(SCHEDULE_TRACK, 's-7'), id: 'ft-s-7' },
    { ...stepById(SCHEDULE_TRACK, 's-8'), id: 'ft-s-8' },
    { ...stepById(SCHEDULE_TRACK, 's-9'), id: 'ft-s-9' },
    { ...stepById(SCHEDULE_TRACK, 's-11'), id: 'ft-s-11' },
    { ...stepById(SCHEDULE_TRACK, 's-12'), id: 'ft-s-12' },
    { ...stepById(SCHEDULE_TRACK, 's-12b'), id: 'ft-s-12b' },
    { ...stepById(SCHEDULE_TRACK, 's-13'), id: 'ft-s-13' },
    { ...stepById(SCHEDULE_TRACK, 's-15'), id: 'ft-s-15' },
    // Pointer steps for overlays (do NOT detour)
    {
      id: 'ft-profile-pointer',
      target: '.participant-sidebar [data-pid], .schedule-grid-container [data-pid]',
      placement: 'inline-start',
      title: 'כרטיס משתתף',
      body: 'לחץ על כל שם משתתף לפתיחת הכרטיס האישי — לו"ז, עומס, ואי-זמינות. למדריך מפורט: <strong>הגדרות ← 📖 מדריכים ← כרטיס משתתף</strong>.',
      bodyFallback: 'לחיצה על שם משתתף בגריד או בסרגל הצד פותחת את הכרטיס האישי שלו — לו"ז, עומס, ואי-זמינות.',
      precondition: () =>
        !!document.querySelector('.participant-sidebar [data-pid], .schedule-grid-container [data-pid]'),
    },
    {
      id: 'ft-task-panel-pointer',
      target: '.task-panel-hover[data-source-name]',
      placement: 'top',
      title: 'לוח משימה',
      body: 'לחץ על תג משימה בגריד לפתיחת לוח מפורט — ציר זמן שבועי, דרישות, פילוח עומס. למדריך מפורט: <strong>הגדרות ← 📖 מדריכים ← לוח משימה</strong>.',
      bodyFallback: 'לחיצה על תג משימה בגריד פותחת לוח מפורט — ציר זמן, דרישות משבצת, ופילוח עומס המשתתפים.',
      precondition: () => !!document.querySelector('.task-panel-hover[data-source-name]'),
    },
    // Algorithm subset (now includes a-3b — day-start-hour is the largest behavioral switch)
    { ...stepById(ALGORITHM_TRACK, 'a-3'), id: 'ft-a-3', switchToTab: 'algorithm' },
    { ...stepById(ALGORITHM_TRACK, 'a-3b'), id: 'ft-a-3b' },
    { ...stepById(ALGORITHM_TRACK, 'a-4'), id: 'ft-a-4' },
    { ...stepById(ALGORITHM_TRACK, 'a-5'), id: 'ft-a-5' },
    { ...stepById(ALGORITHM_TRACK, 'a-6'), id: 'ft-a-6' },
    { ...stepById(ALGORITHM_TRACK, 'a-8'), id: 'ft-a-8' },
    // Closing
    {
      id: 'ft-closing',
      target: null,
      placement: 'center',
      title: 'סיימת את הסיור הכללי',
      body: 'להתחלה מהירה: ודא שיש מספיק משתתפים לכל קבוצה ← לחץ <strong>⚡ צור שבצ"ק</strong> ← בדוק את הציון בלוח המדדים. לפירוט נוסף על מסך מסוים, חזור ל<strong>הגדרות ← 📖 מדריכים</strong>.',
    },
  ],
};

// ─── Exported track registry ─────────────────────────────────────────────────

export const TRACKS: TutorialTrack[] = [
  FULL_TOUR_TRACK,
  PARTICIPANTS_TRACK,
  TASK_RULES_TRACK,
  SCHEDULE_TRACK,
  ALGORITHM_TRACK,
  PROFILE_TRACK,
  TASK_PANEL_TRACK,
];

export function getTrackById(id: string): TutorialTrack | undefined {
  return TRACKS.find((t) => t.id === id);
}
