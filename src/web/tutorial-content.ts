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
      id: 'p-6',
      target: '[data-action="enter-table-edit"]',
      placement: 'bottom',
      title: 'עריכת טבלה מהירה',
      body: 'מצב עריכת טבלה מאפשר לשנות שדות של כמה משתתפים בו-זמנית — יעיל לעדכון קבוצות או רמות בצובר. <strong>✓ אשר</strong> שומר את כל השינויים יחד.',
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
      body: 'מערך הוא תמונת מצב של הצוות — שמות, רמות, הסמכות. ניתן לשמור מספר מערכים (למשל "ימי חול" / "שבת") ולעבור ביניהם. החלפת מערך אינה מוחקת שבצ"ק קיים.',
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
      body: 'כל תבנית מורכבת ממשבצות — כל משבצת מייצגת תפקיד אחד שיש לאייש. לכל משבצת מגדירים <strong>רמה מינימלית</strong> ו<strong>הסמכות נדרשות</strong>. <em>(לחץ "+ משבצת" בתוך כרטיסיית תבנית כדי להוסיף.)</em>',
      bodyFallback:
        'בכל תבנית תוכל להוסיף משבצות — כל משבצת היא תפקיד אחד שיש לאייש, עם <strong>רמה מינימלית</strong> ו<strong>הסמכות נדרשות</strong>.',
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
      id: 't-8',
      target: '.template-card [data-action="open-load-formula"]',
      placement: 'inline-start',
      title: 'נוסחת עומס',
      body: 'קובעת כמה "כבד" נחשב כל שעה של המשמרת לחישוב חלוקת עומס בין המשתתפים. בדרך-כלל אין צורך לשנות את ברירת המחדל.',
      bodyFallback: 'בכל תבנית יש כפתור 🧮 לפתיחת נוסחת העומס — מגדיר כמה "כבד" נחשב כל שעה לעניין חלוקה הוגנת.',
      screenshot: { src: './tutorial/load-formula.png', alt: 'חלון נוסחת עומס — השוואה בין משימות' },
      expandFirstTemplate: true,
      precondition: () => !!document.querySelector('.template-card [data-action="open-load-formula"]'),
    },
    {
      id: 't-9',
      target: '.score-card.inline-badge',
      placement: 'bottom',
      title: 'מוכנות לשיבוץ',
      body: 'תג זה מסכם את הבדיקה המקדימה — <strong>קריטי</strong> אדום / <strong>אזהרה</strong> כתום / <strong>בסדר</strong> ירוק. ממצא קריטי ימנע יצירת שבצ"ק; לחץ על התג לפירוט.',
      bodyFallback: 'בראש הלשונית יופיע תג מוכנות — אדום / כתום / ירוק — שמסכם את הבדיקה המקדימה לפני יצירת שבצ"ק.',
      precondition: () => !!document.querySelector('.score-card.inline-badge'),
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
      body: 'כל ניסיון מפעיל מחזור שלם של בנייה ושיפור. ברירת המחדל (60 ניסיונות) מתאימה לצוות גדול; לצוות עד 20 משתתפים, 10–20 ניסיונות מספיקים ומסיימים תוך שניות.',
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
      body: 'כל כרטיסייה = יום תפעולי (יום 1 עד יום 7). נקודה אדומה = יש הפרות ביום. אייקון ❄ = היום קפוא (לפני עוגן מצב חי) ואינו ניתן לעריכה.',
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
      body: 'מציג שעות אפקטיביות לכל משתתף — צעירים (L0) ובכירים (L4) מוצגים בנפרד. הפס הכהה = העומס שנצבר עד היום הנוכחי. לחץ על שם לפתיחת הכרטיס האישי המלא.',
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
      body: 'לחיצה על ⇄ בכל תא פותחת את בורר ההחלפות. מצב <strong>חופשי</strong> — בחר ממלא חדש למשבצת. מצב <strong>החלפה</strong> — עסקה הדדית בין שני משתתפים. תצוגה מקדימה מציגה את השפעת השינוי לפני האישור.',
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
      body: 'במצב חי, משבצת פנויה בעתיד מציגה כפתור ⛑. האופטימייזר מחפש שרשרת החלפות (עומק 1 עד 3) שמשאירה את השבצ"ק תקף והוגן. עומק 4 מוצג רק כמוצא אחרון, עם אזהרה.',
      bodyFallback:
        'הפעל מצב חי וקבע עוגן — ואז על כל משבצת פנויה בעתיד יופיע כפתור ⛑ <strong>חילוץ</strong>. האופטימייזר מציע שרשרת החלפות שממלאת את המשבצת במינימום שיבוש.',
      precondition: (ctx) => hasSchedule(ctx) && isLiveModeOn(ctx),
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
      body: 'שמור גרסאות בשם — להשוואה בין שיבוצים, או לשמירת טיוטה לפני ניסיון שינוי. תג "שונה" = השבצ"ק הנוכחי שונה מהגרסה השמורה. טעינה בלחיצה אחת; מחיקה אינה הפיכה.',
      bodyFallback: 'לאחר יצירת שבצ"ק תוכל לשמור גרסאות בשם דרך כפתור 💾 — להשוואה או לטיוטה לפני שינוי.',
      precondition: hasSchedule,
    },
    {
      id: 's-13',
      target: '#btn-inject-task',
      placement: 'bottom',
      title: 'משימת חירום',
      body: 'פעיל רק במצב חי. הגדר משימה חד-פעמית שלא תוכננה מראש — שם, יום, שעה, משך, רמות והסמכות נדרשות. המערכת מחפשת את השיבוץ הפחות-משבש ומציגה תוכניות מדורגות לבחירה.',
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
      body: 'הרשימה מציגה ערכות הגדרות — מובנות ושמורות. בחירת ערכה טוענת אותה מיידית. <strong>💾</strong> לצד הרשימה שומר ערכה חדשה. תג "שונה" = שינית מאז הטעינה האחרונה ולא שמרת.',
      openAccordion: 'acc-algorithm',
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
      body: 'הגדר אילו הסמכות קיימות (חממה, חורש, ניצן…). <strong>פק"לים</strong> = פקלים תפעוליים, כלומר אחריות תוספתית שצמודה לאדם (למשל "מנהל קווי", "אחראי כלים"). שינויים מופיעים מיידית בלשוניות משתתפים ומשימות.',
      openAccordion: 'acc-entities',
    },
    {
      id: 'a-7',
      target: '#acc-additional',
      placement: 'top',
      title: 'מראה · אזור סכנה',
      body: 'מתג <strong>בהיר/כהה</strong> — המדריך הנוכחי גם הוא מתאים את עצמו לבחירה. <strong>⚠ איפוס מערכת</strong> — מוחק את כל הנתונים ומחזיר למצב התחלתי; אל תלחץ בטעות.',
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
      body: 'המספר הגדול הוא סך שעות העומס המשוקלל — לא שעות גולמיות. משימה עם חלון עומס ×2 נספרת כפול. זה המספר שהאלגוריתם מנסה לאזן בין המשתתפים.',
    },
    {
      id: 'pr-3',
      target: '.profile-left',
      placement: 'inline-end',
      title: 'לו"ז אישי',
      body: 'כרטיס לו"ז אישי מציג את כל שיבוצי המשתתף, ממוינים לפי יום. יום 0 (אם קיים) מציג שיבוצים מלפני תחילת השבצ"ק — לצורך הקשר. לחיצה על שם משימה פותחת את לוח המשימה.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'pr-4',
      target: '.profile-right',
      placement: 'inline-start',
      title: 'מדדים ואי-זמינות',
      body: 'כרטיס המדדים: אחוז ניצול לפי סוג משימה, וכללי אי-זמינות (קבועים + עתידיים, שנקבעו במהלך הפעלה במצב חי). <strong>🆘 סמן אי-זמינות</strong> במצב חי מפעיל תכנון מאוחד שמחליף את כל השיבוצים שייפגעו.',
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
      body: 'כרטיס זה מופיע רק כשיש משבצות לא מאוישות. כל שורה מציגה: יום, שעה, ותת-צוות. במצב חי — כפתורי 🆘 והחלפה זמינים מכאן ישירות, בלי לחזור לגריד.',
      bodyFallback: 'אם למשימה יש משבצות לא מאוישות, יופיע כאן כרטיס "🚨 דרוש שיבוץ" עם פירוט המשבצות החסרות.',
      precondition: () => !!document.querySelector('.tp-needs-attention'),
    },
    {
      id: 'tp-3',
      target: '.task-panel-timeline-card',
      placement: 'inline-start',
      title: 'ציר זמן שבועי',
      body: 'כל שורה = יום, עמודות = שעות. פסים כתומים = חלונות עומס מוגבר. לחיצה על תא חושפת את המשתתפים המשובצים בו.',
      mobileOverride: {
        target: '.tp-day-stack',
        placement: 'top',
        body: 'במובייל ציר הזמן מוצג כערימת ימים. כל יום ניתן לפתיחה לפירוט המשמרות והמשובצים.',
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
  description: 'כל הלשוניות · ~33 שלבים',
  steps: [
    // Welcome
    {
      id: 'ft-welcome',
      target: null,
      placement: 'center',
      title: 'ברוך הבא ל-Garden Manager',
      body: 'סיור קצר (~5 דק׳) על חלקי המערכת — איך מגדירים משתתפים, איך נוצר השבצ"ק, ואיפה ההגדרות. ניתן לצאת בכל שלב, ולחזור מאוחר יותר מלשונית <strong>הגדרות</strong>. הסיור לא חוסם את הממשק — תוכל ללחוץ על כל כפתור שאני מציין.',
    },
    // Participants subset (1 → 2 → 4 → 5 → 8)
    { ...PARTICIPANTS_TRACK.steps[0], id: 'ft-p-1', switchToTab: 'participants' },
    { ...PARTICIPANTS_TRACK.steps[1], id: 'ft-p-2' },
    { ...PARTICIPANTS_TRACK.steps[3], id: 'ft-p-4' },
    { ...PARTICIPANTS_TRACK.steps[4], id: 'ft-p-5' },
    { ...PARTICIPANTS_TRACK.steps[7], id: 'ft-p-8' },
    // Task-rules subset (1 → 2 → 3 → 5 → 9 → one-time)
    { ...TASK_RULES_TRACK.steps[0], id: 'ft-t-1', switchToTab: 'task-rules' },
    { ...TASK_RULES_TRACK.steps[1], id: 'ft-t-2' },
    { ...TASK_RULES_TRACK.steps[2], id: 'ft-t-3' },
    { ...TASK_RULES_TRACK.steps[4], id: 'ft-t-5' },
    { ...TASK_RULES_TRACK.steps[8], id: 'ft-t-9' },
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
    // Bridge step before the schedule block — most users on the full tour have
    // no schedule yet, so the next 8 steps would be fallback messages without
    // this nudge to generate one.
    {
      id: 'ft-schedule-intro',
      target: null,
      placement: 'center',
      title: 'הצעדים הבאים: לשונית השבצ"ק',
      body: 'אם אין לך עדיין שבצ"ק, ניתן ללחוץ <strong>⚡ צור שבצ"ק</strong> בלשונית הבאה לפני שתמשיך — תראה את כל הלוחות שאני מתאר בפעולה. אפשר גם להמשיך עכשיו ולחזור מאוחר יותר.',
      switchToTab: 'schedule',
    },
    // Schedule subset (1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 11 → 12 → 13 → 15)
    { ...SCHEDULE_TRACK.steps[0], id: 'ft-s-1' },
    { ...SCHEDULE_TRACK.steps[2], id: 'ft-s-3' },
    { ...SCHEDULE_TRACK.steps[3], id: 'ft-s-4' },
    { ...SCHEDULE_TRACK.steps[4], id: 'ft-s-5' },
    { ...SCHEDULE_TRACK.steps[5], id: 'ft-s-6' },
    { ...SCHEDULE_TRACK.steps[6], id: 'ft-s-7' },
    { ...SCHEDULE_TRACK.steps[7], id: 'ft-s-8' },
    { ...SCHEDULE_TRACK.steps[8], id: 'ft-s-9' },
    { ...SCHEDULE_TRACK.steps[10], id: 'ft-s-11' },
    { ...SCHEDULE_TRACK.steps[11], id: 'ft-s-12' },
    { ...SCHEDULE_TRACK.steps[12], id: 'ft-s-13' },
    { ...SCHEDULE_TRACK.steps[14], id: 'ft-s-15' },
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
    // Algorithm subset (3 → 4 → 5 → 6 → 8) — note: tutorial-launcher (a-2) is skipped
    { ...ALGORITHM_TRACK.steps[2], id: 'ft-a-3', switchToTab: 'algorithm' },
    { ...ALGORITHM_TRACK.steps[3], id: 'ft-a-4' },
    { ...ALGORITHM_TRACK.steps[4], id: 'ft-a-5' },
    { ...ALGORITHM_TRACK.steps[5], id: 'ft-a-6' },
    { ...ALGORITHM_TRACK.steps[7], id: 'ft-a-8' },
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
