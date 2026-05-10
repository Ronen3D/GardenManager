// Analyze walkthrough captures and flag issues per step.
// Usage: node scripts/analyze-walkthrough.mjs [walkthrough-desktop]
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.argv[2] ?? path.join('test-output', 'walkthrough-desktop');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function rectInViewport(r, vp) {
  if (!r) return true;
  // fully off-screen if no overlap with viewport at all
  return !(r.x + r.width <= 0 || r.x >= vp.width || r.y + r.height <= 0 || r.y >= vp.height);
}

const allRows = [];
for (const f of files.sort()) {
  const captures = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  const trackId = path.basename(f, '.json');
  for (const cap of captures) {
    const issues = [];
    if (!cap.titleText) {
      issues.push('NO_TITLE_CAPTURED');
    }
    if (cap.centered) {
      issues.push('CENTERED_FALLBACK');
    } else {
      // Check spotlight in viewport
      if (cap.spotlightBox && !rectInViewport(cap.spotlightBox, cap.viewport)) {
        issues.push('OFF_SCREEN_SPOTLIGHT');
      }
      // Check spotlight covered by popover
      if (cap.spotlightBox && cap.popoverBox) {
        if (rectsIntersect(cap.spotlightBox, cap.popoverBox)) {
          issues.push('TARGET_COVERED_BY_POPOVER');
        }
      }
    }
    // Check popover in viewport
    if (cap.popoverBox && !rectInViewport(cap.popoverBox, cap.viewport)) {
      issues.push('POPOVER_OFF_SCREEN');
    }
    allRows.push({
      trackId,
      stepIndex: cap.stepIndex,
      counter: cap.counterText,
      title: cap.titleText,
      centered: cap.centered,
      issues,
      popoverBox: cap.popoverBox,
      spotlightBox: cap.spotlightBox,
    });
  }
}

// Print TSV-style report
console.log('=== ALL STEPS ===');
console.log(['track', 'idx', 'counter', 'title', 'centered', 'status', 'issues'].join('\t'));
for (const r of allRows) {
  const status = r.issues.length === 0 ? 'OK' : 'PROBLEM';
  console.log(
    [
      r.trackId,
      r.stepIndex,
      r.counter ?? '',
      r.title ?? '',
      r.centered,
      status,
      r.issues.join(','),
    ].join('\t'),
  );
}

console.log('\n=== PROBLEMS ONLY ===');
for (const r of allRows) {
  if (r.issues.length === 0) continue;
  console.log(`\n[${r.trackId}] step ${r.stepIndex} (${r.counter}): "${r.title}"`);
  console.log(`  issues: ${r.issues.join(', ')}`);
  console.log(`  centered: ${r.centered}`);
  console.log(`  popoverBox: ${JSON.stringify(r.popoverBox)}`);
  console.log(`  spotlightBox: ${JSON.stringify(r.spotlightBox)}`);
}

const problems = allRows.filter((r) => r.issues.length > 0);
const passes = allRows.filter((r) => r.issues.length === 0);
console.log('\n=== SUMMARY ===');
console.log(`Total steps walked: ${allRows.length}`);
console.log(`Passed: ${passes.length}`);
console.log(`Problems: ${problems.length}`);
const byIssue = {};
for (const r of problems) {
  for (const i of r.issues) {
    byIssue[i] = (byIssue[i] || 0) + 1;
  }
}
for (const [k, v] of Object.entries(byIssue)) {
  console.log(`  ${k}: ${v}`);
}
