(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))a(n);new MutationObserver(n=>{for(const i of n)if(i.type==="childList")for(const l of i.addedNodes)l.tagName==="LINK"&&l.rel==="modulepreload"&&a(l)}).observe(document,{childList:!0,subtree:!0});function s(n){const i={};return n.integrity&&(i.integrity=n.integrity),n.referrerPolicy&&(i.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?i.credentials="include":n.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function a(n){if(n.ep)return;n.ep=!0;const i=s(n);fetch(n.href,i)}})();var b=(t=>(t[t.L0=0]="L0",t[t.L1=1]="L1",t[t.L2=2]="L2",t[t.L3=3]="L3",t[t.L4=4]="L4",t))(b||{}),w=(t=>(t.Nitzan="Nitzan",t.Salsala="Salsala",t.Hamama="Hamama",t))(w||{}),S=(t=>(t.Adanit="Adanit",t.Hamama="Hamama",t.Shemesh="Shemesh",t.Mamtera="Mamtera",t.Karov="Karov",t.Karovit="Karovit",t.Aruga="Aruga",t))(S||{}),P=(t=>(t.Scheduled="Scheduled",t.Locked="Locked",t.Manual="Manual",t.Conflict="Conflict",t))(P||{}),x=(t=>(t.Error="Error",t.Warning="Warning",t))(x||{}),Vt=(t=>(t.SegolMain="SegolMain",t.SegolSecondary="SegolSecondary",t))(Vt||{});const Qe={minRestWeight:15,fairnessWeight:8,penaltyWeight:4,bonusWeight:3,hamamaL3Penalty:50,hamamaL4Penalty:200,shemeshSameGroupBonus:10,backToBackPenalty:3,maxIterations:1e4,maxSolverTimeMs:3e4};var D=(t=>(t.Work1="Work1",t.Rest8="Rest8",t.Work2="Work2",t.Rest16="Rest16",t))(D||{}),O=(t=>(t.Critical="Critical",t.Warning="Warning",t.Info="Info",t))(O||{});const ts=6e4,es=36e5,ve=Symbol.for("constructDateFrom");function lt(t,e){return typeof t=="function"?t(e):t&&typeof t=="object"&&ve in t?t[ve](e):t instanceof Date?new t.constructor(e):new Date(e)}function Y(t,e){return lt(e||t,t)}function ss(t,e,s){return lt(t,+Y(t)+e)}function $t(t,e,s){return ss(t,e*es)}function as(t,e){let s,a=e?.in;return t.forEach(n=>{!a&&typeof n=="object"&&(a=lt.bind(null,n));const i=Y(n,a);(!s||s<i||isNaN(+i))&&(s=i)}),lt(a,s||NaN)}function ns(t,e){let s,a=e?.in;return t.forEach(n=>{!a&&typeof n=="object"&&(a=lt.bind(null,n));const i=Y(n,a);(!s||s>i||isNaN(+i))&&(s=i)}),lt(a,s||NaN)}function is(t){return e=>{const s=Math.trunc,a=s(e);return a===0?0:a}}function os(t,e){return+Y(t)-+Y(e)}function ls(t,e,s){const a=os(t,e)/ts;return is()(a)}function Ht(t,e){return+Y(t)>+Y(e)}function et(t,e){return+Y(t)<+Y(e)}function St(t,e){return+Y(t)==+Y(e)}function rt(t,e){return et(t.start,e.end)&&et(e.start,t.end)}function Bt(t,e){for(const s of e){const a=et(s.start,t.start)||St(s.start,t.start),n=Ht(s.end,t.end)||St(s.end,t.end);if(a&&n)return!0}return!1}function rs(t,e){return et(t.end,e.start)?ls(e.start,t.end):0}function cs(t,e){return rs(t,e)/60}function Ie(t){return[...t].sort((e,s)=>e.start.getTime()-s.start.getTime())}function ds(t){return t.length===0?null:{start:ns(t.map(e=>e.start)),end:as(t.map(e=>e.end))}}function us(t,e,s){const a=[];let n=t;for(let i=0;i<s;i++){const l=$t(n,e);a.push({start:n,end:l}),n=l}return a}const Ce=40,Ae={[D.Work1]:8,[D.Rest8]:8,[D.Work2]:8,[D.Rest16]:16},jt=[D.Work1,D.Rest8,D.Work2,D.Rest16];function ps(t){const e=jt.indexOf(t);return jt[(e+1)%jt.length]}function fs(t,e){const s=new Map,a=Math.floor(Ce/8);return t.forEach((n,i)=>{const l=i%a,o=l*8,r=$t(e,o),c=$t(r,Ae[D.Work1]);s.set(n.id,{participantId:n.id,phase:D.Work1,phaseStart:r,phaseEnd:c,staggerIndex:l})}),s}function dt(t,e){const s=[],a=t.staggerIndex*8;let n=$t(t.phaseStart,-a),i=D.Work1,l=n;for(;et(l,e);){const o=Ae[i],r=$t(l,o);s.push({phase:i,start:l,end:r}),i=ps(i),l=r}return s}function Ee(t,e){for(const s of t)if((s.phase===D.Rest8||s.phase===D.Rest16)&&(St(e,s.start)||Ht(e,s.start))&&et(e,s.end))return{inRest:!0,restEndsAt:s.end};return{inRest:!1}}function ee(t,e){for(const s of e)if(s.phase===D.Work1||s.phase===D.Work2){const a=(St(t.start,s.start)||Ht(t.start,s.start))&&et(t.start,s.end),n=Ht(t.end,s.start)&&(St(t.end,s.end)||et(t.end,s.end));if(a&&n)return!0}return!1}const qt=8;function se(t,e,s){const a=new Date(t.getTime()-qt*36e5);for(const n of e){const i=s.get(n.taskId);if(i&&i.timeBlock.end.getTime()>a.getTime()&&i.timeBlock.start.getTime()<t.getTime())return!1}return!0}function ms(t,e){for(const s of t)if((s.phase===D.Work1||s.phase===D.Work2)&&s.start.getTime()>e.getTime())return s.start;return null}function gs(t,e,s){const a=new Map;for(const i of s)a.set(i.id,i);const n=new Map;for(const i of t){let l=0,o=0;for(const r of e){if(r.participantId!==i.id)continue;const c=a.get(r.taskId);if(c&&!c.isLight){const d=(c.timeBlock.end.getTime()-c.timeBlock.start.getTime())/36e5;l+=d,o++}}n.set(i.id,{totalHours:l,nonLightCount:o})}return n}function hs(t){const e=new Map;for(const s of t)e.set(s.id,s);return e}function vs(t){const e=new Map;for(const s of t)e.set(s.id,s);return e}function G(t,e,s,a,n){return{severity:x.Error,code:t,message:e,taskId:s,slotId:a,participantId:n}}function bs(t,e,s){const a=e.slots.find(i=>i.slotId===s);return a?a.acceptableLevels.includes(t.level)||t.level>Math.max(...a.acceptableLevels)?null:G("LEVEL_MISMATCH",`Participant ${t.name} (L${t.level}) does not meet level requirement [${a.acceptableLevels.map(i=>"L"+i).join(",")}] for ${e.name} slot "${a.label}"`,e.id,s,t.id):G("SLOT_NOT_FOUND",`Slot ${s} not found in task ${e.id}`,e.id,s,t.id)}function ys(t,e,s){const a=e.slots.find(n=>n.slotId===s);if(!a)return null;for(const n of a.requiredCertifications)if(!t.certifications.includes(n))return G("CERT_MISSING",`Participant ${t.name} lacks required certification "${n}" for ${e.name} slot "${a.label}"`,e.id,s,t.id);return null}function ks(t,e){return Bt(e.timeBlock,t.availability)?null:G("AVAILABILITY_VIOLATION",`Participant ${t.name} is not available for the full duration of ${e.name}`,e.id,void 0,t.id)}function $s(t,e){if(!t.sameGroupRequired||e.length===0)return[];const s=new Set(e.map(a=>a.group));return s.size>1?[G("GROUP_MISMATCH",`Task ${t.name} requires all participants from the same group, but found groups: [${[...s].join(", ")}]`,t.id)]:[]}function Ss(t,e){if(![S.Shemesh,S.Aruga,S.Hamama].includes(t.type))return[];const a=[];for(const n of e)n.level===b.L4&&a.push(G("L4_FORBIDDEN",`${n.name} (L4) is strictly forbidden from ${t.type} task "${t.name}"`,t.id,void 0,n.id));return a}function Ls(t,e,s){const a=[],i=e.filter(l=>l.participantId===t).filter(l=>s.has(l.taskId));for(let l=0;l<i.length;l++)for(let o=l+1;o<i.length;o++){const r=s.get(i[l].taskId),c=s.get(i[o].taskId);rt(r.timeBlock,c.timeBlock)&&a.push(G("DOUBLE_BOOKING",`Participant ${t} is double-booked: "${r.name}" and "${c.name}" overlap`,r.id,void 0,t))}return a}function ws(t,e){const s=[],a=e.filter(n=>n.taskId===t.id);for(const n of t.slots){const i=a.filter(l=>l.slotId===n.slotId);i.length===0?s.push(G("SLOT_UNFILLED",`Slot "${n.label}" in ${t.name} has no participant assigned`,t.id,n.slotId)):i.length>1&&s.push(G("SLOT_OVERBOOKED",`Slot "${n.label}" in ${t.name} has ${i.length} participants (expected 1)`,t.id,n.slotId))}return s}function Ts(t,e){const s=[],a=e.filter(i=>i.taskId===t.id),n=new Set;for(const i of a)n.has(i.participantId)&&s.push(G("DUPLICATE_IN_TASK",`Participant ${i.participantId} is assigned multiple times to ${t.name}`,t.id,i.slotId,i.participantId)),n.add(i.participantId);return s}function Ds(t,e,s,a,n,i){if(t.level!==b.L1)return[];const l=a.get(t.id);if(!l)return[];const o=[],r=dt(l,n),c=i??(()=>{const u=new Map;for(const p of s)u.set(p.id,p);return u})(),d=e.filter(u=>u.participantId===t.id);for(const u of d){const p=c.get(u.taskId);if(p){if(p.type===S.Adanit)ee(p.timeBlock,r)||o.push(G("L1_CYCLE_MISALIGNED",`L1 participant ${t.name} assigned to "${p.name}" but this does not align with their 8-8-8-16 work phase.`,p.id,u.slotId,t.id));else for(const f of r)if((f.phase===D.Rest8||f.phase===D.Rest16)&&rt(p.timeBlock,{start:f.start,end:f.end})){o.push(G("L1_REST_VIOLATION",`L1 participant ${t.name} assigned to "${p.name}" during mandatory ${f.phase===D.Rest8?"8h":"16h"} rest period. L1 absolute rest — no exceptions.`,p.id,u.slotId,t.id));break}}}return o}function Is(t,e,s,a){if(t.level!==b.L1)return[];const n=[],i=a??(()=>{const r=new Map;for(const c of s)r.set(c.id,c);return r})(),l=e.filter(r=>r.participantId===t.id),o=l.filter(r=>{const c=i.get(r.taskId);return c&&c.type===S.Adanit});for(const r of o){const c=i.get(r.taskId),d=l.filter(u=>u.id!==r.id);se(c.timeBlock.start,d,i)||n.push(G("L1_PRE_GAP_VIOLATION",`L1 participant ${t.name} assigned to "${c.name}" without ${qt}h of free time beforehand. The pre-gap rule requires ${qt}h of zero assignments before any Adanit shift.`,c.id,r.slotId,t.id))}return n}function mt(t,e,s,a,n){const i=[],l=hs(e),o=vs(t);for(const r of t){const c=s.filter(u=>u.taskId===r.id);i.push(...ws(r,s)),i.push(...Ts(r,s));for(const u of c){const p=l.get(u.participantId);if(!p){i.push(G("PARTICIPANT_NOT_FOUND",`Assignment references unknown participant ${u.participantId}`,r.id,u.slotId,u.participantId));continue}const f=bs(p,r,u.slotId);f&&i.push(f);const m=ys(p,r,u.slotId);m&&i.push(m);const g=ks(p,r);g&&i.push(g)}const d=c.map(u=>l.get(u.participantId)).filter(u=>u!==void 0);i.push(...$s(r,d)),i.push(...Ss(r,d))}for(const r of e)i.push(...Ls(r.id,s,o));if(a&&n)for(const r of e)r.level===b.L1&&i.push(...Ds(r,s,t,a,n,o));for(const r of e)r.level===b.L1&&i.push(...Is(r,s,t,o));return{valid:i.length===0,violations:i}}function Cs(t){const e=new Map;for(const s of t)e.set(s.id,s);return e}function As(t,e,s){const a=[];for(const n of e){if(n.participantId!==t)continue;const i=s.get(n.taskId);!i||i.isLight||a.push(i.timeBlock)}return Ie(a)}function Es(t,e,s){const a=[];for(const n of e){if(n.participantId!==t)continue;const i=s.get(n.taskId);!i||!i.isLight||a.push(i.timeBlock)}return Ie(a)}function Ms(t){const e=[];for(let s=1;s<t.length;s++){const a=cs(t[s-1],t[s]);e.push(a)}return e}function Rs(t,e,s){const a=Cs(s),n=As(t,e,a),i=Es(t,e,a),l=Ms(n),o=n.reduce((p,f)=>p+(f.end.getTime()-f.start.getTime())/(1e3*60*60),0),r=i.reduce((p,f)=>p+(f.end.getTime()-f.start.getTime())/(1e3*60*60),0),c=l.length>0?Math.min(...l):1/0,d=l.length>0?Math.max(...l):1/0,u=l.length>0?l.reduce((p,f)=>p+f,0)/l.length:1/0;return{participantId:t,restGaps:l,minRestHours:c,maxRestHours:d,avgRestHours:u,totalWorkHours:o,totalLightHours:r,nonLightAssignmentCount:n.length}}function Me(t,e,s){const a=new Map;for(const n of t)a.set(n.id,Rs(n.id,e,s));return a}function Re(t){const e=[];for(const l of t.values())l.restGaps.length>0&&isFinite(l.minRestHours)&&e.push(l.minRestHours);if(e.length===0)return{globalMinRest:1/0,globalAvgRest:1/0,stdDevRest:0};const s=Math.min(...e),a=e.reduce((l,o)=>l+o,0)/e.length,n=e.reduce((l,o)=>l+(o-a)**2,0)/e.length,i=Math.sqrt(n);return{globalMinRest:s,globalAvgRest:a,stdDevRest:i}}function xs(t,e,s){return t.type!==S.Hamama?0:e.level===b.L3?s.hamamaL3Penalty:e.level===b.L4?s.hamamaL4Penalty:0}function Ps(t,e,s){return 0}function Hs(t,e,s){const a=new Map;for(const o of s)a.set(o.id,o);const n=t.map(o=>e.filter(r=>{const c=a.get(r.taskId);return r.participantId===o.id&&c&&!c.isLight}).length);if(n.length===0)return 0;const i=n.reduce((o,r)=>o+r,0)/n.length,l=n.reduce((o,r)=>o+(r-i)**2,0)/n.length;return Math.sqrt(l)*2}function Bs(t,e,s){const a=new Map;for(const l of s)a.set(l.id,l);const n=new Map;for(const l of t){const o=n.get(l.level)||[];o.push(l),n.set(l.level,o)}let i=0;for(const[l,o]of n){if(o.length<=1)continue;const r=o.map(u=>{let p=0;for(const f of e){if(f.participantId!==u.id)continue;const m=a.get(f.taskId);!m||m.isLight||(p+=(m.timeBlock.end.getTime()-m.timeBlock.start.getTime())/36e5)}return p}),c=r.reduce((u,p)=>u+p,0)/r.length;if(c===0)continue;const d=r.reduce((u,p)=>u+(p-c)**2,0)/r.length;i+=Math.sqrt(d)}return i}function qs(t,e,s,a){const n=new Map;for(const l of s)n.set(l.id,l);let i=0;for(const l of t){if(l.level===b.L1)continue;const o=[];for(const r of e){if(r.participantId!==l.id)continue;const c=n.get(r.taskId);c&&!c.isLight&&o.push(c)}if(!(o.length<2)){o.sort((r,c)=>r.timeBlock.start.getTime()-c.timeBlock.start.getTime());for(let r=0;r<o.length-1;r++)o[r+1].timeBlock.start.getTime()-o[r].timeBlock.end.getTime()<=0&&(i+=a)}}return i}function It(t,e,s){const a=[],n=new Map;for(const o of e)n.set(o.id,o);const i=new Map;for(const o of t)i.set(o.id,o);for(const o of t){const c=s.filter(d=>d.taskId===o.id).map(d=>n.get(d.participantId)).filter(d=>!!d);if(o.type===S.Hamama)for(const d of c)d.level===b.L3&&a.push({severity:x.Warning,code:"HAMAMA_L3",message:`${d.name} (L3) assigned to Hamama — high penalty. Prefer L0.`,taskId:o.id,participantId:d.id})}const l=new Map;for(const o of t)l.set(o.id,o);for(const o of e){if(o.level===b.L1)continue;const r=[];for(const c of s){if(c.participantId!==o.id)continue;const d=l.get(c.taskId);d&&!d.isLight&&r.push(d)}if(!(r.length<2)){r.sort((c,d)=>c.timeBlock.start.getTime()-d.timeBlock.start.getTime());for(let c=0;c<r.length-1;c++)r[c+1].timeBlock.start.getTime()-r[c].timeBlock.end.getTime()<=0&&a.push({severity:x.Warning,code:"BACK_TO_BACK",message:`${o.name} has back-to-back shifts: "${r[c].name}" ends at ${r[c].timeBlock.end.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} and "${r[c+1].name}" starts immediately.`,taskId:r[c+1].id,participantId:o.id})}}return a}function Nt(t,e,s,a){const n=Me(e,s,t),i=Re(n);let l=0,o=0;const r=new Map;for(const f of e)r.set(f.id,f);for(const f of t){const g=s.filter(h=>h.taskId===f.id).map(h=>r.get(h.participantId)).filter(h=>!!h);for(const h of g)l+=xs(f,h,a);o+=Ps()}l+=Hs(e,s,t),l+=Bs(e,s,t),l+=qs(e,s,t,a.backToBackPenalty);const c=isFinite(i.globalMinRest)?i.globalMinRest:0,d=isFinite(i.globalAvgRest)?i.globalAvgRest:0,u=i.stdDevRest,p=a.minRestWeight*c-a.fairnessWeight*u-a.penaltyWeight*l+a.bonusWeight*o;return{minRestHours:c,avgRestHours:d,restStdDev:u,totalPenalty:l,totalBonus:o,compositeScore:p}}const Jt=[S.Shemesh,S.Aruga,S.Hamama];function Ot(t,e){const s=t.get(e.participantId);s?s.push(e):t.set(e.participantId,[e])}function Ns(t){const e=new Map;for(const s of t)Ot(e,s);return e}let xe=0;function Pe(){return`asgn-${++xe}`}function Os(){xe=0}let W=!1;function Fs(t){W=t!==void 0?t:!W,console.log(`[Scheduler] Diagnostic logging: ${W?"ON":"OFF"}`)}typeof globalThis<"u"&&(globalThis.toggleSchedulerDiag=Fs);function _s(t,e,s,a,n,i){const l=`${t.name} → ${e.name} [${s.label||s.slotId}]`;if(t.level===b.L4&&Jt.includes(e.type))return W&&console.log(`[Elig] REJECT L4-forbidden: ${l} — L4 cannot serve ${e.type}`),!1;if(!(s.acceptableLevels.includes(t.level)||t.level>Math.max(...s.acceptableLevels)))return W&&console.log(`[Elig] REJECT level: ${l} — L${t.level} not in [${s.acceptableLevels.map(c=>"L"+c)}]`),!1;for(const c of s.requiredCertifications)if(!t.certifications.includes(c))return W&&console.log(`[Elig] REJECT cert: ${l} — missing ${c}`),!1;if(!Bt(e.timeBlock,t.availability))return W&&console.log(`[Elig] REJECT avail: ${l}`),!1;for(const c of a){const d=n.get(c.taskId);if(d&&rt(e.timeBlock,d.timeBlock))return W&&console.log(`[Elig] REJECT double-book: ${l} — overlaps ${d.name}`),!1}if(a.some(c=>c.taskId===e.id))return W&&console.log(`[Elig] REJECT already-in-task: ${l}`),!1;if(t.level===b.L1&&i){const c=i.get(t.id);if(c)if(e.type===S.Adanit){if(!ee(e.timeBlock,c))return W&&console.log(`[Elig] REJECT L1-cycle-misalign: ${l}`),!1;if(!se(e.timeBlock.start,a,n))return W&&console.log(`[Elig] REJECT L1-pre-gap: ${l} — no 8h free window before Adanit`),!1}else{for(const u of c)if((u.phase==="Rest8"||u.phase==="Rest16")&&rt(e.timeBlock,{start:u.start,end:u.end}))return W&&console.log(`[Elig] REJECT L1-absolute-rest: ${l} — ${u.phase}`),!1;const d=ms(c,e.timeBlock.start);if(d){const u=new Date(d.getTime()-qt*36e5);if(e.timeBlock.end.getTime()>u.getTime()&&e.timeBlock.start.getTime()<d.getTime())return W&&console.log(`[Elig] REJECT L1-adanit-pregap-protect: ${l} — would intrude on pre-gap before ${d.toISOString()}`),!1}}}return!0}function He(t,e,s,a,n,i,l){const o=s.filter(r=>_s(r,t,e,a.get(r.id)||[],n,l));return o.sort((r,c)=>{if(t.type===S.Adanit){const h=e.acceptableLevels.includes(r.level)?0:1,v=e.acceptableLevels.includes(c.level)?0:1;if(h!==v)return h-v;const k=i.get(r.id)||0,y=i.get(c.id)||0;return k!==y?k-y:r.level!==c.level?r.level-c.level:Math.random()-.5}const d=r.level===b.L1?1:0,u=c.level===b.L1?1:0;if(d!==u)return d-u;if(t.type===S.Hamama){const h=k=>k===b.L0?0:k===b.L1?1:k===b.L3?2:3,v=h(r.level)-h(c.level);if(v!==0)return v}const p=i.get(r.id)||0,f=i.get(c.id)||0;if(p!==f)return p-f;const m=e.acceptableLevels.includes(r.level)?0:1,g=e.acceptableLevels.includes(c.level)?0:1;return m!==g?m-g:r.level!==c.level?r.level-c.level:Math.random()-.5}),o}function Gs(t){const e={[S.Adanit]:0,[S.Hamama]:1,[S.Karov]:2,[S.Mamtera]:3,[S.Shemesh]:4,[S.Aruga]:5,[S.Karovit]:6};return[...t].sort((s,a)=>{const n=e[s.type]??99,i=e[a.type]??99;if(n!==i)return n-i;const l=s.timeBlock.start.getTime(),o=a.timeBlock.start.getTime();return l!==o?l-o:Math.random()-.5})}function Ws(t,e,s=[],a){const n=new Map;for(const m of t)n.set(m.id,m);const i=[...s],l=[],o=Ns(s),r=new Map;for(const m of e)r.set(m.id,0);for(const m of s){const g=n.get(m.taskId);g&&!g.isLight&&r.set(m.participantId,(r.get(m.participantId)||0)+1)}const c=Gs(t);for(const m of c){if(m.sameGroupRequired){if(!zs(m,e,i,n,r,o,a)){for(const v of m.slots)if(!i.some(y=>y.taskId===m.id&&y.slotId===v.slotId)){const y=v.acceptableLevels.map(M=>"L"+M).join("/"),$=v.requiredCertifications.length>0?` with ${v.requiredCertifications.join(", ")} cert`:"",A=`No group can fill all ${m.name} slots. Missing ${y}${$} for ${m.name}`;l.push({taskId:m.id,slotId:v.slotId,reason:A})}}continue}const g=[...m.slots].sort((h,v)=>Math.min(...v.acceptableLevels)-Math.min(...h.acceptableLevels));for(const h of g){if(i.find(y=>y.taskId===m.id&&y.slotId===h.slotId))continue;const k=He(m,h,e,o,n,r,a);if(k.length>0){const y=k[0],$={id:Pe(),taskId:m.id,slotId:h.slotId,participantId:y.id,status:P.Scheduled,updatedAt:new Date};i.push($),Ot(o,$),m.isLight||r.set(y.id,(r.get(y.id)||0)+1)}else{const y=h.acceptableLevels.map(M=>"L"+M).join("/"),$=h.requiredCertifications.length>0?` with ${h.requiredCertifications.join(", ")} cert`:"",A=`Missing ${y}${$} for ${m.name}`;l.push({taskId:m.id,slotId:h.slotId,reason:A})}}}const d=t.reduce((m,g)=>m+g.slots.length,0),u=i.length-s.length,p=new Set(i.map(m=>m.participantId)),f=e.length-p.size;if(console.log(`[Scheduler] Greedy done: ${u}/${d} slots filled, ${l.length} unfilled, ${f}/${e.length} participants idle`),l.length>0){const m=new Map;for(const g of l){const h=n.get(g.taskId),v=h?h.name:g.taskId;m.set(v,(m.get(v)||0)+1)}for(const[g,h]of m)console.warn(`  ↳ ${g}: ${h} unfilled slot(s)`)}return{assignments:i,unfilledSlots:l}}function zs(t,e,s,a,n,i,l){const o=s.filter(g=>g.taskId===t.id),r=new Set(o.map(g=>g.slotId));let c;if(o.length>0){const g=new Set;for(const h of o){const v=e.find(k=>k.id===h.participantId);v&&g.add(v.group)}g.size===1&&(c=[...g][0])}const d=[...new Set(e.map(g=>g.group))],u=c?[c]:d;u.sort((g,h)=>{const v=e.filter(y=>y.group===g).reduce((y,$)=>y+(n.get($.id)||0),0),k=e.filter(y=>y.group===h).reduce((y,$)=>y+(n.get($.id)||0),0);return v!==k?v-k:Math.random()-.5});const p=t.slots.filter(g=>!r.has(g.slotId)).sort((g,h)=>Math.min(...h.acceptableLevels)-Math.min(...g.acceptableLevels));let f=[],m=0;for(const g of u){const h=e.filter(y=>y.group===g),v=[],k=new Map;for(const[y,$]of i)k.set(y,[...$]);for(const y of p){const $=He(t,y,h,k,a,n,l);if($.length>0){const A={id:Pe(),taskId:t.id,slotId:y.slotId,participantId:$[0].id,status:P.Scheduled,updatedAt:new Date};v.push(A),Ot(k,A)}}if(v.length===p.length){for(const y of v){s.push(y),Ot(i,y);const $=a.get(y.taskId);$&&!$.isLight&&n.set(y.participantId,(n.get(y.participantId)||0)+1)}return!0}v.length>m&&(m=v.length,f=v)}return f.length>0&&console.warn(`[Scheduler] ${t.name}: no group could fill all ${p.length} slots. Best group filled ${m}/${p.length}. Leaving ALL unfilled (strict same-group rule).`),!1}function Us(t,e,s,a,n,i,l){const o=t[e],r=t[s],c=n.get(o.participantId),d=n.get(r.participantId),u=a.get(o.taskId),p=a.get(r.taskId);if(!c||!d||!u||!p)return!1;const f=u.slots.find(v=>v.slotId===o.slotId),m=p.slots.find(v=>v.slotId===r.slotId);if(!f||!m)return!1;const g=(v,k)=>k.acceptableLevels.includes(v.level)||v.level>Math.max(...k.acceptableLevels);if(!g(c,f)||!g(d,m))return!1;for(const v of f.requiredCertifications)if(!c.certifications.includes(v))return!1;for(const v of m.requiredCertifications)if(!d.certifications.includes(v))return!1;if(!Bt(u.timeBlock,c.availability)||!Bt(p.timeBlock,d.availability)||c.level===b.L4&&Jt.includes(u.type)||d.level===b.L4&&Jt.includes(p.type))return!1;for(const v of t)if(v!==o&&v.taskId===o.taskId&&v.participantId===o.participantId)return!1;for(const v of t)if(v!==r&&v.taskId===r.taskId&&v.participantId===r.participantId)return!1;if(u.sameGroupRequired){const v=new Set;for(const k of t){if(k.taskId!==u.id)continue;const y=n.get(k.participantId);y&&v.add(y.group)}if(v.size>1)return!1}if(p.sameGroupRequired&&p.id!==u.id){const v=new Set;for(const k of t){if(k.taskId!==p.id)continue;const y=n.get(k.participantId);y&&v.add(y.group)}if(v.size>1)return!1}const h=v=>{const k=t.filter(y=>y.participantId===v);for(let y=0;y<k.length;y++)for(let $=y+1;$<k.length;$++){const A=a.get(k[y].taskId),M=a.get(k[$].taskId);if(A&&M&&rt(A.timeBlock,M.timeBlock))return!1}return!0};if(!h(c.id)||!h(d.id))return!1;if(i&&l)for(const v of[c,d]){if(v.level!==b.L1)continue;const k=i.get(v.id);if(!k)continue;const y=dt(k,l),$=t.filter(A=>A.participantId===v.id);for(const A of $){const M=a.get(A.taskId);if(M){if(M.type===S.Adanit){if(!ee(M.timeBlock,y))return!1;const q=$.filter(F=>F.id!==A.id);if(!se(M.timeBlock.start,q,a))return!1}else for(const q of y)if((q.phase===D.Rest8||q.phase===D.Rest16)&&rt(M.timeBlock,{start:q.start,end:q.end}))return!1}}}return!0}function js(t,e,s,a,n,i){let l=[...s.map(h=>({...h}))],o=Nt(t,e,l,a),r=l,c=o;const d=new Map;for(const h of t)d.set(h.id,h);const u=new Map;for(const h of e)u.set(h.id,h);const p=Date.now();let f=0;const m=55,g=a.maxIterations;for(;f<g&&!(Date.now()-p>a.maxSolverTimeMs);){const h=m*(1-f/g),v=Array.from({length:l.length},(y,$)=>$);for(let y=v.length-1;y>0;y--){const $=Math.floor(Math.random()*(y+1));[v[y],v[$]]=[v[$],v[y]]}let k=!1;for(let y=0;y<v.length&&!k;y++){const $=v[y];for(let A=y+1;A<v.length&&!k;A++){const M=v[A];if(f++,f>g||Date.now()-p>a.maxSolverTimeMs)break;const q=l[$],F=l[M];if(q.status===P.Locked||q.status===P.Manual||F.status===P.Locked||F.status===P.Manual||q.participantId===F.participantId)continue;const X=l.map(Ze=>({...Ze}));if(X[$]={...X[$],participantId:F.participantId,updatedAt:new Date},X[M]={...X[M],participantId:q.participantId,updatedAt:new Date},!Us(X,$,M,d,u,n,i))continue;const ge=Nt(t,e,X,a),he=ge.compositeScore-o.compositeScore;(he>0||h>.01&&Math.random()<Math.exp(he/h))&&(l=X,o=ge,k=!0,o.compositeScore>c.compositeScore&&(r=l,c=o))}}if(!k)break}return r}function Xt(t,e,s,a=[]){const n=Date.now(),i=[...t].sort((g,h)=>g.timeBlock.start.getTime()-h.timeBlock.start.getTime()),l=i.length>0?i[0].timeBlock.start:new Date,o=i.length>0?i[i.length-1].timeBlock.end:new Date,r=e.filter(g=>g.level===b.L1),c=r.length>0?fs(r,l):new Map,d=new Map;for(const[g,h]of c)d.set(g,dt(h,o));const u=Ws(t,e,a,d),p=js(t,e,u.assignments,s,c,o),f=mt(t,e,p,c,o),m=Nt(t,e,p,s);return{assignments:p,score:m,feasible:f.valid&&u.unfilledSlots.length===0,unfilledSlots:u.unfilledSlots,iterations:0,durationMs:Date.now()-n,l1CycleStates:c.size>0?c:void 0}}function Ks(t){for(let e=t.length-1;e>0;e--){const s=Math.floor(Math.random()*(e+1));[t[e],t[s]]=[t[s],t[e]]}return t}function Ys(t,e){const s=t.unfilledSlots.length,a=e.unfilledSlots.length;return s<a?!0:s>a?!1:t.score.compositeScore>e.score.compositeScore}const Vs=4;function Js(t,e,s,a=[],n=40,i){return new Promise(l=>{let o=null,r=0;const c=Date.now(),d=[];function u(){const p=Math.min(r+Vs,n);for(;r<p;){const f=r===0?[...e]:Ks([...e]),m=Xt(t,f,s,a),g=o===null||Ys(m,o);g&&(o=m),r++,d.push({"#":r,score:m.score.compositeScore.toFixed(4),unfilled:m.unfilledSlots.length,stdDev:m.score.restStdDev.toFixed(4),penalty:m.score.totalPenalty.toFixed(2),bonus:m.score.totalBonus.toFixed(2),improved:g?"★ YES":""}),i&&i({attempt:r,totalAttempts:n,currentBestScore:o.score.compositeScore,currentBestFeasible:o.feasible,currentBestUnfilled:o.unfilledSlots.length,attemptScore:m.score.compositeScore,attemptFeasible:m.feasible,improved:g})}r<n?setTimeout(u,0):(o.durationMs=Date.now()-c,console.log(`[Scheduler] Multi-attempt async done: ${n} attempts in ${o.durationMs}ms. Best score: ${o.score.compositeScore.toFixed(2)}, unfilled: ${o.unfilledSlots.length}, restStdDev: ${o.score.restStdDev.toFixed(2)}`),console.table(d),l(o))}u()})}class Xs{constructor(e={}){this.participants=new Map,this.tasks=new Map,this.currentSchedule=null,this.l1CycleStates=new Map,this.weekEnd=new Date,this.config={...Qe,...e}}addParticipant(e){this.participants.set(e.id,e)}addParticipants(e){for(const s of e)this.addParticipant(s)}removeParticipant(e){return this.participants.delete(e)}getParticipant(e){return this.participants.get(e)}getAllParticipants(){return[...this.participants.values()]}addTask(e){this.tasks.set(e.id,e)}addTasks(e){for(const s of e)this.addTask(s)}removeTask(e){return this.tasks.delete(e)}getTask(e){return this.tasks.get(e)}getAllTasks(){return[...this.tasks.values()]}reset(){this.participants.clear(),this.tasks.clear(),this.currentSchedule=null,Os()}generateSchedule(){const e=this.getAllTasks(),s=this.getAllParticipants();if(e.length===0)throw new Error("No tasks registered. Add tasks before generating a schedule.");if(s.length===0)throw new Error("No participants registered. Add participants before generating a schedule.");const a=Xt(e,s,this.config);a.l1CycleStates&&(this.l1CycleStates=a.l1CycleStates);const n=[...e].sort((c,d)=>d.timeBlock.end.getTime()-c.timeBlock.end.getTime());this.weekEnd=n.length>0?n[0].timeBlock.end:new Date;const i=mt(e,s,a.assignments,this.l1CycleStates.size>0?this.l1CycleStates:void 0,this.weekEnd),l=It(e,s,a.assignments),o=[...i.violations,...l];for(const{taskId:c,slotId:d,reason:u}of a.unfilledSlots){const p=this.tasks.get(c),f=p?.slots.find(m=>m.slotId===d);o.push({severity:x.Error,code:"INFEASIBLE_SLOT",message:u?`Infeasible: ${u} (slot "${f?.label??d}" in "${p?.name??c}")`:`Infeasible Schedule: Cannot fill slot "${f?.label??d}" in task "${p?.name??c}". No eligible participants available.`,taskId:c,slotId:d})}const r={id:`schedule-${Date.now()}`,tasks:e,participants:s,assignments:a.assignments,feasible:a.feasible,score:a.score,violations:o,generatedAt:new Date};return this.currentSchedule=r,r}async generateScheduleAsync(e=40,s){const a=this.getAllTasks(),n=this.getAllParticipants();if(a.length===0)throw new Error("No tasks registered. Add tasks before generating a schedule.");if(n.length===0)throw new Error("No participants registered. Add participants before generating a schedule.");const i=await Js(a,n,this.config,[],e,s);i.l1CycleStates&&(this.l1CycleStates=i.l1CycleStates);const l=[...a].sort((u,p)=>p.timeBlock.end.getTime()-u.timeBlock.end.getTime());this.weekEnd=l.length>0?l[0].timeBlock.end:new Date;const o=mt(a,n,i.assignments,this.l1CycleStates.size>0?this.l1CycleStates:void 0,this.weekEnd),r=It(a,n,i.assignments),c=[...o.violations,...r];for(const{taskId:u,slotId:p,reason:f}of i.unfilledSlots){const m=this.tasks.get(u),g=m?.slots.find(h=>h.slotId===p);c.push({severity:x.Error,code:"INFEASIBLE_SLOT",message:f?`Infeasible: ${f} (slot "${g?.label??p}" in "${m?.name??u}")`:`Infeasible Schedule: Cannot fill slot "${g?.label??p}" in task "${m?.name??u}". No eligible participants available.`,taskId:u,slotId:p})}const d={id:`schedule-${Date.now()}`,tasks:a,participants:n,assignments:i.assignments,feasible:i.feasible,score:i.score,violations:c,generatedAt:new Date};return this.currentSchedule=d,d}getSchedule(){return this.currentSchedule}getL1CycleStates(){return this.l1CycleStates}getWeekEnd(){return this.weekEnd}validate(){return this.currentSchedule?mt(this.currentSchedule.tasks,this.currentSchedule.participants,this.currentSchedule.assignments,this.l1CycleStates.size>0?this.l1CycleStates:void 0,this.weekEnd):{valid:!1,violations:[{severity:x.Error,code:"NO_SCHEDULE",message:"No schedule has been generated yet.",taskId:""}]}}swapParticipant(e){if(!this.currentSchedule)return{valid:!1,violations:[{severity:x.Error,code:"NO_SCHEDULE",message:"No schedule exists to modify.",taskId:""}]};const s=this.currentSchedule.assignments.find(i=>i.id===e.assignmentId);if(!s)return{valid:!1,violations:[{severity:x.Error,code:"ASSIGNMENT_NOT_FOUND",message:`Assignment ${e.assignmentId} not found.`,taskId:""}]};if(!this.participants.get(e.newParticipantId))return{valid:!1,violations:[{severity:x.Error,code:"PARTICIPANT_NOT_FOUND",message:`Participant ${e.newParticipantId} not found.`,taskId:s.taskId}]};s.participantId=e.newParticipantId,s.status=P.Manual,s.updatedAt=new Date;const n=this.validate();return this.currentSchedule.score=Nt(this.currentSchedule.tasks,this.currentSchedule.participants,this.currentSchedule.assignments,this.config),this.currentSchedule.feasible=n.valid,this.currentSchedule.violations=[...n.violations,...It(this.currentSchedule.tasks,this.currentSchedule.participants,this.currentSchedule.assignments)],n}partialReSchedule(e){if(!this.currentSchedule)throw new Error("No schedule exists to partially re-schedule.");const{lockedAssignmentIds:s,unavailableParticipantIds:a}=e,n=new Set(a),i=[];for(const u of this.currentSchedule.assignments)s.includes(u.id)?n.has(u.participantId)||i.push({...u,status:P.Locked}):n.has(u.participantId)||i.push({...u,status:P.Locked});const l=this.getAllParticipants().filter(u=>!n.has(u.id)),o=Xt(this.currentSchedule.tasks,l,this.config,i),r=mt(this.currentSchedule.tasks,this.getAllParticipants(),o.assignments),c=It(this.currentSchedule.tasks,this.getAllParticipants(),o.assignments),d={id:`schedule-${Date.now()}`,tasks:this.currentSchedule.tasks,participants:this.getAllParticipants(),assignments:o.assignments,feasible:o.feasible,score:o.score,violations:[...r.violations,...c],generatedAt:new Date};return this.currentSchedule=d,d}lockAssignment(e){if(!this.currentSchedule)return!1;const s=this.currentSchedule.assignments.find(a=>a.id===e);return s?(s.status=P.Locked,s.updatedAt=new Date,!0):!1}unlockAssignment(e){if(!this.currentSchedule)return!1;const s=this.currentSchedule.assignments.find(a=>a.id===e);return s?(s.status=P.Scheduled,s.updatedAt=new Date,!0):!1}getStats(){const e=this.currentSchedule;return{totalTasks:this.tasks.size,totalParticipants:this.participants.size,totalAssignments:e?.assignments.length??0,feasible:e?.feasible??!1,hardViolations:e?.violations.filter(s=>s.severity===x.Error).length??0,softWarnings:e?.violations.filter(s=>s.severity===x.Warning).length??0,score:e?.score??null}}}const Zs={[S.Adanit]:"#4A90D9",[S.Hamama]:"#E74C3C",[S.Shemesh]:"#F39C12",[S.Mamtera]:"#27AE60",[S.Karov]:"#8E44AD",[S.Karovit]:"#BDC3C7",[S.Aruga]:"#1ABC9C"},Qs={[P.Scheduled]:1,[P.Locked]:.9,[P.Manual]:1,[P.Conflict]:.5};function ta(t,e){const s=Zs[t]||"#95A5A6",a=Qs[e]||1;if(a===1)return s;const n=s.replace("#",""),i=parseInt(n.substring(0,2),16),l=parseInt(n.substring(2,4),16),o=parseInt(n.substring(4,6),16);return`rgba(${i}, ${l}, ${o}, ${a})`}function ea(t){const{tasks:e,participants:s,assignments:a}=t,n=new Map;for(const g of e)n.set(g.id,g);const i=new Map;for(const g of s)i.set(g.id,g);const l=new Map;for(const g of s)l.set(g.id,{participantId:g.id,participantName:g.name,group:g.group,level:g.level,blocks:[]});for(const g of a){const h=n.get(g.taskId);if(!h)continue;const v=l.get(g.participantId);if(!v)continue;const k={assignmentId:g.id,taskId:h.id,taskType:h.type,taskName:h.name,startMs:h.timeBlock.start.getTime(),endMs:h.timeBlock.end.getTime(),durationMs:h.timeBlock.end.getTime()-h.timeBlock.start.getTime(),status:g.status,isLight:h.isLight,color:ta(h.type,g.status)};v.blocks.push(k)}for(const g of l.values())g.blocks.sort((h,v)=>h.startMs-v.startMs);const o=e.map(g=>g.timeBlock),r=ds(o),c=r?.start.getTime()??0,d=r?.end.getTime()??0,u=d-c,f=u>0?u/(1e3*60)/1200:1,m=[...l.values()];return m.sort((g,h)=>g.group!==h.group?g.group.localeCompare(h.group):g.participantName.localeCompare(h.participantName)),{rows:m,timelineStartMs:c,timelineEndMs:d,scaleMinPerPx:f}}let sa=0;function T(t){return`${t}-${++sa}-${Date.now().toString(36)}`}const Zt=new Set;function aa(t){return Zt.add(t),()=>Zt.delete(t)}function R(){for(const t of Zt)try{t()}catch{}}const na=80,Z=[],at=[];let Lt=!1;function ae(){const t=[];for(const[s,a]of E){const n=typeof structuredClone=="function"?structuredClone(a):{...a,certifications:[...a.certifications],availability:a.availability.map(o=>({start:new Date(o.start.getTime()),end:new Date(o.end.getTime())})),dateUnavailability:[...a.dateUnavailability||[]].map(o=>({...o}))},i=V.get(s)||[],l=z.get(s)||[];t.push({p:n,blackouts:typeof structuredClone=="function"?structuredClone(i):i.map(o=>({...o,start:new Date(o.start.getTime()),end:new Date(o.end.getTime())})),dateUnavails:typeof structuredClone=="function"?structuredClone(l):l.map(o=>({...o}))})}const e=typeof structuredClone=="function"?structuredClone([...H.values()]):[...H.values()].map(s=>({...s,slots:s.slots.map(a=>({...a,acceptableLevels:[...a.acceptableLevels],requiredCertifications:[...a.requiredCertifications]})),subTeams:s.subTeams.map(a=>({...a,slots:a.slots.map(n=>({...n,acceptableLevels:[...n.acceptableLevels],requiredCertifications:[...n.requiredCertifications]}))}))}));return{participants:t,taskTemplates:e}}function Be(t){E.clear(),V.clear(),z.clear();const e=typeof structuredClone=="function";for(const s of t.participants){const a=e?structuredClone(s.p):{...s.p,certifications:[...s.p.certifications],availability:s.p.availability.map(n=>({start:new Date(n.start.getTime()),end:new Date(n.end.getTime())})),dateUnavailability:(s.dateUnavails||[]).map(n=>({...n}))};e||(a.dateUnavailability=(s.dateUnavails||[]).map(n=>({...n}))),E.set(a.id,a),s.blackouts.length>0&&V.set(a.id,e?structuredClone(s.blackouts):s.blackouts.map(n=>({...n,start:new Date(n.start.getTime()),end:new Date(n.end.getTime())}))),s.dateUnavails&&s.dateUnavails.length>0&&z.set(a.id,e?structuredClone(s.dateUnavails):s.dateUnavails.map(n=>({...n})))}if(H.clear(),e)for(const s of t.taskTemplates)H.set(s.id,structuredClone(s));else for(const s of t.taskTemplates)H.set(s.id,{...s,slots:s.slots.map(a=>({...a,acceptableLevels:[...a.acceptableLevels],requiredCertifications:[...a.requiredCertifications]})),subTeams:s.subTeams.map(a=>({...a,slots:a.slots.map(n=>({...n,acceptableLevels:[...n.acceptableLevels],requiredCertifications:[...n.requiredCertifications]}))}))})}function B(){Lt||(Z.push(ae()),Z.length>na&&Z.shift(),at.length=0)}function ia(){if(Z.length===0)return!1;at.push(ae());const t=Z.pop();return Be(t),R(),!0}function oa(){if(at.length===0)return!1;Z.push(ae());const t=at.pop();return Be(t),R(),!0}function it(){return{canUndo:Z.length>0,canRedo:at.length>0,undoDepth:Z.length,redoDepth:at.length}}const E=new Map,V=new Map,z=new Map;let ne=new Date(2026,1,15),ie=7;function ut(){return ne}function U(){return ie}function oe(){const t=ne;return[{start:new Date(t.getFullYear(),t.getMonth(),t.getDate(),0,0),end:new Date(t.getFullYear(),t.getMonth(),t.getDate()+ie,12,0)}]}function pt(t){const e=oe(),s=V.get(t)||[],a=z.get(t)||[],n=s.map(o=>({start:o.start,end:o.end})),i=ne;for(const o of a)for(let r=0;r<ie;r++){const c=new Date(i.getFullYear(),i.getMonth(),i.getDate()+r);let d=!1;if(o.specificDate?`${c.getFullYear()}-${String(c.getMonth()+1).padStart(2,"0")}-${String(c.getDate()).padStart(2,"0")}`===o.specificDate&&(d=!0):o.dayOfWeek!==void 0&&c.getDay()===o.dayOfWeek&&(d=!0),d)if(o.allDay)n.push({start:new Date(c.getFullYear(),c.getMonth(),c.getDate(),0,0),end:new Date(c.getFullYear(),c.getMonth(),c.getDate()+1,0,0)});else{let u=o.endHour,p=c.getDate();u<=o.startHour&&(p+=1),n.push({start:new Date(c.getFullYear(),c.getMonth(),c.getDate(),o.startHour,0),end:new Date(c.getFullYear(),c.getMonth(),p,u,0)})}}if(n.length===0)return e;let l=[...e];for(const o of n){const r=[];for(const c of l)o.end<=c.start||o.start>=c.end?r.push(c):(o.start>c.start&&r.push({start:c.start,end:o.start}),o.end<c.end&&r.push({start:o.end,end:c.end}));l=r}return l}function la(t){B();const e=T("p"),s={id:e,name:t.name,level:t.level??b.L0,certifications:t.certifications??[w.Nitzan],group:t.group,availability:oe(),dateUnavailability:[]};return E.set(e,s),R(),s}function ra(t,e){const s=E.get(t);s&&(B(),Object.assign(s,e),s.availability=pt(t),R())}function ca(t){E.has(t)&&(B(),E.delete(t),V.delete(t),z.delete(t),R())}function da(t){const e=new Set(t),s=[];for(const a of e)E.has(a)&&s.push(a);if(s.length===0)return 0;B();for(const a of s)E.delete(a),V.delete(a),z.delete(a);return R(),s.length}function ua(t){return E.get(t)}function Dt(){return[...E.values()]}function wt(){const t=new Set;for(const e of E.values())t.add(e.group);return[...t].sort()}function pa(t,e,s,a){if(!E.has(t))return null;B();const n={id:T("bo"),start:e,end:s,reason:a},i=V.get(t)||[];i.push(n),V.set(t,i);const l=E.get(t);return l.availability=pt(t),R(),n}function fa(t,e){const s=V.get(t);if(!s)return;const a=s.findIndex(i=>i.id===e);if(a<0)return;B(),s.splice(a,1);const n=E.get(t);n&&(n.availability=pt(t)),R()}function qe(t){return V.get(t)||[]}function be(t,e){if(!E.has(t))return null;B();const s={...e,id:T("du")},a=z.get(t)||[];a.push(s),z.set(t,a);const n=E.get(t);return n.dateUnavailability=a,n.availability=pt(t),R(),s}function ma(t,e){const s=z.get(t);if(!s)return;const a=s.findIndex(i=>i.id===e);if(a<0)return;B(),s.splice(a,1);const n=E.get(t);n&&(n.dateUnavailability=s,n.availability=pt(t)),R()}function le(t){return z.get(t)||[]}function ga(t,e){const s=t.filter(n=>E.has(n));if(s.length===0)return 0;B(),Lt=!0;let a=0;try{for(const n of s){const i={...e,id:T("du")},l=z.get(n)||[];l.push(i),z.set(n,l);const o=E.get(n);o.dateUnavailability=l,o.availability=pt(n),a++}}finally{Lt=!1}return R(),a}const H=new Map;function Q(t){B();const e=T("tpl"),s={...t,id:e};return H.set(e,s),R(),s}function ha(t,e){const s=H.get(t);s&&(B(),Object.assign(s,e),R())}function va(t){H.has(t)&&(B(),H.delete(t),R())}function ba(t){return H.get(t)}function zt(){return[...H.values()]}function ya(t,e){const s=H.get(t);s&&(B(),s.slots.push({...e,id:T("slot")}),R())}function ka(t,e){const s=H.get(t);s&&(B(),s.slots=s.slots.filter(a=>a.id!==e),R())}function $a(t,e){const s=H.get(t),a={id:T("st"),name:e,slots:[]};return s&&(B(),s.subTeams.push(a),R()),a}function Sa(t,e){const s=H.get(t);s&&(B(),s.subTeams=s.subTeams.filter(a=>a.id!==e),R())}function La(t,e,s){const a=H.get(t);if(!a)return;const n=a.subTeams.find(i=>i.id===e);n&&(B(),n.slots.push({...s,id:T("slot")}),R())}function wa(t,e,s){const a=H.get(t);if(!a)return;const n=a.subTeams.find(i=>i.id===e);n&&(B(),n.slots=n.slots.filter(i=>i.id!==s),R())}function Ta(){const t=["Dept A","Dept B","Dept C","Dept D"],e=[{level:b.L4,certs:[w.Nitzan],tag:"L4"},{level:b.L3,certs:[w.Nitzan],tag:"L3"},{level:b.L2,certs:[w.Nitzan],tag:"L2"},{level:b.L2,certs:[w.Nitzan],tag:"L2"},{level:b.L2,certs:[w.Nitzan],tag:"L2"},{level:b.L1,certs:[w.Nitzan],tag:"L1"},{level:b.L1,certs:[w.Nitzan],tag:"L1"},{level:b.L1,certs:[w.Nitzan],tag:"L1"},{level:b.L0,certs:[w.Nitzan,w.Salsala],tag:"L0-Salsala"},{level:b.L0,certs:[w.Nitzan,w.Hamama],tag:"L0-Hamama"},{level:b.L0,certs:[w.Nitzan,w.Hamama],tag:"L0-Hamama"},{level:b.L0,certs:[w.Nitzan],tag:"L0"},{level:b.L0,certs:[w.Nitzan],tag:"L0"},{level:b.L0,certs:[w.Nitzan],tag:"L0"},{level:b.L0,certs:[w.Nitzan],tag:"L0"}];for(const s of t)e.forEach((a,n)=>{const i=T("p"),l=String(n+1).padStart(2,"0"),o={id:i,name:`${s} - Participant ${l}`,level:a.level,certifications:[...a.certs],group:s,availability:oe(),dateUnavailability:[]};E.set(i,o)});R()}function Da(){Q({name:"Adanit",taskType:S.Adanit,durationHours:8,shiftsPerDay:3,startHour:5,sameGroupRequired:!0,isLight:!1,subTeams:[{id:T("st"),name:"Segol Main",slots:[{id:T("slot"),label:"Segol Main L0 #1",acceptableLevels:[b.L0],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Segol Main L0 #2",acceptableLevels:[b.L0],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Segol Main L1",acceptableLevels:[b.L1],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Segol Main L3/L4",acceptableLevels:[b.L3,b.L4],requiredCertifications:[w.Nitzan]}]},{id:T("st"),name:"Segol Secondary",slots:[{id:T("slot"),label:"Segol Secondary L0 #1",acceptableLevels:[b.L0],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Segol Secondary L0 #2",acceptableLevels:[b.L0],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Segol Secondary L1",acceptableLevels:[b.L1],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Segol Secondary L2+",acceptableLevels:[b.L2,b.L3,b.L4],requiredCertifications:[w.Nitzan]}]}],slots:[],description:"8h shifts (05:00 cycle), 3/day. Two sub-teams. All 8 must have Nitzan. Same group."}),Q({name:"Hamama",taskType:S.Hamama,durationHours:12,shiftsPerDay:2,startHour:6,sameGroupRequired:!1,isLight:!1,subTeams:[],slots:[{id:T("slot"),label:"Hamama Operator",acceptableLevels:[b.L0,b.L3],requiredCertifications:[w.Hamama]}],description:"12h shifts (06:00-18:00, 18:00-06:00). Requires Hamama cert. L1/L2 forbidden. No Nitzan req."}),Q({name:"Shemesh",taskType:S.Shemesh,durationHours:4,shiftsPerDay:6,startHour:5,sameGroupRequired:!1,isLight:!1,subTeams:[],slots:[{id:T("slot"),label:"Shemesh #1",acceptableLevels:[b.L0,b.L1,b.L2,b.L3],requiredCertifications:[w.Nitzan]},{id:T("slot"),label:"Shemesh #2",acceptableLevels:[b.L0,b.L1,b.L2,b.L3],requiredCertifications:[w.Nitzan]}],description:"4h shifts (05:00 cycle), 6/day. Requires Nitzan. Prefer same group (soft)."}),Q({name:"Mamtera",taskType:S.Mamtera,durationHours:14,shiftsPerDay:1,startHour:9,sameGroupRequired:!1,isLight:!1,subTeams:[],slots:[{id:T("slot"),label:"Mamtera L0 #1",acceptableLevels:[b.L0],requiredCertifications:[]},{id:T("slot"),label:"Mamtera L0 #2",acceptableLevels:[b.L0],requiredCertifications:[]}],description:"09:00-23:00. 2× L0."}),Q({name:"Karov",taskType:S.Karov,durationHours:8,shiftsPerDay:3,startHour:5,sameGroupRequired:!1,isLight:!1,subTeams:[],slots:[{id:T("slot"),label:"Karov Commander (L2+)",acceptableLevels:[b.L2,b.L3,b.L4],requiredCertifications:[]},{id:T("slot"),label:"Karov L0 + Salsala",acceptableLevels:[b.L0],requiredCertifications:[w.Salsala]},{id:T("slot"),label:"Karov L0 #2",acceptableLevels:[b.L0],requiredCertifications:[]},{id:T("slot"),label:"Karov L0 #3",acceptableLevels:[b.L0],requiredCertifications:[]}],description:"8h shifts (05:00 cycle), 3/day. 1× L2+, 1× L0 w/ Salsala, 2× L0."}),Q({name:"Karovit",taskType:S.Karovit,durationHours:8,shiftsPerDay:3,startHour:5,sameGroupRequired:!1,isLight:!0,subTeams:[],slots:[{id:T("slot"),label:"Karovit Commander (L2+)",acceptableLevels:[b.L2,b.L3,b.L4],requiredCertifications:[]},{id:T("slot"),label:"Karovit L0 #1",acceptableLevels:[b.L0],requiredCertifications:[]},{id:T("slot"),label:"Karovit L0 #2",acceptableLevels:[b.L0],requiredCertifications:[]},{id:T("slot"),label:"Karovit L0 #3",acceptableLevels:[b.L0],requiredCertifications:[]}],description:"8h shifts (05:00 cycle), 3/day. 1× L2+, 3× L0. Light — no rest impact."}),Q({name:"Aruga",taskType:S.Aruga,durationHours:1.5,shiftsPerDay:2,startHour:5,sameGroupRequired:!1,isLight:!1,subTeams:[],slots:[{id:T("slot"),label:"Aruga L0 #1",acceptableLevels:[b.L0],requiredCertifications:[]},{id:T("slot"),label:"Aruga L0 #2",acceptableLevels:[b.L0],requiredCertifications:[]}],description:"1.5h, 2/day (morning 05:00-06:30, evening 17:00-18:30). 2× L0."})}function Ia(){E.clear(),V.clear(),z.clear(),H.clear(),Z.length=0,at.length=0,Lt=!0,Ta(),Da(),Lt=!1}function Qt(t,e){if(!e.acceptableLevels.includes(t.level))return!1;for(const s of e.requiredCertifications)if(!t.certifications.includes(s))return!1;return!0}function re(t){const e=[...t.slots];for(const s of t.subTeams)e.push(...s.slots);return e}function Ca(t){return re(t).length}function Aa(t,e){const s=[];for(const a of e){const n=re(a);for(const i of n){const l=t.filter(o=>Qt(o,i));if(l.length===0){const o=i.acceptableLevels.map(c=>`L${c}`).join("/"),r=i.requiredCertifications.length>0?` + ${i.requiredCertifications.join(", ")}`:"";s.push({severity:O.Critical,code:"SKILL_GAP",message:`No participants meet the ${o}${r} requirement for "${a.name}" slot "${i.label}".`,templateId:a.id,slotId:i.id})}else l.length===1&&s.push({severity:O.Warning,code:"SKILL_SCARCITY",message:`Only 1 participant can fill "${a.name}" slot "${i.label}" (${l[0].name}). No fallback available.`,templateId:a.id,slotId:i.id})}}return s}function Ea(t,e){const s=[],a=U();let n=0,i=0;for(const r of e){const c=Ca(r),d=r.durationHours*r.shiftsPerDay;n+=c*d*a,i+=c*r.shiftsPerDay*a}let l=0;for(const r of t)for(const c of r.availability){const d=(c.end.getTime()-c.start.getTime())/36e5;l+=d}const o=l>0?n/l*100:100;return o>100?s.push({severity:O.Critical,code:"CAPACITY_EXCEEDED",message:`Required hours (${n.toFixed(0)}h) exceed available hours (${l.toFixed(0)}h). Schedule is impossible.`}):o>90&&s.push({severity:O.Warning,code:"HIGH_DENSITY",message:`High-Density Risk: ${o.toFixed(1)}% utilization (${n.toFixed(0)}h required / ${l.toFixed(0)}h available). May not leave adequate rest between tasks.`}),{findings:s,totalRequiredSlots:i,totalAvailableParticipantHours:l,totalRequiredHours:n,utilizationPercent:o}}function Ma(t,e){const s=[],a=[...new Set(t.map(n=>n.group))];for(const n of e){if(!n.sameGroupRequired)continue;const i=re(n);if(i.length===0)continue;let l=!1;for(const o of a){const r=t.filter(u=>u.group===o);let c=!0;const d=new Set;for(const u of i){const p=r.filter(f=>!d.has(f.id)&&Qt(f,u));if(p.length===0){c=!1;break}d.add(p[0].id)}if(c){l=!0;break}}if(!l)s.push({severity:O.Critical,code:"GROUP_INTEGRITY",message:`No single group can fill all ${i.length} slots for "${n.name}" (same-group required). Need at least 1 group with matching members.`,templateId:n.id});else{const o=[];for(const r of a){const c=t.filter(p=>p.group===r),d=new Set;let u=!0;for(const p of i){const f=c.filter(m=>!d.has(m.id)&&Qt(m,p));if(f.length===0){u=!1;break}d.add(f[0].id)}u||o.push(r)}o.length>0&&n.shiftsPerDay>1&&s.push({severity:O.Warning,code:"GROUP_ROTATION_GAP",message:`"${n.name}" has ${n.shiftsPerDay} shifts/day but groups [${o.join(", ")}] cannot fill all slots. Shift rotation may be limited.`,templateId:n.id})}}return s}function ce(){const t=Dt(),e=zt(),s=Aa(t,e),a=Ea(t,e),n=Ma(t,e),i=[...s,...a.findings,...n];return{canGenerate:!i.some(o=>o.severity===O.Critical),findings:i,utilizationSummary:{totalRequiredSlots:a.totalRequiredSlots,totalAvailableParticipantHours:a.totalAvailableParticipantHours,totalRequiredHours:a.totalRequiredHours,utilizationPercent:a.utilizationPercent}}}const Ne=[b.L0,b.L1,b.L2,b.L3,b.L4],Oe=[w.Nitzan,w.Hamama,w.Salsala];function Ra(t){return`<span class="badge" style="background:${["#95a5a6","#3498db","#2ecc71","#e67e22","#e74c3c"][t]}">L${t}</span>`}function xa(t){if(t.length===0)return'<span class="text-muted">None</span>';const e={Nitzan:"#16a085",Salsala:"#8e44ad",Hamama:"#c0392b"};return t.map(s=>`<span class="badge" style="background:${e[s]||"#7f8c8d"}">${s}</span>`).join(" ")}const ye=["#3498db","#e67e22","#2ecc71","#9b59b6","#e74c3c","#1abc9c","#f39c12","#34495e"],Ct={};function Pa(t){if(!Ct[t]){const e=Object.keys(Ct).length%ye.length;Ct[t]=ye[e]}return Ct[t]}function Ha(t){return`<span class="badge" style="background:${Pa(t)}">${t}</span>`}const Ba=[/^new\s*group$/i,/^group\s*\w$/i,/^untitled/i,/^default/i];function Fe(t,e){const s=t.trim();if(!s)return{valid:!1,error:"Group name cannot be empty."};if(s.length<2)return{valid:!1,error:"Group name must be at least 2 characters."};for(const i of Ba)if(i.test(s))return{valid:!1,error:`"${s}" is not allowed as a group name.`};const a=s.toLowerCase(),n=e.find(i=>i.toLowerCase()===a&&i!==s);return n?{valid:!1,error:`A similar group "${n}" already exists. Use it instead.`}:{valid:!0,error:""}}function ke(t,e,s){if(t!=="__new__")return t;const a=e?.value??"",n=Fe(a,wt());return n.valid?(s&&(s.style.display="none"),wt().find(l=>l.toLowerCase()===a.trim().toLowerCase())??a.trim()):(s&&(s.textContent=n.error,s.style.display="block"),e?.focus(),null)}function Ft(t){return t.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}let Et=null,te=null,gt="",Tt="",yt="asc";const C=new Set;let st=null,Mt=!1,Rt=!1;function qa(t){if(!Tt)return t;const e=yt==="asc"?1:-1;return[...t].sort((s,a)=>{switch(Tt){case"name":return e*s.name.localeCompare(a.name);case"group":return e*s.group.localeCompare(a.group)||s.name.localeCompare(a.name);case"level":return e*(s.level-a.level)||s.name.localeCompare(a.name);default:return 0}})}function Kt(t){return Tt!==t?"":yt==="asc"?" ▲":" ▼"}function Na(){const t=Dt(),e=wt(),s=gt?t.filter(i=>i.group===gt):t,a=qa(s);let n=`
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>Participants <span class="count">${t.length}</span></h2>
      <div class="filter-pills">
        <button class="pill ${gt===""?"pill-active":""}" data-action="filter-group" data-group="">All</button>
        ${e.map(i=>`<button class="pill ${gt===i?"pill-active":""}" data-action="filter-group" data-group="${i}">${i}</button>`).join("")}
      </div>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary btn-sm" data-action="add-participant">+ Add Participant</button>
    </div>
  </div>`;return n+=`<div class="table-responsive"><table class="table table-participants">
    <thead><tr>
      <th class="col-select"><input type="checkbox" id="cb-select-all" title="Select all" ${C.size>0&&C.size===a.length?"checked":""} /></th>
      <th>#</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="name">Name${Kt("name")}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="group">Group${Kt("group")}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="level">Level${Kt("level")}</th>
      <th>Certifications</th>
      <th>Availability</th><th>Blackouts</th><th class="col-actions">Actions</th>
    </tr></thead><tbody>`,a.forEach((i,l)=>{const o=Et===i.id,r=qe(i.id),c=le(i.id),d=te===i.id,u=r.length+c.length,p=C.has(i.id);o?n+=Oa(i,l+1):(n+=`<tr data-participant-id="${i.id}" class="${p?"row-selected":""}">
        <td class="col-select"><input type="checkbox" class="cb-select-participant" data-pid="${i.id}" ${p?"checked":""} /></td>
        <td>${l+1}</td>
        <td><strong>${i.name}</strong></td>
        <td>${Ha(i.group)}</td>
        <td>${Ra(i.level)}</td>
        <td>${xa(i.certifications)}</td>
        <td class="avail-cell">
          ${i.availability.map(f=>`<small>${Ft(f.start)}–${Ft(f.end)}</small>`).join("<br>")}
        </td>
        <td>
          <button class="btn-sm btn-outline" data-action="toggle-blackouts" data-pid="${i.id}">
            ${u>0?`<span class="badge badge-sm" style="background:var(--warning)">${u}</span>`:"—"}
          </button>
        </td>
        <td class="col-actions">
          <button class="btn-sm btn-outline" data-action="edit-participant" data-pid="${i.id}" title="Edit">✏️</button>
          <button class="btn-sm btn-outline btn-danger-outline" data-action="remove-participant" data-pid="${i.id}" title="Remove">🗑️</button>
        </td>
      </tr>`,d&&(n+=Fa(i.id,r)))}),n+="</tbody></table></div>",n+=_a(e),C.size>0&&(n+=`<div class="bulk-toolbar">
      <span class="bulk-count">${C.size} participant${C.size>1?"s":""} selected</span>
      <button class="btn-primary btn-sm" data-action="bulk-add-unavailability">📅 Add Unavailability</button>
      <button class="btn-danger btn-sm" data-action="bulk-delete-participants">🗑️ Delete Participants</button>
      <button class="btn-sm btn-outline" data-action="bulk-clear-selection">Clear Selection</button>
    </div>`),Mt&&(n+=Ga()),Rt&&(n+=Wa()),n}function Oa(t,e){const s=wt();return`<tr class="row-editing" data-participant-id="${t.id}">
    <td class="col-select"></td>
    <td>${e}</td>
    <td><input class="input-sm" type="text" data-field="name" value="${t.name}" /></td>
    <td>
      <select class="input-sm" data-field="group" data-group-select>
        ${s.map(a=>`<option value="${a}" ${t.group===a?"selected":""}>${a}</option>`).join("")}
        <option value="__new__">+ New Group…</option>
      </select>
      <input class="input-sm" type="text" data-field="new-group-name" placeholder="Enter group name" style="display:none; margin-top:4px" />
      <span class="group-error" style="display:none; color:var(--error); font-size:0.75rem;"></span>
    </td>
    <td>
      <select class="input-sm" data-field="level">
        ${Ne.map(a=>`<option value="${a}" ${t.level===a?"selected":""}>L${a}</option>`).join("")}
      </select>
    </td>
    <td>
      <div class="cert-checkboxes">
        ${Oe.map(a=>`<label class="checkbox-label">
            <input type="checkbox" data-cert="${a}" ${t.certifications.includes(a)?"checked":""} /> ${a}
          </label>`).join("")}
      </div>
    </td>
    <td colspan="2"></td>
    <td class="col-actions">
      <button class="btn-sm btn-primary" data-action="save-participant" data-pid="${t.id}">Save</button>
      <button class="btn-sm btn-outline" data-action="cancel-edit">Cancel</button>
    </td>
  </tr>`}const $e=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];function Fa(t,e){const s=le(t);let a=`<tr class="row-blackout-expansion">
    <td colspan="9">
      <div class="blackout-panel">
        <h4>Blackout Periods</h4>
        <div class="blackout-list">`;if(e.length===0)a+='<p class="text-muted">No blackouts configured.</p>';else{a+="<ul>";for(const n of e)a+=`<li>
        <strong>${Ft(n.start)} – ${Ft(n.end)}</strong>
        ${n.reason?`<span class="text-muted"> (${n.reason})</span>`:""}
        <button class="btn-sm btn-danger-outline" data-action="remove-blackout" data-pid="${t}" data-bid="${n.id}">✕</button>
      </li>`;a+="</ul>"}if(a+=`</div>
    <div class="blackout-add">
      <input type="time" class="input-sm" data-field="bo-start" value="00:00" />
      <span>to</span>
      <input type="time" class="input-sm" data-field="bo-end" value="08:00" />
      <input type="text" class="input-sm" data-field="bo-reason" placeholder="Reason (optional)" />
      <button class="btn-sm btn-primary" data-action="add-blackout" data-pid="${t}">Add</button>
    </div>

    <h4 style="margin-top:12px">Date-Specific Unavailability</h4>
    <div class="blackout-list">`,s.length===0)a+='<p class="text-muted">No date-specific rules. Participant follows standard availability.</p>';else{a+="<ul>";for(const n of s){let i;n.specificDate?i=n.specificDate:n.dayOfWeek!==void 0?i=`Every ${$e[n.dayOfWeek]}`:i="Unknown rule";const l=n.allDay?"All Day":`${String(n.startHour).padStart(2,"0")}:00 – ${String(n.endHour).padStart(2,"0")}:00`;a+=`<li>
        <strong>${i}</strong> — <span>${l}</span>
        ${n.reason?`<span class="text-muted"> (${n.reason})</span>`:""}
        <button class="btn-sm btn-danger-outline" data-action="remove-date-unavail" data-pid="${t}" data-rid="${n.id}">✕</button>
      </li>`}a+="</ul>"}return a+=`</div>
    <div class="blackout-add">
      <select class="input-sm" data-field="du-type">
        <option value="dayOfWeek">Day of Week</option>
        <option value="specificDate">Specific Date</option>
      </select>
      <select class="input-sm" data-field="du-dow" style="width:120px">
        ${$e.map((n,i)=>`<option value="${i}">${n}</option>`).join("")}
      </select>
      <input type="date" class="input-sm" data-field="du-date" style="display:none" />
      <label class="checkbox-label" style="white-space:nowrap">
        <input type="checkbox" data-field="du-allday" /> All Day
      </label>
      <input type="number" class="input-sm" data-field="du-start-hour" min="0" max="23" value="8" placeholder="Start hour" style="width:70px" />
      <span>to</span>
      <input type="number" class="input-sm" data-field="du-end-hour" min="0" max="23" value="12" placeholder="End hour" style="width:70px" />
      <input type="text" class="input-sm" data-field="du-reason" placeholder="Reason (optional)" />
      <button class="btn-sm btn-primary" data-action="add-date-unavail" data-pid="${t}">Add</button>
    </div>
  </div></td></tr>`,a}function _a(t){return`
  <div id="add-participant-form" class="add-form" style="display:none;">
    <h4>New Participant</h4>
    <div class="form-row">
      <label>Name <input class="input-sm" type="text" data-field="new-name" placeholder="Name" /></label>
      <label>Group
        <select class="input-sm" data-field="new-group" data-group-select>
          ${t.map(e=>`<option value="${e}">${e}</option>`).join("")}
          <option value="__new__">+ New Group…</option>
        </select>
        <input class="input-sm" type="text" data-field="new-group-name" placeholder="Enter group name" style="display:none; margin-top:4px" />
        <span class="group-error" style="display:none; color:var(--error); font-size:0.75rem;"></span>
      </label>
      <label>Level
        <select class="input-sm" data-field="new-level">
          ${Ne.map(e=>`<option value="${e}" ${e===b.L0?"selected":""}>L${e}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="form-row">
      <span>Certifications:</span>
      ${Oe.map(e=>`<label class="checkbox-label">
          <input type="checkbox" data-new-cert="${e}" ${e===w.Nitzan?"checked":""} /> ${e}
        </label>`).join("")}
    </div>
    <div class="form-row">
      <button class="btn-primary btn-sm" data-action="confirm-add-participant">Add</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-participant">Cancel</button>
    </div>
  </div>`}function Ga(){const t=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];return`<div class="bulk-dialog-backdrop" data-action="bulk-dialog-dismiss">
    <div class="bulk-dialog">
      <h3>Add Unavailability for ${C.size} Participant${C.size>1?"s":""}</h3>

      <div class="bulk-dialog-body">
        <div class="form-row">
          <label>Type
            <select class="input-sm" data-field="bulk-type">
              <option value="specificDate">Specific Date</option>
              <option value="dayOfWeek">Day of Week</option>
            </select>
          </label>
          <label class="bulk-field-date">Date
            <input type="date" class="input-sm" data-field="bulk-date" />
          </label>
          <label class="bulk-field-dow" style="display:none">Day
            <select class="input-sm" data-field="bulk-dow">
              ${t.map((e,s)=>`<option value="${s}">${e}</option>`).join("")}
            </select>
          </label>
        </div>

        <div class="form-row">
          <label class="checkbox-label">
            <input type="checkbox" data-field="bulk-allday" /> All Day
          </label>
        </div>

        <div class="form-row bulk-time-fields">
          <label>Start Hour
            <input type="number" class="input-sm" data-field="bulk-start" min="0" max="23" value="8" style="width:70px" />
          </label>
          <span style="align-self:end;padding-bottom:4px">to</span>
          <label>End Hour
            <input type="number" class="input-sm" data-field="bulk-end" min="0" max="23" value="16" style="width:70px" />
          </label>
        </div>

        <div class="form-row">
          <label style="flex:1">Reason / Label
            <input type="text" class="input-sm" data-field="bulk-reason" placeholder="e.g. Team Training" style="width:100%" />
          </label>
        </div>
      </div>

      <div class="bulk-dialog-footer">
        <button class="btn-sm btn-outline" data-action="bulk-dialog-cancel">Cancel</button>
        <button class="btn-primary btn-sm" data-action="bulk-dialog-save">Save for ${C.size}</button>
      </div>
    </div>
  </div>`}function Wa(){const t=C.size;return`<div class="bulk-dialog-backdrop" data-action="bulk-delete-dismiss">
    <div class="bulk-dialog bulk-delete-dialog">
      <h3>⚠️ Delete ${t} Participant${t>1?"s":""}?</h3>
      <p class="bulk-delete-warning">
        Are you sure you want to delete <strong>${t}</strong> participant${t>1?"s":""}?
        This action will also remove all their associated assignments and
        unavailability records. This cannot be undone.
      </p>
      <div class="bulk-dialog-footer">
        <button class="btn-sm btn-outline" data-action="bulk-delete-cancel">Cancel</button>
        <button class="btn-danger btn-sm" data-action="bulk-delete-confirm">Confirm Delete</button>
      </div>
    </div>
  </div>`}function za(t,e){const s=t.querySelector("#cb-select-all");s&&s.addEventListener("change",()=>{const a=t.querySelectorAll(".cb-select-participant");s.checked?a.forEach(n=>C.add(n.dataset.pid)):C.clear(),st=null,e()}),t.querySelectorAll(".cb-select-participant").forEach(a=>{a.addEventListener("click",n=>{n.stopPropagation();const i=a.dataset.pid,l=Array.from(t.querySelectorAll(".cb-select-participant")).map(o=>o.dataset.pid);if(n.shiftKey&&st){const o=l.indexOf(st),r=l.indexOf(i);if(o!==-1&&r!==-1){const[c,d]=o<r?[o,r]:[r,o];for(let u=c;u<=d;u++)C.add(l[u])}}else n.ctrlKey||n.metaKey,C.has(i)?C.delete(i):C.add(i);st=i,e()})}),t.addEventListener("change",a=>{const n=a.target.getAttribute("data-field");if(n==="bulk-type"){const i=a.target.value,l=a.target.closest(".bulk-dialog"),o=l.querySelector(".bulk-field-date"),r=l.querySelector(".bulk-field-dow");i==="dayOfWeek"?(o.style.display="none",r.style.display=""):(o.style.display="",r.style.display="none")}if(n==="bulk-allday"){const i=a.target.checked,o=a.target.closest(".bulk-dialog").querySelector(".bulk-time-fields");o&&(o.style.display=i?"none":"")}}),t.addEventListener("change",a=>{const n=a.target;if(!n.hasAttribute("data-group-select"))return;const i=n,l=i.parentElement,o=l.querySelector('[data-field="new-group-name"]'),r=l.querySelector(".group-error");i.value==="__new__"?o&&(o.style.display="block",o.value="",o.focus()):(o&&(o.style.display="none",o.value=""),r&&(r.style.display="none"))}),t.addEventListener("change",a=>{const n=a.target;if(n.dataset?.field==="du-type"){const i=n,l=i.closest(".blackout-panel"),o=l.querySelector('[data-field="du-dow"]'),r=l.querySelector('[data-field="du-date"]');i.value==="dayOfWeek"?(o&&(o.style.display=""),r&&(r.style.display="none")):(o&&(o.style.display="none"),r&&(r.style.display=""))}}),t.addEventListener("input",a=>{const n=a.target;if(n.dataset.field!=="new-group-name")return;const l=n.closest("td, label").querySelector(".group-error"),o=n.value;if(!o.trim()){l&&(l.style.display="none");return}const r=Fe(o,wt());l&&(l.textContent=r.valid?"":r.error,l.style.display=r.valid?"none":"block")}),t.addEventListener("click",a=>{const n=a.target,i=n.dataset.action;if(i)switch(i){case"sort-column":{const l=n.dataset.sortCol;l===Tt?yt=yt==="asc"?"desc":"asc":(Tt=l,yt="asc"),e();break}case"filter-group":{gt=n.dataset.group||"",e();break}case"add-participant":{const l=t.querySelector("#add-participant-form");l&&(l.style.display=l.style.display==="none"?"block":"none");break}case"confirm-add-participant":{const l=t.querySelector('[data-field="new-name"]'),o=t.querySelector('[data-field="new-group"]'),r=t.querySelector('[data-field="new-level"]'),c=l?.value.trim();if(!c){l?.focus();return}const d=t.querySelector("#add-participant-form"),u=d.querySelector('[data-field="new-group-name"]'),p=d.querySelector(".group-error"),f=ke(o?.value||"",u,p);if(f===null)return;const m=parseInt(r?.value||"0"),g=[];t.querySelectorAll("[data-new-cert]").forEach(h=>{h.checked&&g.push(h.dataset.newCert)}),la({name:c,level:m,certifications:g,group:f}),e();break}case"cancel-add-participant":{const l=t.querySelector("#add-participant-form");l&&(l.style.display="none");break}case"edit-participant":{Et=n.dataset.pid||null,e();break}case"save-participant":{const l=n.dataset.pid,o=t.querySelector(`tr[data-participant-id="${l}"]`),r=o.querySelector('[data-field="name"]')?.value.trim(),c=o.querySelector('[data-field="group"]'),d=o.querySelector('[data-field="new-group-name"]'),u=o.querySelector(".group-error"),p=ke(c?.value||"",d,u);if(p===null)return;const f=parseInt(o.querySelector('[data-field="level"]')?.value||"0"),m=[];o.querySelectorAll("[data-cert]").forEach(g=>{g.checked&&m.push(g.dataset.cert)}),ra(l,{name:r,group:p,level:f,certifications:m}),Et=null,e();break}case"cancel-edit":{Et=null,e();break}case"remove-participant":{const l=n.dataset.pid,o=ua(l);o&&confirm(`Remove ${o.name}?`)&&(ca(l),e());break}case"toggle-blackouts":{const l=n.closest("[data-pid]")?.getAttribute("data-pid")||n.dataset.pid;te=te===l?null:l,e();break}case"remove-blackout":{const l=n.dataset.pid,o=n.dataset.bid;fa(l,o),e();break}case"add-blackout":{const l=n.dataset.pid,o=n.closest(".blackout-panel"),r=o.querySelector('[data-field="bo-start"]')?.value,c=o.querySelector('[data-field="bo-end"]')?.value,d=o.querySelector('[data-field="bo-reason"]')?.value;if(!r||!c)return;const u=ut(),[p,f]=r.split(":").map(Number),[m,g]=c.split(":").map(Number),h=new Date(u.getFullYear(),u.getMonth(),u.getDate(),p,f);let v=new Date(u.getFullYear(),u.getMonth(),u.getDate(),m,g);v<=h&&(v=new Date(v.getTime()+24*36e5)),pa(l,h,v,d||void 0),e();break}case"remove-date-unavail":{const l=n.dataset.pid,o=n.dataset.rid;ma(l,o),e();break}case"add-date-unavail":{const l=n.dataset.pid,o=n.closest(".blackout-panel"),r=o.querySelector('[data-field="du-type"]')?.value,c=o.querySelector('[data-field="du-allday"]')?.checked??!1,d=parseInt(o.querySelector('[data-field="du-start-hour"]')?.value||"0"),u=parseInt(o.querySelector('[data-field="du-end-hour"]')?.value||"0"),p=o.querySelector('[data-field="du-reason"]')?.value||void 0;if(r==="dayOfWeek"){const f=parseInt(o.querySelector('[data-field="du-dow"]')?.value||"0");be(l,{dayOfWeek:f,allDay:c,startHour:d,endHour:u,reason:p})}else{const f=o.querySelector('[data-field="du-date"]')?.value;if(!f)return;be(l,{specificDate:f,allDay:c,startHour:d,endHour:u,reason:p})}e();break}case"bulk-add-unavailability":{Mt=!0,e();break}case"bulk-clear-selection":{C.clear(),st=null,e();break}case"bulk-delete-participants":{Rt=!0,e();break}case"bulk-delete-dismiss":case"bulk-delete-cancel":{Rt=!1,e();break}case"bulk-delete-confirm":{const l=Array.from(C),o=da(l);Rt=!1,C.clear(),st=null,requestAnimationFrame(()=>{e();const r=document.getElementById("tab-content");if(r){const c=document.createElement("div");c.className="bulk-confirmation",c.textContent=`Successfully deleted ${o} participant${o!==1?"s":""}.`,r.prepend(c),setTimeout(()=>c.remove(),3500)}});break}case"bulk-dialog-dismiss":case"bulk-dialog-cancel":{Mt=!1,e();break}case"bulk-dialog-save":{const l=t.querySelector(".bulk-dialog"),o=l.querySelector('[data-field="bulk-type"]').value,r=l.querySelector('[data-field="bulk-allday"]').checked,c=parseInt(l.querySelector('[data-field="bulk-start"]').value||"0"),d=parseInt(l.querySelector('[data-field="bulk-end"]').value||"0"),u=l.querySelector('[data-field="bulk-reason"]').value||void 0,p={allDay:r,startHour:r?0:c,endHour:r?24:d,reason:u};if(o==="dayOfWeek")p.dayOfWeek=parseInt(l.querySelector('[data-field="bulk-dow"]').value);else{const m=l.querySelector('[data-field="bulk-date"]').value;if(!m){l.querySelector('[data-field="bulk-date"]').focus();break}p.specificDate=m}const f=ga(Array.from(C),p);Mt=!1,C.clear(),st=null,requestAnimationFrame(()=>{e();const m=document.getElementById("tab-content");if(m){const g=document.createElement("div");g.className="bulk-confirmation",g.textContent=`Added unavailability for ${f} participant${f!==1?"s":""}.`,m.prepend(g),setTimeout(()=>g.remove(),3500)}});break}}})}const Ua=[b.L0,b.L1,b.L2,b.L3,b.L4],ja=[w.Nitzan,w.Hamama,w.Salsala],Ka=Object.values(S),Ya={Adanit:"#4A90D9",Hamama:"#E74C3C",Shemesh:"#F39C12",Mamtera:"#27AE60",Karov:"#8E44AD",Karovit:"#BDC3C7",Aruga:"#1ABC9C"};function Va(t){return`<span class="badge" style="background:${Ya[t]||"#7f8c8d"}">${t}</span>`}function Ja(t){return`<span class="badge badge-sm" style="background:${["#95a5a6","#3498db","#2ecc71","#e67e22","#e74c3c"][t]}">L${t}</span>`}function Xa(t){return`<span class="badge badge-sm" style="background:${{Nitzan:"#16a085",Salsala:"#8e44ad",Hamama:"#c0392b"}[t]||"#7f8c8d"}">${t}</span>`}let ht=null,K=null,vt=!1;function Za(){const t=zt(),e=ce();let s=`
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>Task Rules <span class="count">${t.length}</span></h2>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary btn-sm" data-action="toggle-add-template">+ New Task Template</button>
    </div>
  </div>`;s+=Qa(e),s+='<div class="template-list">';for(const a of t)s+=tn(a,e);return s+="</div>",vt&&(s+=sn()),s}function Qa(t){const e=t.findings.filter(l=>l.severity===O.Critical),s=t.findings.filter(l=>l.severity===O.Warning);t.findings.filter(l=>l.severity===O.Info);const a=t.utilizationSummary,n=a.utilizationPercent>100?"text-danger":a.utilizationPercent>90?"text-warn":"";let i=`<div class="preflight-panel">
    <h3>Pre-Flight Check</h3>
    <div class="preflight-summary">
      <div class="score-grid" style="margin-bottom:12px;">
        <div class="score-card ${e.length>0?"status-error":"status-ok"}">
          <div class="score-value">${e.length>0?"✗ Blocked":"✓ Ready"}</div>
          <div class="score-label">Generate Status</div>
        </div>
        <div class="score-card">
          <div class="score-value">${a.totalRequiredSlots}</div>
          <div class="score-label">Total Slots/Day</div>
        </div>
        <div class="score-card">
          <div class="score-value">${a.totalRequiredHours.toFixed(0)}h</div>
          <div class="score-label">Required Hours</div>
        </div>
        <div class="score-card">
          <div class="score-value">${a.totalAvailableParticipantHours.toFixed(0)}h</div>
          <div class="score-label">Available Hours</div>
        </div>
        <div class="score-card">
          <div class="score-value ${n}">${a.utilizationPercent.toFixed(1)}%</div>
          <div class="score-label">Utilization</div>
        </div>
      </div>`;if(e.length>0){i+=`<div class="alert alert-error"><strong>Critical Issues (${e.length})</strong><ul>`;for(const l of e)i+=`<li><code>${l.code}</code> ${l.message}</li>`;i+="</ul></div>"}if(s.length>0){i+=`<div class="alert alert-warn"><strong>Warnings (${s.length})</strong><ul>`;for(const l of s)i+=`<li><code>${l.code}</code> ${l.message}</li>`;i+="</ul></div>"}return e.length===0&&s.length===0&&(i+='<div class="alert alert-ok">All pre-flight checks passed. Ready to generate schedule.</div>'),i+="</div></div>",i}function tn(t,e){const s=ht===t.id,a=e.findings.filter(u=>u.templateId===t.id),n=a.some(u=>u.severity===O.Critical),i=a.some(u=>u.severity===O.Warning),l=[...t.slots];for(const u of t.subTeams)l.push(...u.slots);const o=l.length,r=o*t.shiftsPerDay;let d=`<div class="template-card ${n?"template-card-error":i?"template-card-warn":""}" data-template-id="${t.id}">
    <div class="template-header" data-action="toggle-template" data-tid="${t.id}">
      <div class="template-title">
        ${Va(t.taskType)}
        <strong>${t.name}</strong>
        <span class="text-muted"> · ${t.durationHours}h × ${t.shiftsPerDay} shifts · ${o} slots/shift · ${r} people/day</span>
        ${n?'<span class="badge badge-sm" style="background:var(--danger)">!</span>':""}
        ${i&&!n?'<span class="badge badge-sm" style="background:var(--warning)">⚠</span>':""}
      </div>
      <div class="template-toggles">
        ${t.sameGroupRequired?'<span class="badge badge-sm badge-outline">Same Group</span>':""}
        ${t.isLight?'<span class="badge badge-sm badge-outline">Light</span>':""}
        <span class="expand-arrow">${s?"▼":"▶"}</span>
      </div>
    </div>`;if(s){if(d+='<div class="template-body">',t.description&&(d+=`<p class="text-muted" style="margin-bottom:12px;">${t.description}</p>`),d+=`<div class="template-props">
      <label>Duration (h): <input class="input-sm" type="number" step="0.5" min="0.5" data-tpl-field="durationHours" value="${t.durationHours}" data-tid="${t.id}" /></label>
      <label>Shifts/Day: <input class="input-sm" type="number" min="1" max="12" data-tpl-field="shiftsPerDay" value="${t.shiftsPerDay}" data-tid="${t.id}" /></label>
      <label>Start Hour: <input class="input-sm" type="number" min="0" max="23" data-tpl-field="startHour" value="${t.startHour}" data-tid="${t.id}" /></label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="sameGroupRequired" data-tid="${t.id}" ${t.sameGroupRequired?"checked":""} /> Same Group</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="isLight" data-tid="${t.id}" ${t.isLight?"checked":""} /> Light Task</label>
      <button class="btn-sm btn-primary" data-action="save-template-props" data-tid="${t.id}">Apply</button>
    </div>`,t.subTeams.length>0){d+='<h4 style="margin:12px 0 8px;">Sub-Teams</h4>';for(const u of t.subTeams)d+=en(t.id,u,e)}(t.slots.length>0||t.subTeams.length===0)&&(d+=`<h4 style="margin:12px 0 8px;">${t.subTeams.length>0?"Additional":""} Slots</h4>`,d+=_e(t.id,t.slots,void 0,e)),d+=`<div class="template-actions">
      <button class="btn-sm btn-outline" data-action="add-subteam" data-tid="${t.id}">+ Sub-Team</button>
      <button class="btn-sm btn-outline" data-action="add-slot" data-tid="${t.id}">+ Slot</button>
      <button class="btn-sm btn-danger-outline" data-action="remove-template" data-tid="${t.id}">Remove Template</button>
    </div>`,K&&K.templateId===t.id&&!K.subTeamId&&(d+=Ge(t.id)),d+="</div>"}return d+="</div>",d}function en(t,e,s){let a=`<div class="subteam-card">
    <div class="subteam-header">
      <strong>${e.name}</strong>
      <span class="text-muted">(${e.slots.length} slots)</span>
      <button class="btn-sm btn-outline" data-action="add-slot-subteam" data-tid="${t}" data-stid="${e.id}">+ Slot</button>
      <button class="btn-sm btn-danger-outline" data-action="remove-subteam" data-tid="${t}" data-stid="${e.id}">✕</button>
    </div>`;return a+=_e(t,e.slots,e.id,s),K&&K.templateId===t&&K.subTeamId===e.id&&(a+=Ge(t,e.id)),a+="</div>",a}function _e(t,e,s,a){if(e.length===0)return'<p class="text-muted" style="padding:4px 0;">No slots defined.</p>';let n=`<table class="table table-slots">
    <thead><tr><th>Label</th><th>Levels</th><th>Certifications</th><th>Status</th><th></th></tr></thead>
    <tbody>`;for(const i of e){const l=a.findings.find(r=>r.slotId===i.id),o=l?`<span class="${l.severity===O.Critical?"text-danger":"text-warn"}">${l.severity===O.Critical?"✗":"⚠"} ${l.code}</span>`:'<span style="color:var(--success)">✓</span>';n+=`<tr>
      <td>${i.label}</td>
      <td>${i.acceptableLevels.map(r=>Ja(r)).join(" ")}</td>
      <td>${i.requiredCertifications.length>0?i.requiredCertifications.map(r=>Xa(r)).join(" "):'<span class="text-muted">None</span>'}</td>
      <td>${o}</td>
      <td><button class="btn-sm btn-danger-outline" data-action="remove-slot" data-tid="${t}" ${s?`data-stid="${s}"`:""} data-slotid="${i.id}">✕</button></td>
    </tr>`}return n+="</tbody></table>",n}function Ge(t,e){return`<div class="add-slot-form">
    <h5>Add Slot</h5>
    <div class="form-row">
      <label>Label: <input class="input-sm" type="text" data-field="slot-label" placeholder="e.g. L0 #1" /></label>
    </div>
    <div class="form-row">
      <span>Levels:</span>
      ${Ua.map(s=>`<label class="checkbox-label"><input type="checkbox" data-slot-level="${s}" checked /> L${s}</label>`).join("")}
    </div>
    <div class="form-row">
      <span>Certifications:</span>
      ${ja.map(s=>`<label class="checkbox-label"><input type="checkbox" data-slot-cert="${s}" /> ${s}</label>`).join("")}
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-slot" data-tid="${t}" ${e?`data-stid="${e}"`:""}>Add</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-slot">Cancel</button>
    </div>
  </div>`}function sn(){return`<div class="add-form" id="add-template-form">
    <h4>New Task Template</h4>
    <div class="form-row">
      <label>Name: <input class="input-sm" type="text" data-field="tpl-name" placeholder="Task name" /></label>
      <label>Type:
        <select class="input-sm" data-field="tpl-type">
          ${Ka.map(t=>`<option value="${t}">${t}</option>`).join("")}
          <option value="Custom">Custom</option>
        </select>
      </label>
      <label>Duration (h): <input class="input-sm" type="number" step="0.5" min="0.5" value="8" data-field="tpl-duration" /></label>
      <label>Shifts/Day: <input class="input-sm" type="number" min="1" max="12" value="1" data-field="tpl-shifts" /></label>
      <label>Start Hour: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="tpl-start" /></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-samegroup" /> Same Group Required</label>
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-light" /> Light Task</label>
    </div>
    <div class="form-row">
      <label>Description: <input class="input-sm" type="text" data-field="tpl-desc" placeholder="Optional" style="width:300px;" /></label>
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-template">Create</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-template">Cancel</button>
    </div>
  </div>`}function an(t,e){t.addEventListener("click",s=>{const a=s.target,n=a.dataset.action;if(n)switch(n){case"toggle-template":{const i=a.closest("[data-tid]")?.getAttribute("data-tid")||a.dataset.tid;ht=ht===i?null:i,K=null,e();break}case"save-template-props":{const i=a.dataset.tid,l=a.closest(".template-body"),o=parseFloat(l.querySelector('[data-tpl-field="durationHours"]')?.value||"8"),r=parseInt(l.querySelector('[data-tpl-field="shiftsPerDay"]')?.value||"1"),c=parseInt(l.querySelector('[data-tpl-field="startHour"]')?.value||"6"),d=l.querySelector('[data-tpl-field="sameGroupRequired"]')?.checked||!1,u=l.querySelector('[data-tpl-field="isLight"]')?.checked||!1;ha(i,{durationHours:o,shiftsPerDay:r,startHour:c,sameGroupRequired:d,isLight:u}),e();break}case"add-subteam":{const i=a.dataset.tid,l=prompt("Sub-team name:");if(!l)return;$a(i,l.trim()),e();break}case"remove-subteam":{const i=a.dataset.tid,l=a.dataset.stid;confirm("Remove this sub-team and all its slots?")&&(Sa(i,l),e());break}case"add-slot":{K={templateId:a.dataset.tid},e();break}case"add-slot-subteam":{const i=a.dataset.tid,l=a.dataset.stid;K={templateId:i,subTeamId:l},e();break}case"confirm-add-slot":{const i=a.dataset.tid,l=a.dataset.stid,o=a.closest(".add-slot-form"),r=o.querySelector('[data-field="slot-label"]')?.value.trim()||"Slot",c=[];o.querySelectorAll("[data-slot-level]").forEach(p=>{p.checked&&c.push(parseInt(p.dataset.slotLevel))});const d=[];o.querySelectorAll("[data-slot-cert]").forEach(p=>{p.checked&&d.push(p.dataset.slotCert)});const u={label:r,acceptableLevels:c,requiredCertifications:d};l?La(i,l,u):ya(i,u),K=null,e();break}case"cancel-add-slot":{K=null,e();break}case"remove-slot":{const i=a.dataset.tid,l=a.dataset.stid,o=a.dataset.slotid;l?wa(i,l,o):ka(i,o),e();break}case"remove-template":{const i=a.dataset.tid,l=ba(i);l&&confirm(`Remove template "${l.name}"?`)&&(va(i),ht===i&&(ht=null),e());break}case"toggle-add-template":{vt=!vt,e();break}case"confirm-add-template":{const i=t.querySelector("#add-template-form"),l=i.querySelector('[data-field="tpl-name"]')?.value.trim();if(!l)return;const o=i.querySelector('[data-field="tpl-type"]')?.value||"Custom",r=parseFloat(i.querySelector('[data-field="tpl-duration"]')?.value||"8"),c=parseInt(i.querySelector('[data-field="tpl-shifts"]')?.value||"1"),d=parseInt(i.querySelector('[data-field="tpl-start"]')?.value||"6"),u=i.querySelector('[data-field="tpl-samegroup"]')?.checked||!1,p=i.querySelector('[data-field="tpl-light"]')?.checked||!1,f=i.querySelector('[data-field="tpl-desc"]')?.value.trim();Q({name:l,taskType:o,durationHours:r,shiftsPerDay:c,startHour:d,sameGroupRequired:u,isLight:p,subTeams:[],slots:[],description:f||void 0}),vt=!1,e();break}case"cancel-add-template":{vt=!1,e();break}}})}function de(t){const e={},s={};for(const o of Object.values(S))e[o]=0,s[o]=0;let a=0,n=0,i=0,l=0;for(const{task:o}of t){const r=(o.timeBlock.end.getTime()-o.timeBlock.start.getTime())/36e5;e[o.type]=(e[o.type]||0)+r,s[o.type]=(s[o.type]||0)+1,o.isLight?(i+=r,l++):(a+=r,n++)}return{heavyHours:a,heavyCount:n,lightHours:i,lightCount:l,typeHours:e,typeCounts:s}}const ue={Adanit:"#4A90D9",Hamama:"#E74C3C",Shemesh:"#F39C12",Mamtera:"#27AE60",Karov:"#8E44AD",Karovit:"#BDC3C7",Aruga:"#1ABC9C"},nn={"Dept A":"#3498db","Dept B":"#e67e22","Dept C":"#2ecc71","Dept D":"#e74c9b"},on=["#95a5a6","#3498db","#2ecc71","#e67e22","#e74c3c"],ln=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];function nt(t){return t.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}function rn(t){return t.toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"short"})}function cn(t){return`<span class="badge" style="background:${on[t]}">L${t}</span>`}function dn(t){return`<span class="badge" style="background:${{Nitzan:"#16a085",Salsala:"#8e44ad",Hamama:"#c0392b"}[t]||"#7f8c8d"}">${t}</span>`}function un(t){return`<span class="badge" style="background:${nn[t]||"#7f8c8d"}">${t}</span>`}function We(t){return`<span class="badge badge-sm" style="background:${ue[t]||"#7f8c8d"}">${t}</span>`}function pn(t){const{participant:e,schedule:s}=t,a=U(),n=ut(),i=new Map;for(const c of s.tasks)i.set(c.id,c);const o=s.assignments.filter(c=>c.participantId===e.id).map(c=>({assignment:c,task:i.get(c.taskId)})).filter(c=>c.task);let r="";return r+=fn(e,o,t),r+='<div class="profile-grid">',r+='<div class="profile-left">',r+=gn(e,o,a,n),e.level===b.L1&&t.l1CycleState&&(r+=hn(t.l1CycleState,t.weekEnd,a,n)),r+="</div>",r+='<div class="profile-right">',r+=bn(e,o,a),r+=vn(e),r+="</div>",r+="</div>",r}function fn(t,e,s){let a="Available",n="status-available";if(t.level===b.L1&&s.l1CycleState){const o=dt(s.l1CycleState,s.weekEnd),c=Ee(o,new Date);c.inRest?(a=`Absolute Rest (until ${nt(c.restEndsAt)})`,n="status-rest"):(a="Active in Adanit Cycle",n="status-active")}e.filter(o=>o.task.type===S.Adanit).length>0&&t.level!==b.L1&&(a="Assigned to Adanit",n="status-active");const l=t.certifications.length>0?t.certifications.map(o=>dn(o)).join(" "):'<span class="text-muted">None</span>';return`
  <div class="profile-topbar">
    <button class="btn-back" data-action="back-to-schedule" title="Back to Full Schedule">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Back to Schedule</span>
    </button>
    <div class="profile-identity">
      <h2 class="profile-name">${t.name}</h2>
      <div class="profile-badges">
        ${cn(t.level)}
        ${un(t.group)}
        <span class="profile-status ${n}">${a}</span>
      </div>
      <div class="profile-certs">Certs: ${l}</div>
    </div>
    <div class="profile-summary-kpis">
      <div class="profile-kpi">
        <span class="profile-kpi-value">${e.filter(o=>!o.task.isLight).length}</span>
        <span class="profile-kpi-label">Heavy Tasks</span>
      </div>
      <div class="profile-kpi">
        <span class="profile-kpi-value">${e.filter(o=>o.task.isLight).length}</span>
        <span class="profile-kpi-label">Light Tasks</span>
      </div>
      <div class="profile-kpi">
        <span class="profile-kpi-value">${mn(e).toFixed(1)}h</span>
        <span class="profile-kpi-label">Weekly Hours</span>
      </div>
    </div>
  </div>`}function mn(t){return de(t).heavyHours}function gn(t,e,s,a){let i=`<div class="profile-card">
    <h3 class="profile-card-title">📅 Personal Agenda</h3>
    <div class="agenda-days">`;for(let l=1;l<=s;l++){const o=new Date(a.getFullYear(),a.getMonth(),a.getDate()+l-1),r=new Date(o.getFullYear(),o.getMonth(),o.getDate(),5,0),c=new Date(o.getFullYear(),o.getMonth(),o.getDate()+1,5,0),d=e.filter(({task:f})=>f.timeBlock.start.getTime()>=r.getTime()&&f.timeBlock.start.getTime()<c.getTime()).sort((f,m)=>f.task.timeBlock.start.getTime()-m.task.timeBlock.start.getTime()),u=rn(o);if(i+=`<div class="agenda-day ${l===1?"agenda-day-current":""}">
      <div class="agenda-day-header">
        <span class="agenda-day-label">Day ${l} · ${u}</span>
        <span class="agenda-day-count">${d.length} task${d.length!==1?"s":""}</span>
      </div>`,d.length===0)i+='<div class="agenda-empty">No assignments</div>';else{i+='<div class="agenda-tasks">';for(const{task:f}of d){const m=ue[f.type]||"#7f8c8d",g=(f.timeBlock.end.getTime()-f.timeBlock.start.getTime())/36e5,h=f.timeBlock.end.getTime()>c.getTime(),v=h?Math.ceil((f.timeBlock.end.getTime()-new Date(a.getFullYear(),a.getMonth(),a.getDate(),5,0).getTime())/864e5):0,k=h?`<span class="badge badge-sm" style="background:#555;color:#ffc107" title="Continues into Day ${v}">→ Day ${v}</span>`:"";i+=`<div class="agenda-task${h?" agenda-task-crossday":""}" style="border-left:3px solid ${m}">
          <div class="agenda-task-time">${nt(f.timeBlock.start)} – ${nt(f.timeBlock.end)}</div>
          <div class="agenda-task-info">
            <span class="agenda-task-name">${f.name}</span>
            ${We(f.type)}
            <span class="agenda-task-dur">${g.toFixed(1)}h</span>
            ${f.isLight?'<span class="badge badge-sm" style="background:#7f8c8d">Light</span>':""}
            ${k}
          </div>
        </div>`}i+="</div>"}i+="</div>"}return i+="</div></div>",i}function hn(t,e,s,a){const n=dt(t,e),i=5,l=new Date(a.getFullYear(),a.getMonth(),a.getDate(),i,0),o=new Date(a.getFullYear(),a.getMonth(),a.getDate()+s,i,0),r=o.getTime()-l.getTime();if(r<=0)return"";let c=`<div class="profile-card">
    <h3 class="profile-card-title">🔄 L1 Adanit Cycle (8-8-8-16)</h3>
    <p class="profile-card-subtitle">Stagger Group: ${t.staggerIndex} · Cycle Period: ${Ce}h</p>
    <div class="l1-timeline-container">`;c+='<div class="l1-timeline-days">';for(let d=0;d<=s;d++){const u=d/s*100;new Date(a.getFullYear(),a.getMonth(),a.getDate()+d);const p=d<s?`D${d+1}`:"";c+=`<span class="l1-day-marker" style="left:${u}%">${p}</span>`}c+="</div>",c+='<div class="l1-timeline-bar">';for(const d of n){const u=Math.max(d.start.getTime(),l.getTime()),p=Math.min(d.end.getTime(),o.getTime());if(p<=u)continue;const f=(u-l.getTime())/r*100,m=(p-u)/r*100;let g,h;switch(d.phase){case D.Work1:g="l1-phase-work",h="W1";break;case D.Work2:g="l1-phase-work",h="W2";break;case D.Rest8:g="l1-phase-rest8",h="R8";break;case D.Rest16:g="l1-phase-rest16",h="R16";break}const v=(p-u)/36e5,k=`${h} (${d.phase})
${nt(d.start)} – ${nt(d.end)}
${v.toFixed(0)}h`;c+=`<div class="l1-phase-block ${g}" style="left:${f}%;width:${m}%" title="${k}">
      <span class="l1-phase-label">${m>3?h:""}</span>
    </div>`}return c+="</div>",c+=`<div class="l1-legend">
    <span class="l1-legend-item"><span class="l1-legend-swatch l1-phase-work"></span> Work (8h)</span>
    <span class="l1-legend-item"><span class="l1-legend-swatch l1-phase-rest8"></span> Rest 8h</span>
    <span class="l1-legend-item"><span class="l1-legend-swatch l1-phase-rest16"></span> Absolute Rest 16h</span>
  </div>`,c+="</div></div>",c}function vn(t){const e=qe(t.id),s=le(t.id);let a=`<div class="profile-card">
    <h3 class="profile-card-title">🚫 Unavailability</h3>`;if(e.length>0){a+='<h4 class="profile-sub-title">Blackout Periods</h4><ul class="profile-list">';for(const n of e)a+=`<li>
        <strong>${nt(n.start)} – ${nt(n.end)}</strong>
        ${n.reason?`<span class="text-muted"> · ${n.reason}</span>`:""}
        <span class="badge badge-sm" style="background:#e74c3c;margin-left:6px">One-time</span>
      </li>`;a+="</ul>"}if(s.length>0){a+='<h4 class="profile-sub-title">Date-Specific Rules</h4><ul class="profile-list">';for(const n of s){const i=n.dayOfWeek!==void 0;let l;n.specificDate?l=n.specificDate:n.dayOfWeek!==void 0?l=`Every ${ln[n.dayOfWeek]}`:l="Unknown";const o=n.allDay?"All Day":`${String(n.startHour).padStart(2,"0")}:00 – ${String(n.endHour).padStart(2,"0")}:00`;a+=`<li>
        <strong>${l}</strong> — ${o}
        ${n.reason?`<span class="text-muted"> · ${n.reason}</span>`:""}
        <span class="badge badge-sm" style="background:${i?"#8e44ad":"#e74c3c"};margin-left:6px">${i?"Recurring":"Specific Date"}</span>
      </li>`}a+="</ul>"}return e.length===0&&s.length===0&&(a+='<p class="text-muted profile-empty-note">No unavailability rules configured. Participant is available 24/7.</p>'),a+="</div>",a}function bn(t,e,s){const a=s*24,{heavyHours:n,lightHours:i,typeHours:l,typeCounts:o}=de(e),r=n/a*100,c=r>25?"metric-danger":r>18?"metric-warning":"metric-ok";let d=`<div class="profile-card">
    <h3 class="profile-card-title">📊 Workload Metrics</h3>
    <div class="metrics-summary">
      <div class="metric-row">
        <span class="metric-label">Heavy Hours</span>
        <span class="metric-value">${n.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Light Hours</span>
        <span class="metric-value">${i.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Workload % (of ${a}h)</span>
        <span class="metric-value ${c}">${r.toFixed(1)}%</span>
      </div>
    </div>

    <h4 class="profile-sub-title" style="margin-top:16px">Breakdown by Task Type</h4>
    <div class="metrics-breakdown">`;const u=Math.max(...Object.values(l),1);for(const p of Object.values(S)){if(o[p]===0)continue;const f=ue[p]||"#7f8c8d",m=l[p]/u*100;d+=`<div class="breakdown-row">
      <span class="breakdown-label">${We(p)}</span>
      <div class="breakdown-bar-bg">
        <div class="breakdown-bar-fill" style="width:${m}%;background:${f}"></div>
      </div>
      <span class="breakdown-value">${o[p]}× · ${l[p].toFixed(1)}h</span>
    </div>`}return d+="</div></div>",d}function yn(t,e){t.addEventListener("click",s=>{const a=s.target.closest("[data-action]");a&&a.dataset.action==="back-to-schedule"&&e()})}let j="participants",N=null,L=null,ze=0,I=1,tt=!1,_t=!1,xt="SCHEDULE_VIEW",bt=null,Ue=0,ot=null;const Se=5,je={Adanit:"#4A90D9",Hamama:"#E74C3C",Shemesh:"#F39C12",Mamtera:"#27AE60",Karov:"#8E44AD",Karovit:"#BDC3C7",Aruga:"#1ABC9C"},kn={"Dept A":"#3498db","Dept B":"#e67e22","Dept C":"#2ecc71","Dept D":"#e74c9b"};function Gt(t){return t.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}function At(t){return t.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})+" "+Gt(t)}function Le(t){return t.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}function pe(t){return`<span class="badge" style="background:${["#95a5a6","#3498db","#2ecc71","#e67e22","#e74c3c"][t]}">L${t}</span>`}function fe(t){return`<span class="badge" style="background:${kn[t]||"#7f8c8d"}">${t}</span>`}function $n(t){return`<span class="badge badge-sm" style="background:${{Scheduled:"#27ae60",Locked:"#2980b9",Manual:"#f39c12",Conflict:"#e74c3c"}[t]||"#7f8c8d"}">${t}</span>`}function we(t){return`<span class="badge" style="background:${je[t]||"#7f8c8d"}">${t}</span>`}function ft(t){const e=ut(),s=new Date(e.getFullYear(),e.getMonth(),e.getDate()+t-1,Se,0),a=new Date(e.getFullYear(),e.getMonth(),e.getDate()+t,Se,0);return{start:s,end:a}}function ct(t,e){const{start:s,end:a}=ft(e);return t.timeBlock.start.getTime()<a.getTime()&&t.timeBlock.end.getTime()>s.getTime()}function Ke(t,e){const{start:s}=ft(e);return t.timeBlock.start.getTime()<s.getTime()}function Ye(t,e){const{end:s}=ft(e);return t.timeBlock.end.getTime()>s.getTime()}let Yt=0,Te=0;function Sn(){const t=U(),e=ut(),s=zt(),a=[];Yt=0,Te=0;for(let n=0;n<t;n++){const i=new Date(e.getFullYear(),e.getMonth(),e.getDate()+n),l=`D${n+1}`;for(const o of s){const r=new Date(i.getFullYear(),i.getMonth(),i.getDate(),o.startHour,0);let c;if(o.taskType===S.Aruga){const d=new Date(i.getFullYear(),i.getMonth(),i.getDate(),o.startHour,0),u=new Date(d.getTime()+o.durationHours*36e5),p=new Date(i.getFullYear(),i.getMonth(),i.getDate(),17,0),f=new Date(p.getTime()+o.durationHours*36e5);c=[{start:d,end:u},{start:p,end:f}]}else o.shiftsPerDay===1?c=[{start:r,end:new Date(r.getTime()+o.durationHours*36e5)}]:c=us(r,o.durationHours,o.shiftsPerDay);for(let d=0;d<c.length;d++){const u=c[d],p=[];for(const m of o.subTeams){const g=m.name.toLowerCase().includes("main")?Vt.SegolMain:m.name.toLowerCase().includes("secondary")?Vt.SegolSecondary:void 0;for(const h of m.slots)p.push({slotId:`${o.name.toLowerCase()}-slot-${++Yt}`,acceptableLevels:[...h.acceptableLevels],requiredCertifications:[...h.requiredCertifications],adanitTeam:g,label:h.label})}for(const m of o.slots)p.push({slotId:`${o.name.toLowerCase()}-slot-${++Yt}`,acceptableLevels:[...m.acceptableLevels],requiredCertifications:[...m.requiredCertifications],label:m.label});const f=o.shiftsPerDay>1?` Shift ${d+1}`:"";a.push({id:`${o.name.toLowerCase()}-d${n+1}-${++Te}`,type:o.taskType||S.Adanit,name:`${l} ${o.name}${f}`,timeBlock:u,requiredCount:p.length,slots:p,isLight:o.isLight,sameGroupRequired:o.sameGroupRequired})}}}return a}function Ut(t){return t.tasks.filter(e=>ct(e,I))}function me(t){const e=new Set(Ut(t).map(s=>s.id));return t.assignments.filter(s=>e.has(s.taskId))}function Ln(t,e,s){const a=U(),n=new Map;for(let l=1;l<=a;l++)n.set(l,0);const i=s??new Map(e.tasks.map(l=>[l.id,l]));for(const l of e.assignments){if(l.participantId!==t)continue;const o=i.get(l.taskId);if(o&&!o.isLight){for(let r=1;r<=a;r++)if(ct(o,r)){const{start:c,end:d}=ft(r),u=Math.max(o.timeBlock.start.getTime(),c.getTime()),p=Math.min(o.timeBlock.end.getTime(),d.getTime()),f=Math.max(0,(p-u)/36e5);n.set(r,(n.get(r)||0)+f)}}}return n}function wn(){const t=U(),e=ut();let s='<div class="day-navigator">';for(let a=1;a<=t;a++){const n=new Date(e.getFullYear(),e.getMonth(),e.getDate()+a-1),i=n.toLocaleDateString("en-GB",{weekday:"short"}),l=n.getDate();let o=0,r=0;if(L){o=L.tasks.filter(u=>ct(u,a)).length;const d=new Set(L.tasks.filter(u=>ct(u,a)).map(u=>u.id));r=L.violations.filter(u=>u.severity===x.Error&&u.taskId&&d.has(u.taskId)).length}const c=r>0?`<span class="day-violation-dot" title="${r} violation(s)">!</span>`:"";s+=`<button class="day-tab ${I===a?"day-tab-active":""}" data-day="${a}">
      <span class="day-tab-name">${i}</span>
      <span class="day-tab-num">${l}</span>
      <span class="day-tab-label">Day ${a}</span>
      ${o>0?`<span class="day-tab-count">${o} tasks</span>`:""}
      ${c}
    </button>`}return s+="</div>",s}function Tn(t){const e=t.score,s=U(),a=t.violations.filter(r=>r.severity===x.Error).length,n=t.violations.filter(r=>r.severity===x.Warning).length,i=t.feasible?"kpi-ok":"kpi-error",l=t.feasible?"✓ Feasible":"✗ Infeasible";let o="";for(let r=1;r<=s;r++){const c=t.tasks.filter(p=>ct(p,r)).length,d=t.violations.filter(p=>{if(p.severity!==x.Error||!p.taskId)return!1;const f=t.tasks.find(m=>m.id===p.taskId);return f?ct(f,r):!1}).length,u=d>0?"dot-error":c>0?"dot-ok":"dot-empty";o+=`<span class="week-dot ${u}" title="Day ${r}: ${c} tasks, ${d} violations"></span>`}return`<div class="weekly-dashboard">
    <div class="dashboard-row">
      <div class="kpi-group">
        <div class="kpi ${i}">
          <span class="kpi-value">${l}</span>
          <span class="kpi-label">${s}-Day Status</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${e.compositeScore.toFixed(1)}</span>
          <span class="kpi-label">Weekly Score</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${e.restStdDev.toFixed(2)}</span>
          <span class="kpi-label">Fairness (σ)</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${e.minRestHours.toFixed(1)}h</span>
          <span class="kpi-label">Min Rest</span>
        </div>
        <div class="kpi ${a>0?"kpi-error":"kpi-ok"}">
          <span class="kpi-value">${a}</span>
          <span class="kpi-label">Violations</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${n}</span>
          <span class="kpi-label">Warnings</span>
        </div>
      </div>
      <div class="week-dots-strip">
        <span class="week-dots-label">Days</span>
        <div class="week-dots">${o}</div>
      </div>
    </div>
    <div class="dashboard-meta">
      Best of ${Pt} attempts in ${ze}ms · ${t.participants.length} participants ·
      ${t.tasks.length} tasks · ${t.assignments.length} assignments
    </div>
  </div>`}function Dn(t){const e=gs(t.participants,t.assignments,t.tasks),s=U(),a=s*24;let n=0,i=0;for(const p of e.values())n+=p.totalHours,i++;const l=i>0?n/i:0,o=N?.getL1CycleStates()??new Map,r=N?.getWeekEnd()??new Date,c=new Map(t.tasks.map(p=>[p.id,p])),d=t.participants.map(p=>{const f=e.get(p.id)||{totalHours:0,nonLightCount:0},m=f.totalHours/a*100,g=Ln(p.id,t,c);let h=null;const v=o.get(p.id);if(v&&p.level===b.L1){const k=dt(v,r);let y="";for(let $=1;$<=s;$++){const{start:A}=ft($),M=new Date(A.getTime()+12*36e5),q=Ee(k,M);if(q.inRest){const F=q.restEndsAt?Gt(q.restEndsAt):"";y+=`<span class="cycle-dot cycle-rest" title="Day ${$}: Mandatory rest${F?" until "+F:""}">R</span>`}else y+=`<span class="cycle-dot cycle-work" title="Day ${$}: Available (work phase)">W</span>`}h=`<div class="cycle-strip" title="L1 Adanit Cycle (8-8-8-16)">${y}</div>`}return{p,w:f,pctOfPeriod:m,perDay:g,cycleInfo:h}}).sort((p,f)=>f.w.totalHours-p.w.totalHours);let u=`<div class="participant-sidebar">
    <div class="sidebar-header">
      <h3>Participant Status</h3>
      <div class="sidebar-avg">Avg: ${l.toFixed(1)}h · ${s}d (${a}h)</div>
    </div>
    <div class="sidebar-entries">`;for(const p of d){const f=p.p,g=Math.min(p.pctOfPeriod*(100/30),100),h=p.pctOfPeriod>25,v=p.pctOfPeriod<5,k=h?"wbar-over":v?"wbar-under":"wbar-normal";let y=[];for(let F=1;F<=U();F++){const X=p.perDay.get(F)||0;y.push(`D${F}: ${X.toFixed(1)}h`)}const $=p.perDay.get(I)||0,A=$/a,M=Math.min(A*100*(100/30),g),q=`${p.w.totalHours.toFixed(1)}h heavy / ${a}h period = ${p.pctOfPeriod.toFixed(1)}%
Assignments: ${p.w.nonLightCount} heavy tasks
`+y.join(" | ");u+=`<div class="sidebar-entry">
      <div class="sidebar-name">
        <span class="participant-hover" data-pid="${f.id}">${f.name}</span>
        <span class="sidebar-meta">${fe(f.group)} ${pe(f.level)}</span>
      </div>
      <div class="sidebar-bar-row">
        <div class="sidebar-bar-bg" title="${q}">
          <div class="sidebar-bar-fill ${k}" style="width:${g}%"></div>
          <div class="sidebar-bar-today" style="width:${M}%"></div>
          <span class="sidebar-bar-label">${p.w.totalHours.toFixed(1)}h (${p.pctOfPeriod.toFixed(1)}%)</span>
        </div>
        <span class="sidebar-today-tag" title="Today (Day ${I}): ${$.toFixed(1)}h">
          D${I}: ${$.toFixed(1)}h
        </span>
      </div>
      ${p.cycleInfo||""}
    </div>`}return u+="</div></div>",u}function In(){const t=ce();let e=`<div class="tab-toolbar">
    <div class="toolbar-left"><h2>Schedule View</h2>
      <span class="text-muted" style="margin-left:12px">${U()}-Day Schedule</span>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary ${_t&&L?"btn-generate-dirty":""}" id="btn-generate" ${!t.canGenerate||tt?"disabled":""}
        ${t.canGenerate?"":'title="Fix critical issues in Task Rules first"'}>
        ${tt?"⏳ Optimizing…":L?"🔄 Regenerate":"⚡ Generate Schedule"}
      </button>
    </div>
  </div>`;if(_t&&L&&(e+='<div class="dirty-notice">⚠ Schedule out of sync — Re-generate recommended</div>'),!t.canGenerate){const i=t.findings.filter(l=>l.severity==="Critical");e+=`<div class="alert alert-error">
      <strong>Cannot generate — ${i.length} critical issue(s):</strong>
      <ul>${i.map(l=>`<li>${l.message}</li>`).join("")}</ul>
      <p>Switch to <strong>Task Rules</strong> to resolve.</p>
    </div>`}if(!L)return t.canGenerate&&(e+=`<div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No schedule generated yet.</p>
        <p class="text-muted">Configure participants and task rules, then click "Generate Schedule".</p>
      </div>`),e;const s=L;e+=Tn(s),e+=wn();const{start:a,end:n}=ft(I);return e+=`<div class="day-window-label">
    Showing <strong>Day ${I}</strong>: ${Le(a)} ${Gt(a)} – ${Le(n)} ${Gt(n)}
  </div>`,e+='<div class="schedule-layout">',e+='<div class="schedule-main">',e+=`<section><h2>Assignments <span class="count">${me(s).length}</span></h2>${An(s)}</section>`,e+=`<section><h2>Gantt Timeline</h2>${Mn(s)}</section>`,e+=`<section><h2>Constraint Violations <span class="count">${s.violations.length}</span></h2>${Cn(s)}</section>`,e+=`<section><h2>Rest Fairness</h2>${En(s)}</section>`,e+="</div>",e+=Dn(s),e+="</div>",e+=Ve(),e}function Cn(t){const e=t.violations.filter(i=>i.severity===x.Error),s=t.violations.filter(i=>i.severity===x.Warning);if(e.length===0&&s.length===0)return'<div class="alert alert-ok">✓ No constraint violations across all 7 days.</div>';const a=new Set(Ut(t).map(i=>i.id));let n="";if(e.length>0){const i=e.filter(o=>o.taskId&&a.has(o.taskId)),l=e.filter(o=>!o.taskId||!a.has(o.taskId));if(n+=`<div class="alert alert-error"><strong>Hard Violations (${e.length})</strong>`,i.length>0){n+=`<div class="violation-section"><em>Day ${I}:</em><ul>`;for(const o of i)n+=`<li><code>${o.code}</code> ${o.message}</li>`;n+="</ul></div>"}if(l.length>0){n+='<div class="violation-section violation-other"><em>Other days:</em><ul>';for(const o of l)n+=`<li><code>${o.code}</code> ${o.message}</li>`;n+="</ul></div>"}n+="</div>"}if(s.length>0){n+=`<div class="alert alert-warn"><strong>Warnings (${s.length})</strong><ul>`;for(const i of s)n+=`<li><code>${i.code}</code> ${i.message}</li>`;n+="</ul></div>"}return n}function An(t){const e=Ut(t),s=me(t),a=new Map;for(const r of e)a.set(r.id,r);const n=new Map;for(const r of t.participants)n.set(r.id,r);const i=new Map;for(const r of s){const c=i.get(r.taskId)||[];c.push(r),i.set(r.taskId,c)}const l=[...e].sort((r,c)=>r.timeBlock.start.getTime()-c.timeBlock.start.getTime());let o=`<div class="table-responsive"><table class="table">
    <thead><tr><th>Task</th><th>Type</th><th>Time</th><th>Slot</th><th>Participant</th>
    <th>Level</th><th>Group</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;for(const r of l){const c=i.get(r.id)||[],d=Ke(r,I),u=Ye(r,I);let p="";if(d&&u?p=`<span class="cross-day-badge cross-both" title="Continues from Day ${I-1} into Day ${I+1}">◀ ▶</span>`:d?p=`<span class="cross-day-badge cross-from" title="Continued from Day ${I-1}">◀ from D${I-1}</span>`:u&&(p=`<span class="cross-day-badge cross-to" title="Continues into Day ${I+1}">▶ to D${I+1}</span>`),c.length===0){o+=`<tr class="row-warning"><td><strong>${r.name}</strong> ${p}</td><td>${we(r.type)}</td>
        <td>${At(r.timeBlock.start)}–${At(r.timeBlock.end)}</td>
        <td colspan="6"><em class="text-danger">⚠ No assignments</em></td></tr>`;continue}c.forEach((f,m)=>{const g=n.get(f.participantId),h=r.slots.find(v=>v.slotId===f.slotId);o+=`<tr class="${f.status===P.Conflict?"row-error":""}" data-assignment-id="${f.id}">`,m===0&&(o+=`<td rowspan="${c.length}" class="task-cell" style="border-left:4px solid ${je[r.type]||"#999"}">
          <strong>${r.name}</strong>${r.isLight?" <small>(Light)</small>":""} ${p}</td>
          <td rowspan="${c.length}">${we(r.type)}</td>
          <td rowspan="${c.length}">${At(r.timeBlock.start)}–${At(r.timeBlock.end)}</td>`),o+=`<td><small>${h?.label||f.slotId}</small></td>
        <td><strong class="participant-hover" data-pid="${g?.id||""}">${g?.name||"???"}</strong></td>
        <td>${g?pe(g.level):"—"}</td>
        <td>${g?fe(g.group):"—"}</td>
        <td>${$n(f.status)}</td>
        <td>
          <button class="btn-swap" data-assignment-id="${f.id}" data-task-id="${r.id}" title="Swap">⇄</button>
          <button class="btn-lock" data-assignment-id="${f.id}" title="Lock/Unlock">🔒</button>
        </td></tr>`})}return o+="</tbody></table></div>",o}function En(t){const e=Me(t.participants,t.assignments,t.tasks),s=Re(e);let a=`<div class="rest-summary">
    <span><strong>Min Rest:</strong> ${isFinite(s.globalMinRest)?s.globalMinRest.toFixed(1)+"h":"N/A"}</span>
    <span><strong>Avg Rest:</strong> ${isFinite(s.globalAvgRest)?s.globalAvgRest.toFixed(1)+"h":"N/A"}</span>
    <span><strong>Std Dev:</strong> ${s.stdDevRest.toFixed(2)}</span>
  </div>`;a+=`<div class="table-responsive"><table class="table">
    <thead><tr><th>Participant</th><th>Group</th><th>Level</th><th>Non-Light</th>
    <th>Work Hours</th><th>Min Rest</th><th>Avg Rest</th><th>Gaps</th></tr></thead><tbody>`;const n=[...e.entries()].sort((i,l)=>i[1].minRestHours-l[1].minRestHours);for(const[i,l]of n){const o=t.participants.find(p=>p.id===i);if(!o)continue;const r=l.minRestHours<4?"text-danger":l.minRestHours<8?"text-warn":"",c=isFinite(l.minRestHours)?l.minRestHours.toFixed(1)+"h":"—",d=isFinite(l.avgRestHours)?l.avgRestHours.toFixed(1)+"h":"—",u=l.restGaps.length>0?l.restGaps.map(p=>p.toFixed(1)+"h").join(", "):"—";a+=`<tr><td><strong>${o.name}</strong></td><td>${fe(o.group)}</td>
      <td>${pe(o.level)}</td><td>${l.nonLightAssignmentCount}</td>
      <td>${l.totalWorkHours.toFixed(1)}h</td><td class="${r}"><strong>${c}</strong></td>
      <td>${d}</td><td><small>${u}</small></td></tr>`}return a+="</tbody></table></div>",a}function Mn(t){const e=Ut(t),s=me(t),a={...t,tasks:e,assignments:s},n=ea(a),i=n.timelineEndMs-n.timelineStartMs;if(i<=0)return"<p>No timeline data for this day.</p>";const l=i/36e5,o=l<=26?1:2;let r='<div class="gantt-container"><div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-timeline-col">';for(let c=0;c<=l;c+=o){const d=c/l*100,u=new Date(n.timelineStartMs+c*36e5);r+=`<span class="gantt-hour-mark" style="left:${d}%">${u.getHours().toString().padStart(2,"0")}:00</span>`}r+="</div></div>";for(const c of n.rows)if(c.blocks.length!==0){r+=`<div class="gantt-row"><div class="gantt-label-col">
      <span class="gantt-name participant-hover" data-pid="${c.participantId}">${c.participantName}</span>
      <span class="gantt-meta">${c.group} · L${c.level}</span>
    </div><div class="gantt-timeline-col">`;for(const d of c.blocks){const u=(d.startMs-n.timelineStartMs)/i*100,p=d.durationMs/i*100,f=e.find(k=>k.id===d.taskId),m=f&&Ke(f,I),g=f&&Ye(f,I),h=m?"gantt-cross-from":g?"gantt-cross-to":"",v=`${d.taskName}&#10;${new Date(d.startMs).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} – ${new Date(d.endMs).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}${m?"&#10;◀ Continued from previous day":""}${g?"&#10;▶ Continues to next day":""}`;r+=`<div class="gantt-block ${d.isLight?"gantt-light":""} ${h}" style="left:${u}%;width:${p}%;background:${d.color}" title="${v}">
        <span class="gantt-block-text">${m?"◀ ":""}${d.taskName}${g?" ▶":""}</span></div>`}r+="</div></div>"}return r+="</div>",r}const Pt=40;function Ve(){if(!tt||!ot)return"";const{attempt:t,totalAttempts:e,bestScore:s,bestUnfilled:a,lastImproved:n}=ot,i=Math.round(t/e*100);return`<div class="optim-overlay">
    <div class="optim-card">
      <div class="optim-spinner"></div>
      <h3>Evaluating ${e} scenarios for maximum fairness…</h3>
      <div class="optim-progress-bar">
        <div class="optim-progress-fill" style="width:${i}%"></div>
      </div>
      <div class="optim-status">
        Attempt <strong>${t}</strong> / ${e}
        ${n?'<span class="optim-improved">★ Improved!</span>':""}
      </div>
      <div class="optim-metrics">
        <div class="optim-metric">
          <span class="optim-metric-label">Best Score</span>
          <span class="optim-metric-value">${s.toFixed(1)}</span>
        </div>
        <div class="optim-metric">
          <span class="optim-metric-label">Unfilled Slots</span>
          <span class="optim-metric-value ${a===0?"optim-ok":"optim-warn"}">${a}</span>
        </div>
      </div>
    </div>
  </div>`}function Rn(){let t=document.querySelector(".optim-overlay");const e=Ve();if(!e){t?.remove();return}if(t){const s=document.createElement("div");s.innerHTML=e,t.replaceWith(s.firstElementChild)}else{const s=document.getElementById("tab-content");s&&s.insertAdjacentHTML("beforeend",e)}}async function xn(){if(tt)return;const t=Dt(),e=Sn();N=new Xs({maxIterations:6e3,maxSolverTimeMs:15e3}),N.addParticipants(t),N.addTasks(e),j="schedule",tt=!0,ot={attempt:0,totalAttempts:Pt,bestScore:-1/0,bestUnfilled:1/0,lastImproved:!1},_();const s=document.getElementById("btn-generate");s&&(s.disabled=!0,s.textContent="⏳ Optimizing…");const a=performance.now();try{L=await N.generateScheduleAsync(Pt,i=>{ot={attempt:i.attempt,totalAttempts:i.totalAttempts,bestScore:i.currentBestScore,bestUnfilled:i.currentBestUnfilled,lastImproved:i.improved},Rn()}),ze=Math.round(performance.now()-a),I=1,_t=!1}catch(n){console.error("[Scheduler] All optimization attempts failed:",n);const i=document.querySelector(".optim-overlay .optim-card");if(i){i.innerHTML=`
        <div class="optim-error">
          <h3>⚠ Optimization Failed</h3>
          <p>Could not find a valid solution within ${Pt} attempts.</p>
          <p>Please check your constraints and participant availability.</p>
          <button class="btn-primary" id="btn-dismiss-error">Dismiss</button>
        </div>`;const l=document.getElementById("btn-dismiss-error");l&&l.addEventListener("click",()=>{tt=!1,ot=null,_()});return}}finally{tt=!1,ot=null}_()}function Je(){if(!N||!L)return;const t=N.validate(),e=L.violations.filter(s=>s.severity===x.Warning);L={...L,violations:[...t.violations,...e],feasible:t.valid},_()}function Pn(t){if(!L||!N)return;const e=L.assignments.find(r=>r.id===t);if(!e)return;const s=L.tasks.find(r=>r.id===e.taskId);if(!s)return;const a=L.participants.find(r=>r.id===e.participantId),n=L.participants.filter(r=>r.id!==e.participantId).map(r=>`${r.name} (L${r.level}, ${r.group})`).join(`
`),i=prompt(`Swap in "${s.name}".
Currently: ${a?.name}

Enter participant name:

${n}`);if(!i)return;const l=L.participants.find(r=>i.includes(r.name)||i===r.id);if(!l){alert("Participant not found.");return}const o=N.swapParticipant({assignmentId:t,newParticipantId:l.id});if(L=N.getSchedule(),!o.valid){const r=o.violations.map(c=>`[${c.code}] ${c.message}`).join(`
`);alert(`⚠ Swap created violations across the 7-day schedule:

${r}`)}Je()}function Hn(t){if(!L||!N)return;const e=L.assignments.find(s=>s.id===t);e&&(e.status===P.Locked?N.unlockAssignment(t):N.lockAssignment(t),L=N.getSchedule(),Je())}function _(){const t=document.getElementById("app");if(xt==="PROFILE_VIEW"&&bt&&L){Xe();const l=L.participants.find(o=>o.id===bt);if(!l)xt="SCHEDULE_VIEW",bt=null;else{const o=N?.getL1CycleStates()??new Map,r=N?.getWeekEnd()??new Date,c={participant:l,schedule:L,l1CycleState:o.get(l.id),weekEnd:r};t.innerHTML=`<div class="profile-view-root">${pn(c)}</div>`;const d=t.querySelector(".profile-view-root");yn(d,()=>{xt="SCHEDULE_VIEW",bt=null,_(),requestAnimationFrame(()=>window.scrollTo(0,Ue))});return}}const e=Dt(),s=zt(),a=ce();let n=`
  <header>
    <div class="header-top">
      <h1>⏱ Resource Scheduling Engine</h1>
      <div class="undo-redo-group">
        <button class="btn-sm btn-outline" id="btn-undo" ${it().canUndo?"":"disabled"}
          title="Undo (Ctrl+Z)">↩ Undo${it().undoDepth?" ("+it().undoDepth+")":""}</button>
        <button class="btn-sm btn-outline" id="btn-redo" ${it().canRedo?"":"disabled"}
          title="Redo (Ctrl+Y)">↪ Redo${it().redoDepth?" ("+it().redoDepth+")":""}</button>
      </div>
    </div>
    <p class="subtitle">
      ${ut().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}
      · ${U()}-Day Schedule
      · ${e.length} Participants
      · ${s.length} Task Templates
    </p>
  </header>

  <nav class="tab-nav">
    <button class="tab-btn ${j==="participants"?"tab-active":""}" data-tab="participants">
      👥 Participants <span class="count">${e.length}</span>
    </button>
    <button class="tab-btn ${j==="task-rules"?"tab-active":""}" data-tab="task-rules">
      📋 Task Rules <span class="count">${s.length}</span>
      ${a.canGenerate?"":'<span class="badge badge-sm" style="background:var(--danger);margin-left:4px">!</span>'}
    </button>
    <button class="tab-btn ${j==="schedule"?"tab-active":""}" data-tab="schedule">
      📊 Schedule View
      ${L?'<span class="badge badge-sm" style="background:var(--success);margin-left:4px">✓</span>':""}
    </button>
  </nav>

  <div class="tab-content" id="tab-content">`;switch(j){case"participants":n+=Na();break;case"task-rules":n+=Za();break;case"schedule":n+=In();break}n+="</div>",t.innerHTML=n,Bn(t),qn(t);const i=document.getElementById("tab-content");j==="participants"?za(i,_):j==="task-rules"?an(i,_):j==="schedule"&&Nn(i)}function Bn(t){t.querySelectorAll(".tab-btn").forEach(e=>{e.addEventListener("click",()=>{const s=e.dataset.tab;s&&s!==j&&(j=s,_())})})}function Wt(t){(t==="undo"?ia():oa())&&_()}function qn(t){const e=t.querySelector("#btn-undo"),s=t.querySelector("#btn-redo");e&&e.addEventListener("click",()=>Wt("undo")),s&&s.addEventListener("click",()=>Wt("redo"))}function Nn(t){const e=t.querySelector("#btn-generate");e&&e.addEventListener("click",xn),t.querySelectorAll(".day-tab").forEach(s=>{s.addEventListener("click",()=>{const a=parseInt(s.dataset.day||"1",10);a!==I&&a>=1&&(I=a,_())})}),t.querySelectorAll(".btn-swap").forEach(s=>{s.addEventListener("click",a=>{Pn(a.target.dataset.assignmentId)})}),t.querySelectorAll(".btn-lock").forEach(s=>{s.addEventListener("click",a=>{Hn(a.target.dataset.assignmentId)})}),_n(t),t.addEventListener("click",s=>{const a=s.target.closest(".participant-hover[data-pid]");if(!a)return;const n=a.dataset.pid;n&&On(n)})}let kt=null,J=null;function Xe(){J&&(clearTimeout(J),J=null),kt&&(kt.style.display="none")}function On(t){L&&(Ue=window.scrollY,xt="PROFILE_VIEW",bt=t,Xe(),_(),window.scrollTo(0,0))}function De(){if(kt)return kt;const t=document.createElement("div");return t.className="participant-tooltip",t.style.display="none",document.body.appendChild(t),t.addEventListener("mouseenter",()=>{J&&(clearTimeout(J),J=null)}),t.addEventListener("mouseleave",()=>{t.style.display="none"}),kt=t,t}function Fn(t){const s=U()*24;let a={heavyHours:0,heavyCount:0,lightCount:0,typeHours:{},typeCounts:{}};if(L){const m=new Map;for(const h of L.tasks)m.set(h.id,h);const g=L.assignments.filter(h=>h.participantId===t.id).map(h=>({task:m.get(h.taskId)})).filter(h=>h.task);a=de(g)}const{heavyHours:n,heavyCount:i,lightCount:l,typeHours:o,typeCounts:r}=a,c=n/s*100,d=t.certifications.length>0?t.certifications.map(m=>`<span class="tt-cert" style="background:${{Nitzan:"#16a085",Salsala:"#8e44ad",Hamama:"#c0392b"}[m]||"#7f8c8d"}">${m}</span>`).join(" "):'<span class="tt-dim">None</span>',u=["#95a5a6","#3498db","#2ecc71","#e67e22","#e74c3c"],p={Adanit:"#e67e22",Hamama:"#c0392b",Shemesh:"#2ecc71",Mamtera:"#9b59b6",Karov:"#3498db",Karovit:"#7f8c8d",Aruga:"#e74c3c"},f=Object.values(S).filter(m=>r[m]>0).map(m=>`<div class="tt-row">
        <span class="tt-label"><span style="color:${p[m]||"#7f8c8d"};font-weight:600">${m}</span></span>
        <span class="tt-value">${r[m]}× · ${o[m].toFixed(1)}h</span>
      </div>`).join("");return`
    <div class="tt-header">
      <span class="tt-name">${t.name}</span>
      <span class="tt-level" style="background:${u[t.level]}">L${t.level}</span>
    </div>
    <div class="tt-row"><span class="tt-label">Group</span><span class="tt-value">${t.group}</span></div>
    <div class="tt-row"><span class="tt-label">Certs</span><span class="tt-value">${d}</span></div>
    <div class="tt-divider"></div>
    ${f}
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">Heavy tasks</span><span class="tt-value">${i}</span></div>
    <div class="tt-row"><span class="tt-label">Light tasks</span><span class="tt-value">${l}</span></div>
    <div class="tt-row"><span class="tt-label">Weekly hours</span><span class="tt-value tt-bold">${n.toFixed(1)}h</span></div>
    <div class="tt-row"><span class="tt-label">Workload %</span><span class="tt-value">${c.toFixed(1)}% of ${s}h</span></div>
  `}function _n(t){if(!L)return;const e=new Map;for(const s of L.participants)e.set(s.id,s);t.addEventListener("mouseover",s=>{const a=s.target.closest(".participant-hover");if(!a)return;const n=a.dataset.pid;if(!n)return;const i=e.get(n);if(!i)return;J&&(clearTimeout(J),J=null);const l=De();l.innerHTML=Fn(i),l.style.display="block";const o=a.getBoundingClientRect();let r=o.right+8,c=o.top-4;const d=280,u=260;r+d>window.innerWidth&&(r=o.left-d-8),c+u>window.innerHeight&&(c=window.innerHeight-u-8),c<4&&(c=4),l.style.left=`${r}px`,l.style.top=`${c}px`}),t.addEventListener("mouseout",s=>{s.target.closest(".participant-hover")&&(J=setTimeout(()=>{const n=De();n.style.display="none"},120))})}function Gn(){if(tt||!L)return;_t=!0;const t=new Set(Dt().map(a=>a.id)),e=L.assignments.length,s=L.assignments.filter(a=>t.has(a.participantId));s.length!==e&&(L={...L,assignments:s,participants:L.participants.filter(a=>t.has(a.id))})}function Wn(){Ia(),aa(Gn),_(),document.addEventListener("keydown",t=>{(t.ctrlKey||t.metaKey)&&!t.shiftKey&&t.key==="z"?(t.preventDefault(),Wt("undo")):(t.ctrlKey||t.metaKey)&&(t.key==="y"||t.shiftKey&&t.key==="z"||t.shiftKey&&t.key==="Z")&&(t.preventDefault(),Wt("redo")),j==="schedule"&&L&&(t.key==="ArrowRight"&&I<U()?(I++,_()):t.key==="ArrowLeft"&&I>1&&(I--,_()))})}document.addEventListener("DOMContentLoaded",Wn);
//# sourceMappingURL=index-BqmJZJ3d.js.map
