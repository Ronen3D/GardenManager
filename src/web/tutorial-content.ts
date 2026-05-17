/**
 * Tutorial content — pure data. All tracks, steps, and Hebrew copy live here.
 * No DOM, no behaviour, no imports beyond types. Editing a step is a one-line
 * change in this file; the engine in `tutorial.ts` reads the data unchanged.
 *
 * Steps run against curated demo state (see `tutorial-demo-seed.ts`), so they
 * carry no `precondition` / `bodyFallback` / `fallbackAction` machinery — every
 * spotlight target is guaranteed to exist when the step renders.
 */

import type { TutorialTrack } from './tutorial';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Look up a step by id within a track. Throws if missing — used by the
 * full-tour composer so renames in source tracks fail loudly at module load
 * instead of silently picking the wrong step via a stale array index. */
const stepById = (track: TutorialTrack, id: string) => {
  const s = track.steps.find((step) => step.id === id);
  if (!s) throw new Error(`tutorial-content: step "${id}" not found in track "${track.id}"`);
  return s;
};

// ─── Track: participants (12 steps) ──────────────────────────────────────────

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
      body: 'כפתור זה פותח גיליון להוספת משתתף חדש — שם, קבוצה ורמה, ואז <strong>שמירה</strong>. כל שדה משפיע על המשמרות שיוצעו למשתתף. <em>(בשלב הבא אפתח את הגיליון להדגמה.)</em>',
    },
    {
      id: 'p-3',
      target: '.gm-edit-sheet-v2 [data-pe-section="identity"]',
      placement: 'inline-end',
      title: 'שדות מרכזיים',
      body: '<strong>שם</strong> — חופשי. <strong>קבוצה</strong> — קריטית למשימות שדורשות קבוצה אחידה. <strong>דרגה</strong> — L0 (מתחיל) / L2 / L3 / L4 (בכיר); אין L1 במערכת. הדרגה קובעת באילו משבצות המשתתף יוכל להשתבץ. <strong>הסמכות</strong> — פותחות גישה למשבצות מיוחדות.',
      openAddParticipant: true,
      mobileOverride: {
        target: '.gm-edit-sheet-v2 [data-pe-section="identity"]',
        placement: 'top',
        body: 'הגיליון התחתון מציג את שדות הזיהוי: <strong>שם</strong>, <strong>קבוצה</strong>, ו<strong>דרגה</strong> (L0 / L2 / L3 / L4 — אין L1). הדרגה קובעת באילו משבצות המשתתף יוכל להשתבץ. <strong>הסמכות</strong>, <strong>מקדם עומס</strong>, ו<strong>אי-זיווג</strong> מופיעים בקטעים נוספים בהמשך הגיליון.',
      },
    },
    {
      id: 'p-4',
      // Skip the leading "הכל" pill (empty `data-group`) and land on the first
      // real group filter so the spotlight describes the right thing.
      target: '.pill[data-action="filter-group"][data-group]:not([data-group=""])',
      placement: 'bottom',
      title: 'סינון לפי קבוצה',
      body: 'כפתורי הקבוצה מסננים את הטבלה למשתתפי קבוצה אחת בלבד. שימושי לוודא שלכל קבוצה יש מספיק משתתפים ברמות הנדרשות לפני יצירת שבצ"ק.',
    },
    {
      id: 'p-4b',
      target: 'td.col-actions',
      placement: 'inline-start',
      title: 'עריכה והסרה של משתתף',
      body: 'בכל שורה, עמודת <strong>פעולות</strong> מציגה שני כפתורים. <strong>✎ עריכה</strong> פותח את אותו גיליון העריכה לתיקון משתתף קיים — דרגה, קבוצה, הסמכות וכל היתר. <strong>🗑 הסרה</strong> מוחק את המשתתף: תוצג בקשת אישור (<strong>הסר</strong>), ומיד לאחריה הודעה עם קישור <strong>בטל</strong> לשחזור. <strong>שים לב</strong>: הסרת משתתף מוחקת גם את כל שיבוציו וכללי אי-הזמינות שלו.',
      mobileOverride: {
        placement: 'top',
      },
    },
    {
      id: 'p-5',
      target: '[data-pe-unavail-add]',
      placement: 'inline-start',
      title: 'אי-זמינות',
      body: 'בקטע זה מגדירים מתי המשתתף לא זמין — למשל יום 3 אחה"צ. הכפתור <strong>+ הוסף חסימה</strong> פותח בורר טווח ימים ושעות; המערכת תמנע אוטומטית שיבוץ במשמרות חופפות. <em>(פתחתי לך את גיליון העריכה של המשתתף הראשון להדגמה.)</em>',
      expandFirstParticipant: true,
    },
    {
      id: 'p-5b',
      target: '[data-pe-field="workloadMultiplier"]',
      placement: 'inline-start',
      title: 'מקדם עומס ופק"לים',
      body: '<strong>מקדם עומס</strong> — מספר שמשנה את מטרת חלוקת השעות של המשתתף (1.0 = ברירת מחדל; 1.5 = יקבל ~50% יותר; 0.5 = ~50% פחות; טווח 0.3–5.0). תג <strong>×N</strong> בעמודת הרמה מציין שהמקדם שונה מ-1. בקטע <strong>פק"לים</strong> שבגיליון — תיבות סימון להסמכות תפעוליות צמודות לאדם (מוגדרות בהגדרות ← הסמכות ופק"לים). <em>(פתחתי לך את גיליון העריכה להדגמה.)</em>',
      expandFirstParticipant: true,
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
      target: '.table-participants',
      placement: 'top',
      title: 'בחירה מרובה ופעולות בצובר',
      body: 'תיבות הסימון בעמודה הימנית של הטבלה מאפשרות בחירה מרובה. כשנבחר משתתף אחד או יותר תופיע שורת פעולות: <strong>מחק משתתפים</strong> ו<strong>הוסף חוסר זמינות</strong> בצובר. קיצור: לחיצה על תג קבוצה בוחרת את כל חבריה; Shift/Ctrl-click מצרפת בחירות.',
    },
    {
      id: 'p-7',
      target: '.table-participants',
      placement: 'top',
      title: 'העדפות משימה',
      body: 'בגיליון העריכה תוכל להגדיר משימה <strong>מועדפת</strong> ו<strong>פחות-מועדפת</strong>. אלו אילוצים רכים — האופטימייזר יעדיף לכבד אותם, אך אינו מחויב לכך. אם תבחר משימה שהמשתתף לא כשיר אליה (רמה / הסמכה לא מתאימה), תופיע אזהרה מתחת לשדה — ההעדפה תישמר אך לא תשפיע על השיבוץ.',
    },
    {
      id: 'p-7b',
      target: '[data-pe-notwith]',
      placement: 'inline-start',
      title: 'אי-התאמה בין משתתפים',
      body: 'בקטע <strong>אי-זיווג</strong> בגיליון העריכה ניתן לסמן שמות משתתפים שעדיף לא לשבץ יחד עם המשתתף הזה. זהו <strong>אילוץ רך</strong> — האופטימייזר ישתדל להפריד ביניהם, אך עשוי לשבץ יחד אם אין ברירה, וההפרה תופיע כאזהרה בלוח האזהרות. <strong>שים לב</strong>: כדי שהאילוץ יחול על תבנית מסוימת, צריך להפעיל בה את המתג <strong>"אי התאמה"</strong> (ראה לשונית כללי משימות). <em>(פתחתי לך את גיליון העריכה להדגמה.)</em>',
      expandFirstParticipant: true,
    },
    {
      id: 'p-8',
      target: '[data-action="pset-panel-toggle"]',
      placement: 'bottom',
      title: 'מערכי משתתפים',
      body: 'מערך הוא תמונת מצב של הצוות — שמות, רמות, הסמכות. שמור כמה מערכים ועבור ביניהם (החלפה אינה מוחקת שבצ"ק קיים). בלוח עצמו: <strong>📊 ייבוא Excel</strong> לטעינת מערך מגיליון, <strong>עדכן</strong> לשמירת שינויים על מערך פעיל (תג "שונה" מציין שיש שינויים שלא נשמרו), <strong>שכפל / שנה שם / ייצא JSON או Excel</strong> לכל מערך.',
    },
  ],
};

// ─── Track: task-rules (15 steps) ────────────────────────────────────────────

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
      body: 'תבנית היא "מתכון" חוזר — למשל משימה עם 3 משמרות ביום, 8 שעות כל אחת. המערכת תייצר ממנה משמרות אוטומטית לכל ימות השבצ"ק.',
    },
    {
      id: 't-3',
      target: '.template-card[data-template-id]:first-child .template-header',
      placement: 'bottom',
      title: 'כרטיסיות התבניות',
      body: 'כל תבנית מוצגת ככרטיסייה הניתנת להרחבה — שם, מספר משמרות ביום, שעת התחלה ומשך. מתחת לשדות תופיע שורת שבבים שמראה בזמן אמת את <strong>שעות ההתחלה והסיום של כל משמרת</strong> — למשל: <code>1 06:00–14:00 &nbsp; 2 14:00–22:00 &nbsp; 3 22:00–06:00</code>. <strong>כל שינוי שדה נשמר אוטומטית — אין כפתור "שמור"</strong>; נצנוץ קצר בשורה מאשר כל שמירה.',
    },
    {
      id: 't-4',
      target:
        '.template-card[data-template-id]:first-child .slot-list, .template-card[data-template-id]:first-child .template-header',
      placement: 'inline-start',
      title: 'משבצות',
      body: 'כל תבנית מורכבת ממשבצות — כל משבצת מייצגת תפקיד אחד שיש לאייש. לכל משבצת מגדירים: <strong>רמות מותרות</strong> (תגי הרמה ניתנים להחלפה בין רגיל / <strong>~</strong> עדיפות-נמוכה / כבוי), <strong>הסמכות נדרשות</strong>, ו<strong>הסמכות אסורות</strong> (פוסלות מחזיקי הסמכה ספציפית). הוספת משבצת חדשה מתבצעת באמצעות הכפתור <strong>+ משבצת</strong> בתוך כרטיסיית התבנית.',
      expandFirstTemplate: true,
    },
    {
      id: 't-4b',
      target: '.template-card [data-action="add-subteam"]',
      placement: 'inline-start',
      title: 'תת-צוותים',
      body: 'בנוסף למשבצות הראשיות, ניתן לחלק את התבנית ל<strong>תת-צוותים</strong> — קבוצות משבצות עצמאיות שמייצגות תפקידים שונים בתוך אותה משימה. לדוגמה: "ניהול שטח" עם 2 משבצות לצד "תמיכה לוגיסטית" עם 3 משבצות, כאשר לכל תת-צוות הסמכות שונות. הכפתור <strong>+ תת-צוות</strong> מוסיף קבוצה חדשה ומאפשר לתת לה שם ולהוסיף לה משבצות. משבצות בתת-צוות ומשבצות "ראשיות" יכולות לדור בכפיפה אחת — ניתן לשלב לפי הצורך. הסרת תת-צוות מתבצעת באמצעות <strong>✕</strong> בכותרתו.',
      expandFirstTemplate: true,
    },
    {
      id: 't-5',
      // Target the whole label row, not just the 13px input — otherwise the
      // halo is a tiny square pinned to the LTR-left side of the row where the
      // checkbox sits, and the Hebrew label text "נדרשת אותה קבוצה" lands
      // outside the cutout, reading as a misaligned spotlight.
      target: '.template-card .checkbox-label:has([data-tpl-field="sameGroupRequired"])',
      placement: 'inline-start',
      title: 'קבוצה אחידה',
      body: 'כשמסומן — כל המשובצים במשמרת חייבים להיות מאותה קבוצה. מתאים למשימות שדורשות צוות מגובש.',
      expandFirstTemplate: true,
    },
    {
      id: 't-6',
      target: '.template-card .checkbox-label:has([data-tpl-field="blocksConsecutive"])',
      placement: 'inline-start',
      title: 'חסימת רצף',
      body: 'כשמופעל — האופטימייזר ימנע משמרות "כבדות" רצופות לאותו אדם. חיוני למשימות ארוכות; השאר כבוי למשימות קצרות.',
      expandFirstTemplate: true,
    },
    {
      id: 't-6b',
      target: '.template-card .checkbox-label:has([data-tpl-field="togethernessRelevant"])',
      placement: 'inline-start',
      title: 'אי התאמה',
      body: 'כשמסומן — העדפות <strong>אי-זיווג</strong> שהוגדרו בכרטיסי המשתתפים יחולו על משמרות התבנית הזו, והאופטימייזר ישתדל לא לשבץ יחד אנשים שסומנו זה מול זה. זהו <strong>אילוץ רך</strong>: כשאין ברירה הם עשויים להשתבץ יחד, וההפרה תופיע כאזהרה. ללא הפעלת המתג כאן, הגדרות אי-הזיווג אינן משפיעות על התבנית.',
      expandFirstTemplate: true,
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
      body: 'מנגנון נפרד מכללי מרווח: בוחרים אילו <strong>משמרות-טריגר</strong> בתבנית מפעילות חלון התאוששות (לפי מספר המשמרת: 1, 2, 3...), ואז <strong>שעות התאוששות</strong> שבהן לא תשובץ שום משימה אחרת בעלת עומס. לדוגמה: סיום משמרת לילה (משמרת 3) → 12 שעות בלי שיבוץ נוסף. אילוץ <strong>קשה</strong> — אם מופר, השבצ"ק פסול.',
      expandFirstTemplate: true,
    },
    {
      id: 't-8',
      target: '.template-card [data-action="open-load-formula"]',
      placement: 'inline-start',
      title: 'נוסחת עומס',
      body: 'קובעת כמה "כבד" נחשב כל שעה של המשמרת לחישוב חלוקת עומס בין המשתתפים. בדרך-כלל אין צורך לשנות את ברירת המחדל. כפתור <strong>🧮</strong> ליד שדה הערך פותח חלון להגדרת הנוסחה לפי השוואה למשימות אחרות. לאחר שמירת נוסחה, יופיע כפתור <strong>ℹ️</strong> נוסף המציג את הפירוט ואזהרות אם הנוסחה התיישנה.',
      screenshot: { src: './tutorial/load-formula.png', alt: 'חלון נוסחת עומס — השוואה בין משימות' },
      expandFirstTemplate: true,
    },
    {
      id: 't-8b',
      target:
        '.template-card [data-action="add-load-window"], .template-card [data-action="add-load-window-and-compute"]',
      placement: 'inline-start',
      title: 'חלונות עומס מוגבר',
      body: 'מאפשרים להגדיר ש<em>חלק מהמשמרת</em> נחשב יותר עומס — למשל החלק 06:00–08:00 שוקל ×0.8, או החצי הראשון של משמרת לילה. בכל חלון: טווח שעות, משקל (0–1), ו<strong>חוסם בקצה</strong> — אם מסומן, חלון שנוגע בקצה המשמרת חוסם רצף עם משמרת סמוכה (אילוץ ברמת חלון, נפרד מ"חוסמת רצף" שברמת התבנית).',
      expandFirstTemplate: true,
    },
    {
      id: 't-8c',
      target: '[data-action="toggle-add-onetime"]',
      placement: 'bottom',
      title: 'משימות חד-פעמיות',
      body: 'בנוסף לתבניות החוזרות, אפשר להגדיר <strong>משימות חד-פעמיות</strong> — אירועים חריגים ביום ובשעה ספציפיים, שאינם חוזרים (למשל סיור קבוצתי, אירוח, או משמרת מילואים). לכל משימה כזו אותן אבני-בניין כמו לתבנית: משבצות, תת-צוותים, חלונות עומס מוגבר, והשלמות שינה. הן נשמרות כחלק מסט המשימות ויופיעו בשבצ"ק הבא שייווצר.',
    },
    {
      id: 't-9',
      target: '.score-card.inline-badge',
      placement: 'bottom',
      title: 'מוכנות לשיבוץ',
      body: 'תג זה מסכם את הבדיקה המקדימה הכוללת — <strong>קריטי</strong> אדום / <strong>אזהרה</strong> כתום / <strong>בסדר</strong> ירוק. לחיצה על התג פותחת רשימה מפורטת של כל הממצאים.<br><br><strong>ממצאים קריטיים (חוסמים יצירת שבצ"ק):</strong><br>• <strong>פער כישורים</strong> — אין מספיק משתתפים ברמה/הסמכה הנדרשות לאיוש כל המשבצות של תבנית. פתרון: הוסף משתתפים, הרחב רמות מותרות, או הסר משבצת.<br>• <strong>פער ביום ספציפי</strong> — כוח אדם כולל מספיק, אך ביום או שעה ספציפיים אין מי שכשיר וזמין יחד — לרוב בגלל אי-זמינות מרוכזת.<br>• <strong>חריגת קיבולת</strong> — סך השעות הנדרשות מהצוות גדול מסך הזמינות (מעל 100% ניצול).<br><br><strong>אזהרות (יצירה אפשרית, מומלץ לבדוק):</strong><br>• <strong>נדירות כשירות</strong> — משבצת עם מועמד יחיד, צפיפות 90–100%, או פער רוטציה במשימת "קבוצה אחידה".<br><br>בנוסף, כל כרטיסיית תבנית מציגה תג <strong>!</strong> או <strong>⚠</strong> ספציפי לתבנית עצמה — לחיצה עליו פותחת רשימה ממוקדת לאותה תבנית.',
    },
    {
      id: 't-10',
      target: '[data-action="tset-panel-toggle"]',
      placement: 'bottom',
      title: 'סטים של משימות',
      body: 'בדומה למערכי משתתפים: שמור גרסאות מלאות של כללי המשימות (תבניות + משימות חד-פעמיות + כללי מרווח) ועבור ביניהן. שימושי לשמירת תצורות שונות לפי תקופה או צורך. <strong>שים לב</strong>: טעינת סט מחליפה את שלושת הרכיבים ביחד. תג "שונה" מסמן שערכת את הסט הפעיל ולא שמרת.',
    },
  ],
};

// ─── Track: schedule (22 steps) ──────────────────────────────────────────────

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
      body: 'שדה "ימים" קובע את אורך התקופה (1–7 ימים). כפתור <strong>⚡ צור שבצ"ק</strong> מפעיל את האופטימייזר. כשמשנים נתונים לאחר היצירה תופיע ההודעה "⚠ השיבוץ לא מעודכן" — יצירה מחדש מרעננת את התוצאה.',
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
    },
    {
      id: 's-4',
      target: '.day-nav-wrap',
      placement: 'bottom',
      title: 'ניווט בין ימים',
      body: 'כל כפתור = יום תפעולי. תג <strong>!</strong> אדום על יום מציין שיש בו הפרות שדורשות תיקון. <strong>יום 0</strong>, אם מופיע, מציג שיבוצים מהשבצ"ק הקודם — לקריאה בלבד. במצב חי בלבד: <strong>🧊</strong> = יום שעבר וחסום לעריכה; <strong>⏳</strong> = היום הנוכחי (חסום עד שעת העוגן).',
    },
    {
      id: 's-5',
      target: '.schedule-grid-container',
      placement: 'top',
      title: 'טבלת השיבוץ',
      body: 'כל שורה = פרק זמן; כל תא = משתתף משובץ או ריק. לחיצה על שם משתתף פותחת את הכרטיס האישי שלו, ולחיצה על תג משימה פותחת את לוח המשימה. מתחת לטבלה תמצא שתי תצוגות חלופיות (רצועות וגאנט) — נדבר עליהן בשלב הבא.',
    },
    {
      id: 's-5b',
      target: '[data-action="toggle-swimlane"], .swimlane-section, .gantt-section',
      placement: 'top',
      title: 'תצוגות חלופיות — רצועות וגאנט',
      body: 'מתחת לטבלת השיבוץ הרגילה יש שתי תצוגות נוספות, שתיהן ניתנות לקיפול:<br><br>• <strong>רצועות (Swimlane)</strong> — שורה לכל משתתף, עם פסים צבעוניים של משימות לאורך ציר זמן. שימושית לראות "מי עובד מתי" ולזהות פערים ארוכים בין משמרות. במצב חי מוצג סמן <strong>"עכשיו"</strong> אדום.<br>• <strong>גאנט</strong> — תצוגה דומה הממוקדת בסדר כרונולוגי, עם אנוטציות לחציית חצות (◄/►) שמראות שמשמרת ממשיכה ליום הבא.<br><br>במובייל, תצוגת הרצועות מחליפה את הגאנט. לחיצה על שם משתתף בכל אחת מהן פותחת את הכרטיס האישי שלו.',
    },
    {
      id: 's-6',
      target: '.participant-sidebar',
      placement: 'inline-start',
      title: 'סרגל עומס עבודה',
      body: 'מציג שעות אפקטיביות לכל משתתף — מתחילים (L0) ובכירים מוצגים בנפרד (החלק הסגלי 👤 מוסתר כברירת מחדל; הפעל אותו ע"י המתג בראש הסרגל). הפס הכהה = העומס שנצבר עד היום הנוכחי. <strong>לחץ על שם</strong> לפתיחת הכרטיס האישי. <strong>לחץ על הפס</strong> לפתיחת חלון פיזור יומי — סרגל מיני לכל יום + סימון פיק/היום.',
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
      body: '<strong>אילוצים קשים (HC)</strong> — שבצ"ק אינו ישים; חובה לתקן. <strong>אילוצים רכים (SC)</strong> — קנסות שמורידים את הציון אך השבצ"ק עדיין תקף. ניתן לקפל ולפתוח כל קטגוריה; הפרות מסודרות לפי יום.',
      mobileOverride: {
        target: '#violations-section > h2',
        placement: 'top',
        body: '<strong>HC</strong> — אילוצים קשים; השבצ"ק לא ישים עד תיקון. <strong>SC</strong> — אילוצים רכים; קנס בציון, אך השבצ"ק תקף. גלילה מטה מציגה את הקטגוריות והפרות לפי יום.',
      },
    },
    {
      id: 's-8',
      target: '.schedule-grid-container .participant-hover[data-assignment-id]:not([data-frozen])',
      placement: 'top',
      title: 'החלפה ידנית — חלק 1',
      body: 'הקשה (או ריחוף בעכבר) על שם משתתף בתא חושפת טולטיפ עם פעולות מהירות. <em>המדריך הציג עכשיו את הטולטיפ עבורך</em> — בשלב הבא נסביר את הכפתור הנכון.',
      hoverTarget: true,
      mobileOverride: {
        target: '.schedule-grid-container .participant-hover[data-assignment-id]:not([data-frozen])',
        title: 'החלפה ידנית — חלק 1',
        body: 'במגע, הקשה על שם משובץ בטבלה פותחת <strong>גיליון תחתון</strong> עם פרטי המשתתף — דרגה, קבוצה, הסמכות, פק"לים ופילוח עומס — ובתחתיתו כפתורי פעולה מהירה <strong>⇄ החלפה</strong> ו-<strong>🆘 חילוץ</strong> (חילוץ — במצב חי בלבד). <em>פתח את הגיליון על שם כלשהו</em>; בשלב הבא נסביר את כפתור ההחלפה.',
      },
    },
    {
      id: 's-8-action',
      target: '.participant-tooltip .btn-swap',
      placement: 'inline-start',
      title: 'החלפה ידנית — חלק 2',
      body: 'הכפתור <strong>⇄ החלפה</strong> פותח את בורר ההחלפות. מצב <strong>חופשי</strong> — בחר ממלא חדש למשבצת. מצב <strong>החלפה</strong> — שני משתתפים מחליפים מקום זה עם זה. סינונים: חיפוש, צ\'יפים של קבוצה/רמה, מיון לפי עומס. אם אין כשירים — <strong>מצב אבחון</strong> מציג את כל המועמדים שנפסלו ואת סיבת הפסילה.<br><br>התצוגה המקדימה כוללת שני מקטעים חשובים: <strong>(1) עומס לפני/אחרי</strong> לכל משתתף מושפע — עלייה באדום, ירידה בירוק. <strong>(2) שינויים באזהרות רכות</strong> — אזהרות חדשות לצד אזהרות שיבוטלו. עיין בשניהם לפני אישור.<br><br>תיבת <strong>"סמן ___ כלא-זמין"</strong> רושמת את המוחלף כלא-זמין לחלון המשבצת; כשהיא מסומנת מופיע שדה אופציונלי ל<strong>סיבה</strong> שיישמר בכרטיס המשתתף.',
      mobileOverride: {
        target: '.schedule-grid-container .participant-hover[data-assignment-id]:not([data-frozen])',
        placement: 'top',
        title: 'החלפה ידנית — חלק 2',
        body: 'בתוך הגיליון, <strong>⇄ החלפה</strong> פותח את בורר ההחלפות. מצב <strong>חופשי</strong> — בחר ממלא חדש למשבצת; מצב <strong>החלפה</strong> — שני משתתפים מחליפים מקום. סינון: חיפוש, צ\'יפים של קבוצה/רמה, ומיון לפי עומס; אם אין כשירים — <strong>מצב אבחון</strong> מציג מי נפסל ולמה. לפני אישור בדוק את <strong>העומס לפני/אחרי</strong> (עלייה באדום, ירידה בירוק) ואת <strong>השינויים באזהרות הרכות</strong>. תיבת <strong>"סמן כלא-זמין"</strong> רושמת את המוחלף כלא-זמין לחלון המשבצת, עם שדה <strong>סיבה</strong> אופציונלי.',
      },
    },
    {
      id: 's-8b',
      target: '#btn-undo, .undo-redo-group',
      placement: 'bottom',
      title: 'ביטול ושחזור',
      body: 'כפתורי ↪ <strong>ביטול</strong> ו-↩ <strong>שחזור</strong> בסרגל הכותרת עוקבים אחר כל ההחלפות הידניות, החילוצים, וההזרקות שביצעת. המספר בסוגריים מציג כמה פעולות שמורות בהיסטוריה. ↪ <strong>ביטול</strong> מחזיר את השבצ"ק למצבו לפני הפעולה האחרונה — <em>כולל</em> כניסות אי-זמינות שנרשמו יחד איתה. ↩ <strong>שחזור</strong> מחזיר את מה שבוטל. הסטאק אינו נשמר בין גרסאות שמורות — אם אתה עומד לנסות שינוי גדול, שמור גרסה תחילה כנקודת חזרה.',
    },
    {
      id: 's-8c',
      target: '.schedule-grid-container .participant-hover[data-pid], .schedule-grid-container [data-pid]',
      placement: 'top',
      title: 'ריחוף וקיצורי דרך',
      body: 'ריחוף עם העכבר חושף קיצורי דרך נסתרים שיחסכו לך הרבה ניווט:<br><br>• <strong>שם משתתף</strong> בגריד / ברצועות / בסרגל הצד → טולטיפ עם רמה, קבוצה, הסמכות, פק"לים, ופילוח עומס. כשמרחפים על תא שיבוץ ספציפי, מופיעים בתוך הטולטיפ כפתורים <strong>⇄ החלפה</strong> ו-<strong>🆘 חילוץ</strong> (חילוץ — במצב חי בלבד) — שינוי משמרת בלי לפתוח שום בורר ידנית.<br>• <strong>תג משימה</strong> בגריד / בגאנט → טולטיפ עם פרטי המשמרת, רשימת המשובצים, וכפתור <strong>📋 פתח חלונית משימה</strong> לניווט מהיר.<br><br>במגע: לחיצה ארוכה (חצי שנייה) על שם משתתף מנווטת ישירות לכרטיס האישי; הקשה רגילה פותחת גיליון תחתון עם אותו תוכן.',
      mobileOverride: {
        target: '.schedule-grid-container .participant-hover[data-pid], .schedule-grid-container [data-pid]',
        placement: 'top',
        title: 'קיצורי דרך במגע',
        body: 'במגע יש שני קיצורים מהירים על שם משתתף:<br><br>• <strong>הקשה רגילה</strong> פותחת גיליון תחתון עם הטולטיפ — דרגה, קבוצה, הסמכות, פק"לים, פילוח עומס, וכפתורי <strong>⇄ החלפה</strong> ו-<strong>🆘 חילוץ</strong> (במצב חי).<br>• <strong>לחיצה ארוכה</strong> (חצי שנייה) מדלגת על הגיליון ומנווטת ישר לכרטיס האישי של המשתתף.<br><br>הקשה על תג משימה פותחת גיליון מקביל עם פרטי המשמרת וקיצור ל-<strong>📋 חלונית משימה</strong>.',
      },
    },
    {
      id: 's-9',
      target: '#chk-live-mode',
      placement: 'bottom',
      title: 'מצב חי',
      body: 'מצב חי מקבע עוגן (יום + שעה). שיבוצים <strong>לפני</strong> העוגן — קפואים ולא ניתנים לעריכה. שיבוצים <strong>אחריו</strong> — ניתנים לעריכה, חילוץ, והזרקת משימות חירום. שימושי בניהול שבצ"ק בזמן אמת. <em>(בהדגמה זו מצב חי מופעל מראש עם עוגן בצהריים של יום 1.)</em>',
    },
    {
      id: 's-10',
      target: '.schedule-grid-container',
      placement: 'top',
      title: 'חילוץ — מילוי משבצת ריקה',
      body: 'במצב חי, משבצת פנויה בעתיד מציגה כפתור 🆘. האופטימייזר מחפש שרשרת החלפות (עומק 1 עד 3) שמשאירה את השבצ"ק תקף והוגן. כל תוכנית מקבלת תג איכות (<strong>מצוין / סביר / משמעותי</strong>) ואת רשימת השלבים שלה. עומק 4 מוצג רק כמוצא אחרון, עם אזהרה ייעודית. תוכניות שיוצרות הפרת אילוץ קשה מסומנות ⚠ בכותרת — ניתן עדיין להחיל אותן ("⚠ החל תוכנית — יש הפרות"), אך ההפרה תופיע בחלונית האזהרות.<br><br>תיבת <strong>"סמן את המוחלף כלא-זמין"</strong> רושמת את המשתתף שיצא כלא-זמין בחלון המשבצת — כדי שההחלטה תישמר לעתיד. כשמסומנת מופיע שדה אופציונלי ל<strong>סיבה</strong> שיישמר עם רשומת אי-הזמינות.',
    },
    {
      id: 's-10b',
      target: '#btn-where-is-everyone',
      placement: 'bottom',
      title: 'תמונת מצב — איפה כל משתמש נמצא?',
      body: 'תצוגה ייעודית שעונה "מי איפה" בנקודת זמן בודדת — בחר יום + שעה ותראה את כל המשתתפים ממוינים ל<strong>משובצים / במנוחה / לא זמינים / פנויים</strong>. שימושי לתכנון אד-הוק וזיהוי "פנאי לא מנוצל".',
    },
    {
      id: 's-10c',
      target: '.avail-strip',
      placement: 'top',
      title: 'בדיקת עתודה פנויה',
      body: 'סרגל מתקפל בין הגריד לגאנט: "מי פנוי בין שעה X לשעה Y?". לחיצה עליו פותח טופס בחירת טווח שעות עם סינון לפי <strong>דרגה / הסמכה / קבוצה</strong>, <strong>שולי ביטחון</strong> לפני/אחרי, ו<strong>מצב השלמת שינה</strong> לסינון מי שעדיין בחלון התאוששות (HC-15). נקודת הכניסה למציאת ממלאי-מקום מהירים.',
    },
    {
      id: 's-11',
      target: '#btn-manual-build',
      placement: 'bottom',
      title: 'בנייה ידנית',
      body: 'כפתור זה פותח שבצ"ק ריק לאיוש ידני. בחירת משבצת בטבלה פותחת מחסן משתתפים מסונן לפי כשירות; שורת הסטטוס מציגה את התקדמות האיוש; <strong>↪ ביטול</strong> מבטל את הפעולה האחרונה.',
      screenshot: { src: './tutorial/manual-warehouse.png', alt: 'מחסן המשתתפים במצב בנייה ידנית' },
    },
    {
      id: 's-12',
      target: '#btn-snap-toggle',
      placement: 'bottom',
      title: 'שמירת שבצ"קים',
      body: 'שמור גרסאות בשם — להשוואה בין שיבוצים, או לשמירת טיוטה לפני ניסיון שינוי. תג "שונה" = השבצ"ק הנוכחי שונה מהגרסה השמורה. לכל גרסה: <strong>טען / עדכן (במקום) / שכפל / שנה שם / מחק</strong>. טעינה ועדכון בלחיצה אחת; מחיקה אינה הפיכה. כפתור <strong>🔄 אפס</strong> שבסרגל הכותרת מוחק את השבצ"ק הנוכחי ומחזיר את המסך למצב שלפני היצירה — המשתתפים, כללי המשימות, ההגדרות והגרסאות השמורות נשמרים; הפעולה מבקשת אישור ואינה ניתנת לביטול דרך <strong>↪ ביטול</strong>.',
    },
    {
      id: 's-12b',
      target: '#btn-export-day-json, #btn-continuity-import, #continuity-chip',
      placement: 'bottom',
      title: 'יום 0 — שרשור בין שבצ"קים',
      body: 'הסרגל העליון מאפשר לחבר שבצ"קים עוקבים: <strong>📋 ייצוא יום</strong> שומר את מצב היום הנוכחי כקובץ הקשר. <strong>🔗 המשך מכאן</strong> מחיל אותו על שבצ"ק חדש. <strong>📋 חיבור לשבצ"ק קודם</strong> טוען קובץ הקשר ידנית. השבצ"ק החדש יציג כרטיסיית <strong>יום 0</strong> לקריאה בלבד — העוגן שמפעיל אילוצי גשר (HC-12, HC-14) בין השבצ"קים.',
    },
    {
      id: 's-13',
      target: '#btn-inject-task',
      placement: 'bottom',
      title: 'משימת חירום',
      body: 'פעיל רק במצב חי. הגדר משימה חד-פעמית שלא תוכננה מראש — שם, יום, שעה, משך, רמות והסמכות נדרשות. המערכת מחפשת את השיבוץ הפחות-משבש ומציגה <strong>תוכניות מדורגות</strong> לבחירה. תיבה אופציונלית "<strong>שמור את המשימה גם במסך המשימות</strong>" משאירה אותה כמשימה חד-פעמית קבועה (תופיע ביצירת השבצ"ק הבא).',
      screenshot: { src: './tutorial/inject-task.png', alt: 'חלון הזרקת משימת חירום — טופס פרטי משימה ומשבצות' },
    },
    {
      id: 's-14',
      target: '.participant-sidebar',
      placement: 'inline-start',
      title: 'אי-זמינות עתידית (Future SOS)',
      body: 'פתח כרטיס משתתף ← <strong>🆘 סמן אי-זמינות</strong> ← בחר חלון יום ושעה. שלא כמו חילוץ שמטפל במשבצת בודדת, Future SOS מחשב <strong>תוכנית אחת מאוחדת</strong> שמחליפה את כל השיבוצים שייפגעו יחד.<br><br>לפני הפעלת החיפוש, המערכת תציג <strong>רשימת כל השיבוצים שייפגעו</strong> עם תיבת סימון לכל אחד. בטל סימון של שיבוץ כדי להוציאו מהתוכנית — שימושי כשהמשתתף יכול לכסות חלק מהמשמרות בעצמו. שיבוצים מהעבר הקפוא (לפני העוגן) מוצגים בנפרד בקוביית "🔒 נעולים" ולא ניתן לשנותם. אם החיפוש לא מוצא תוכנית מלאה, ייפתח חלון הכרעה: להסיר משבצות בלתי-פתירות ולנסות שוב, לצמצם את החלון, או לבטל.',
      mobileOverride: {
        target: '.sidebar-fab',
        body: 'במובייל פתח את הסרגל הצף ← בחר משתתף ← <strong>🆘 סמן אי-זמינות</strong>. המערכת תציג את השיבוצים המושפעים (עם אפשרות להחריג חלקם) ותחליף את כולם בתוכנית אחת מאוחדת.',
      },
    },
    {
      id: 's-15',
      target: '#btn-export-pdf',
      placement: 'bottom',
      title: 'ייצוא',
      body: 'כפתור הייצוא פותח חלון בחירה. <strong>PDF</strong> — תצוגה מודפסת (יומית מפורטת + סיכום שבועי). <strong>Excel</strong> — גיליון נתונים עם עמודות זמן, משימה ומשתתף. הייצוא זמין לכל שבצ"ק שנוצר, גם ללא מצב חי.',
    },
  ],
};

// ─── Track: algorithm (settings tab — 10 steps) ──────────────────────────────

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
      target: '#acc-tutorial > [data-action="settings-accordion-toggle"]',
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
      body: 'הרשימה מציגה ערכות הגדרות — מובנות ושמורות. בחירת ערכה טוענת אותה מיידית. <strong>💾</strong> לצד הרשימה שומר ערכה חדשה. תג "שונה" = שינית מאז הטעינה האחרונה ולא שמרת. כפתור פתיחת החלונית המלאה חושף לכל ערכה: <strong>טען / עדכן (במקום) / שכפל / שנה שם / מחק</strong>. ערכות מובנות מסומנות "מובנה" ולא ניתן למחוק או לשנות שם להן.',
      openAccordion: 'acc-algorithm',
    },
    {
      id: 'a-3b',
      target: '#gm-day-start-hour',
      placement: 'inline-start',
      title: 'הגדרות כלליות — שעת תחילת יום תפעולי',
      body: '<strong>שעת תחילת יום תפעולי</strong> (ברירת מחדל 05:00) — קובעת את גבולות "יום 1..7" בכל המערכת: תצוגה, הקפאה במצב חי, חלוקת עומס, אי-זמינות, וייצוא. זוהי הגדרה בעלת השפעה רחבה — שינוי שלה מזיז את גבול היממה בכל המסכים, לכן כדאי לקבוע אותה פעם אחת לפני יצירת השבצ"ק.',
      openAccordion: ['acc-algorithm', 'acc-general'],
    },
    {
      id: 'a-3c',
      target: '[data-action="algo-auto-tune"]',
      placement: 'bottom',
      title: 'כיול אוטומטי',
      body: 'כפתור <strong>🎯 כיול אוטומטי</strong> מריץ את המתזמן עשרות פעמים מול המשתתפים, המשימות וההסמכות שהגדרת — ומחפש את צירוף המשקלות שמשיג את הציון הטוב ביותר <strong>עבור הנתונים שלך</strong>. התהליך אורך מספר דקות. הוא <strong>אינו הרסני</strong>: ההגדרות הנוכחיות לא ישונו — בסיומו תוצג המלצה עם טבלת השוואה המראה בדיוק אילו משקלות ישתנו, ואתה בוחר <strong>החל הגדרות מומלצות</strong> או סוגר (ייתכן גם "אין צורך בשינוי"). עדיף על כיוונון ידני של הסליידרים.',
      openAccordion: ['acc-algorithm', 'acc-general'],
      mobileOverride: {
        body: 'מכייל את <strong>כל המשקלות</strong> מהנתונים שלך (משתתפים, משימות, הסמכות). אורך מספר דקות, ורק <strong>מציע</strong> — ההגדרות לא ישונו עד שתאשר <strong>החל הגדרות מומלצות</strong>. עדיף על כוונון ידני של הסליידרים.',
      },
    },
    {
      id: 'a-4',
      target: '.algo-slider[data-action="algo-weight-slider"]',
      placement: 'inline-start',
      title: 'משקלות האלגוריתם',
      body: 'כל סליידר קובע את החשיבות של גורם מסוים — איזון עומס, איזון יומי, מנוחה. שנה בהדרגה ובדוק את ההשפעה על הציון; ערך ברירת המחדל מוצג ליד כל משקל לעיון.',
      openAccordion: ['acc-algorithm', 'acc-weights'],
    },
    {
      id: 'a-5',
      target: '.algo-toggle-item:has(input[data-code="HC-3"])',
      placement: 'inline-end',
      title: 'תנאים מחייבים — קו אדום',
      body: 'אילוצים קשים — אם מופרים, השבצ"ק פסול. בדרך-כלל אין לנטרל אותם. ⚠ "מושבת" = המערכת תדלג על הבדיקה — נטרל רק אם אתה יודע בדיוק מה אתה עושה.',
      openAccordion: ['acc-algorithm', 'acc-constraints'],
    },
    {
      id: 'a-6',
      target: '#acc-entities',
      placement: 'bottom',
      title: 'הסמכות ופק"לים',
      body: 'הגדר אילו הסמכות קיימות. לכל הסמכה ניתן לבחור <strong>צבע</strong> (פלטה מובנית או הקסה אישית 🎨); ניגודיות נמוכה תידחה. <strong>פק"לים</strong> = פק"לים תפעוליים — אחריות תוספתית שצמודה לאדם. שינויים מופיעים מיידית בלשוניות משתתפים ומשימות.',
      openAccordion: 'acc-entities',
    },
    {
      id: 'a-7',
      target: '#acc-additional',
      placement: 'top',
      title: 'מראה · אחסון · אזור סכנה',
      body: 'מתג <strong>בהיר/כהה</strong> — המדריך הנוכחי גם הוא מתאים את עצמו. <strong>יצירת שבצ"ק</strong> — קביעת מספר ניסיונות ברירת-מחדל. <strong>שימוש באחסון</strong> — דשבורד שמראה מה תופס מקום ב-localStorage (גרסאות שמורות, מערכים, סטים, ערכות), עם התראה כשהאחסון מלא. <strong>⚠ איפוס מערכת</strong> — מוחק את כל הנתונים; אל תלחץ בטעות.',
      openAccordion: 'acc-additional',
    },
    {
      id: 'a-8',
      target: '#acc-transfer',
      placement: 'top',
      title: 'ייבוא / ייצוא נתונים',
      body: 'ייצוא לקובץ JSON — לגיבוי או למחשב אחר. בייבוא ייפתח חלון בחירה: גיבוי מלא מחליף את כל הנתונים, וייבוא ממוקד מאפשר להוסיף כערכה/סט חדשים או להחליף קיימים. ייצוא Excel/PDF זמינים גם מלשונית השבצ"ק.',
      openAccordion: 'acc-transfer',
    },
  ],
};

// ─── Track: profile (7 steps + guard) ────────────────────────────────────────

const PROFILE_TRACK: TutorialTrack = {
  id: 'profile',
  label: 'כרטיס משתתף',
  icon: '🪪',
  description: 'מבט אישי על משתתף',
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
      body: 'המספר הגדול הוא סך שעות העומס <strong>המשוקלל</strong> — לא שעות גולמיות (חלונות עומס משפיעים על המשקל; משימות בלי עומס לא נספרות כלל). זה המספר שהאלגוריתם מנסה לאזן בין המשתתפים. בכותרת שמעל המספר — תגי <strong>הסמכות</strong>, <strong>פק"לים</strong>, ו-❤/🚫 ל<strong>העדפות משימה</strong> (אם הוגדרו).',
    },
    {
      id: 'pr-3',
      target: '.profile-left',
      placement: 'inline-end',
      title: 'לו"ז אישי',
      body: 'כל שיבוצי המשתתף, ממוינים לפי יום. יום 0 (אם קיים) מציג שיבוצים מלפני תחילת השבצ"ק — לקריאה בלבד, לצורך הקשר. תווית <strong>← יום N</strong> = משמרת חוצת ימים. במצב חי, לכל שיבוץ עתידי כפתור <strong>🆘</strong> (חילוץ של אותה משבצת) ולכל שיבוץ עבר אייקון <strong>🧊</strong> (קפוא). לחיצה על שם משימה פותחת את לוח המשימה.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'pr-3b',
      target: '.profile-card:has(.metrics-summary)',
      placement: 'inline-start',
      title: 'מדדי עומס',
      body: 'כרטיס זה עונה על השאלה "כמה עמוס המשתתף?". השורה הראשונה חוזרת על העומס המשוקלל מהכותרת. <strong>אחוז ניצול</strong> מודד אותו יחסית ל<strong>שעות הזמינות של המשתתף עצמו</strong> — לא לכל התקופה — וצבוע ירוק / כתום / אדום לפי סף, כך שעומס-יתר או תת-ניצול בולטים מיד. מתחת, <strong>פירוט לפי סוג משימה</strong> מראה כמה שעות הושקעו בכל משימה — לא רק כמה, אלא על מה.',
      mobileOverride: {
        placement: 'top',
        body: 'הכרטיס עונה "כמה עמוס המשתתף?". <strong>אחוז ניצול</strong> = העומס יחסית לשעות הזמינות של המשתתף עצמו, צבוע ירוק / כתום / אדום לפי סף. מתחת, <strong>פירוט לפי סוג משימה</strong> מראה כמה שעות הושקעו בכל משימה.',
      },
    },
    {
      id: 'pr-4',
      target: '.profile-right',
      placement: 'inline-start',
      title: 'אי-זמינות',
      body: 'כרטיס אי-הזמינות מאחד שלוש רמות: כללים קבועים, אי-זמינות עתידית (סקופ-שבצ"ק), ושינויי הסמכה. <strong>🆘 סמן אי-זמינות</strong> ו-<strong>📜 שינוי הסמכה</strong> — אם מצב חי כבוי, תופיע בקשה אוטומטית להפעילו ולבחור עוגן; לאחר מכן תחושב תוכנית מאוחדת שמחליפה את כל השיבוצים שייפגעו. <strong>הסר</strong> ליד כל רשומה מבטל אותה.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'pr-4b',
      target: '[data-action="capability-change"]',
      placement: 'inline-start',
      title: 'שינוי הסמכה (אובדן הסמכה אמצע שבצ"ק)',
      body: 'הכפתור <strong>📜 שינוי הסמכה</strong> מטפל בתרחיש שבו הסמכה של המשתתף פוקעת או נשללת באמצע השבצ"ק — למשל אישור שתוקפו תם. לחיצה עליו פותחת בורר: בחר אילו הסמכות אבדו ולאיזו תקופה עתידית. המערכת תאתר את <strong>כל</strong> השיבוצים העתידיים שדורשים את אותן הסמכות, ותציע תוכנית החלפה מאוחדת — באותו ממשק של Future SOS, עם תוכניות מדורגות לבחירה. לאחר ההחלה, רישום השינוי מופיע בכרטיס אי-הזמינות שמתחת וניתן להסרה בלחיצת <strong>הסר</strong>. <em>הכפתור מוצג רק למשתתפים שמחזיקים לפחות הסמכה אחת.</em>',
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

// ─── Track: task-panel (6 steps + guard) ─────────────────────────────────────

const TASK_PANEL_TRACK: TutorialTrack = {
  id: 'task-panel',
  label: 'לוח משימה',
  icon: '🗂',
  description: 'מבט פר-משימה',
  enterView: 'task-panel',
  steps: [
    {
      id: 'tp-1',
      target: '.task-panel-topbar',
      placement: 'bottom',
      title: 'לוח משימה — מבט-על',
      body: 'הכותרת מציגה את שם המשימה, תגי תכונות (קבוצה אחידה, חוסמת רצף), וחלונות עומס מוגבר. לצידה: מדדי מפתח — מספר המשמרות ומצב המילוי. כפתור <strong>חזור לשבצ"ק</strong> בראש הכרטיס מחזיר ללשונית הראשית בכל עת.',
    },
    {
      id: 'tp-2',
      target: '.tp-needs-attention',
      placement: 'bottom',
      title: 'משבצות לא מאוישות',
      body: 'כרטיס זה מופיע רק כשיש משבצות לא מאוישות. כל שורה מציגה: יום, שעה, ושם המשבצת (תפקיד) — מיפוי מהיר של מה שחסר. זוהי רשימת מיפוי בלבד — המשבצות הריקות כאן אינן ניתנות לאיוש מהלוח. את האיוש מבצעים בגריד השבצ"ק: <strong>🆘 חילוץ</strong> על משבצת ריקה (במצב חי) או <strong>⇄ החלפה</strong> על תא מאויש.',
    },
    {
      id: 'tp-3',
      target: '.task-panel-timeline-card',
      placement: 'inline-start',
      title: 'ציר זמן שבועי',
      body: 'כל שורה = יום, עמודות = שעות. פסים כתומים = חלונות עומס מוגבר. ריחוף מעל משמרת מציג את פרטיה. בכל תא משובץ: <strong>🆘 חילוץ</strong> ו-<strong>⇄ החלפה</strong> זמינים ישירות מכאן (במצב חי, שיבוצי עבר מוצגים עם 🧊 במקום).',
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
      body: 'מרכז את הדרישות לכל משבצת — מספר ממלאים, רמות מותרות (תג ~ = עדיפות נמוכה), הסמכות נדרשות, ותת-צוות. כאן רואים בדיוק מה דרוש לכל תפקיד.',
      mobileOverride: { placement: 'top' },
    },
    {
      id: 'tp-4b',
      target: '.tp-meta-list',
      placement: 'inline-start',
      title: 'תכונות המשימה',
      body: 'כרטיס <strong>⚙️ תכונות משימה</strong> מרכז את האופן שבו המערכת "שוקלת" את המשימה: <strong>משקל בסיס</strong>, תוספת <strong>עומס מוגבר ×N</strong> לכל חלון מוגבר, האם המשימה <strong>חוסמת רצף</strong> משימות כבדות, האם <strong>נדרשת אותה הקבוצה</strong>, וה<strong>פער מנוחה מינימלי</strong> שנדרש לפני משימה עמוסה אחרת. אלו הערכים שהאופטימייזר מאזן — והם מסבירים למה המשימה מאוישת כפי שהיא.',
      mobileOverride: {
        placement: 'top',
        body: 'הכרטיס <strong>⚙️ תכונות משימה</strong> מציג כיצד המערכת שוקלת את המשימה מבחינה מספרית: <strong>משקל בסיס</strong>, תוספת <strong>עומס מוגבר ×N</strong> לכל חלון, <strong>חוסמת רצף</strong>, <strong>נדרשת אותה הקבוצה</strong>, ו<strong>פער מנוחה מינימלי</strong>. אלו הערכים שהאופטימייזר מאזן בעת השיבוץ.',
      },
    },
    {
      id: 'tp-5',
      target: '.metrics-breakdown',
      placement: 'inline-start',
      title: 'השוואת העומסים בין המשתתפים',
      body: 'גרף עמודות שמשווה בין המשתתפים שעבדו במשימה זו — לכל אחד מספר השעות ומספר המשמרות שצבר בה. לחיצה על שם משתתף פותחת את הכרטיס האישי שלו.',
      mobileOverride: { placement: 'top' },
    },
  ],
};

// ─── Track: full-tour (curated subset across tabs) ───────────────────────────

const FULL_TOUR_TRACK: TutorialTrack = {
  id: 'full-tour',
  label: 'סיור כללי',
  icon: '📖',
  description: 'סקירה מודרכת · ~43 שלבים',
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
    { ...stepById(PARTICIPANTS_TRACK, 'p-3'), id: 'ft-p-3' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-4'), id: 'ft-p-4' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-5'), id: 'ft-p-5' },
    { ...stepById(PARTICIPANTS_TRACK, 'p-8'), id: 'ft-p-8' },
    // Task-rules subset (now includes t-7b — Sleep & Recovery is HC-15, must be in tour)
    { ...stepById(TASK_RULES_TRACK, 't-1'), id: 'ft-t-1', switchToTab: 'task-rules' },
    { ...stepById(TASK_RULES_TRACK, 't-2'), id: 'ft-t-2' },
    { ...stepById(TASK_RULES_TRACK, 't-3'), id: 'ft-t-3' },
    { ...stepById(TASK_RULES_TRACK, 't-5'), id: 'ft-t-5' },
    { ...stepById(TASK_RULES_TRACK, 't-7'), id: 'ft-t-7' },
    { ...stepById(TASK_RULES_TRACK, 't-7b'), id: 'ft-t-7b' },
    { ...stepById(TASK_RULES_TRACK, 't-9'), id: 'ft-t-9' },
    {
      id: 'ft-one-time',
      target: '[data-action="toggle-add-onetime"]',
      placement: 'bottom',
      title: 'משימות חד-פעמיות',
      body: 'בנוסף לתבניות הקבועות, ניתן להוסיף משימות חד-פעמיות — אירועים חריגים ביום ושעה ספציפיים, שאינם חוזרים. למשל: סיור קבוצתי, אירוח, או משמרת מילואים. יופיעו בשבצ"ק הבא שייווצר.',
    },
    // Bridge step before the schedule block.
    {
      id: 'ft-schedule-intro',
      target: null,
      placement: 'center',
      title: 'הצעדים הבאים: לשונית השבצ"ק',
      body: 'הסיור עומד להציג את לשונית השבצ"ק. השבצ"ק כבר נוצר עבור הדגמה, ותוכל לראות בו את כל המנגנונים — אזהרות, מצב חי, ומשבצות לאיוש.',
      switchToTab: 'schedule',
    },
    // Schedule subset (now includes s-12b — Day 0 / continuity is a header feature,
    // s-5b — alternative views, s-8b — undo/redo, s-8c — hover discoverability)
    { ...stepById(SCHEDULE_TRACK, 's-1'), id: 'ft-s-1' },
    { ...stepById(SCHEDULE_TRACK, 's-3'), id: 'ft-s-3' },
    { ...stepById(SCHEDULE_TRACK, 's-4'), id: 'ft-s-4' },
    { ...stepById(SCHEDULE_TRACK, 's-5'), id: 'ft-s-5' },
    { ...stepById(SCHEDULE_TRACK, 's-5b'), id: 'ft-s-5b' },
    { ...stepById(SCHEDULE_TRACK, 's-6'), id: 'ft-s-6' },
    { ...stepById(SCHEDULE_TRACK, 's-7'), id: 'ft-s-7' },
    { ...stepById(SCHEDULE_TRACK, 's-8'), id: 'ft-s-8' },
    { ...stepById(SCHEDULE_TRACK, 's-8-action'), id: 'ft-s-8-action' },
    { ...stepById(SCHEDULE_TRACK, 's-8b'), id: 'ft-s-8b' },
    { ...stepById(SCHEDULE_TRACK, 's-8c'), id: 'ft-s-8c' },
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
    },
    {
      id: 'ft-task-panel-pointer',
      target: '.task-panel-hover[data-source-name]',
      placement: 'top',
      title: 'לוח משימה',
      body: 'לחץ על תג משימה בגריד לפתיחת לוח מפורט — ציר זמן שבועי, דרישות, פילוח עומס. למדריך מפורט: <strong>הגדרות ← 📖 מדריכים ← לוח משימה</strong>.',
    },
    // Algorithm subset (now includes a-3b — day-start-hour is the largest behavioral switch)
    { ...stepById(ALGORITHM_TRACK, 'a-3'), id: 'ft-a-3', switchToTab: 'algorithm' },
    { ...stepById(ALGORITHM_TRACK, 'a-3b'), id: 'ft-a-3b' },
    { ...stepById(ALGORITHM_TRACK, 'a-4'), id: 'ft-a-4' },
    { ...stepById(ALGORITHM_TRACK, 'a-5'), id: 'ft-a-5' },
    { ...stepById(ALGORITHM_TRACK, 'a-6'), id: 'ft-a-6' },
    { ...stepById(ALGORITHM_TRACK, 'a-8'), id: 'ft-a-8' },
    {
      id: 'ft-home',
      target: '#app-title',
      placement: 'bottom',
      title: 'כפתור הבית — השבצקיסט',
      body: 'הכותרת <strong>השבצקיסט</strong> שלמעלה היא גם כפתור הבית — הקש עליה בכל רגע כדי לחזור למסך הפתיחה. מסך הבית הוא נקודת המוצא שלך: הוא מראה אם השבצ"ק <strong>ישים</strong> ומה ה<strong>ציון</strong> שלו, כפתור גדול ל<strong>צור שבצ"ק</strong> בלחיצה אחת, פירוט כל מה שחוסם יצירה (אם יש), קישורים מהירים לכל הלשוניות, וכפתור <strong>📖 סיור מודרך</strong> לפתיחת הסיור הזה שוב.',
    },
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

// ─── Deep tour ───────────────────────────────────────────────────────────────
// The deep tour is not a TutorialTrack — it is a *sequence* of the six topic
// tracks run back-to-back by the engine (see tutorial.ts). Defining the order
// and the picker descriptor here keeps it pure data alongside TRACKS. New steps
// added to any topic track flow into the deep tour automatically — there is no
// curated copy to maintain (contrast FULL_TOUR_TRACK).
export const DEEP_TOUR_SEQUENCE = [
  'participants',
  'task-rules',
  'schedule',
  'algorithm',
  'profile',
  'task-panel',
] as const;

export const DEEP_TOUR_DESCRIPTOR = {
  id: 'deep-tour',
  icon: '🧭',
  label: 'סיור מעמיק',
  description: 'כל ששת המסלולים במלואם · ~72 שלבים',
} as const;
