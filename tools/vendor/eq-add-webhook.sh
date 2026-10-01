#!/usr/bin/env bash
# Add the Generic Webhook (JSON → our intake URL) to one EverQuote campaign, with a dry-run check before the real save.
# Usage: eq-add-webhook.sh <campaignId>
set -u
CID="$1"
cd "/c/Users/Tony Ballo/OneDrive/Desktop/MSICRM/tools/vendor" || exit 1
URL_EQ="$(node intake-ping.js url eq)"
P="node portal.js everquote"
step() { "$@" 2>&1 | tail -1; }

step $P newtab "https://pro.everquote.com/eq/campaign-management/01J6W4N7CVJBZWQJ416VR36DD3/campaigns"
step $P click "a[href\$=\"/campaigns/$CID\"]"
echo "BEFORE: $($P eval "(()=>{const t=document.body.innerText.replace(/\n+/g,' | ');const n=t.indexOf('CAMPAIGNS | ');const i=t.indexOf('Lead Management System:');const j=t.indexOf('Email Delivery',i);const h=t.indexOf('Hours | ');return t.slice(n+12,n+60).split(' | ')[0]+' :: '+t.slice(i,j)+' :: '+t.slice(h,h+70);})()" 2>&1 | tail -1)"
if $P eval "document.body.innerText.includes('Generic Webhook')" 2>&1 | tail -1 | grep -q true; then echo "ALREADY HAS Generic Webhook: skipping"; exit 0; fi
step $P click 'text=Delivery'
step $P click 'button[aria-label="Multi typeahead menu toggle for Select a lead management system"]'
step $P eval "(()=>{const o=[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='Generic Webhook'); if(!o) return 'option not found'; (o.querySelector('button,input,label')||o).click(); return 'selected Generic Webhook';})()"
$P press Escape >/dev/null 2>&1
step $P eval "(()=>{const inp=[...document.querySelectorAll('input')].find(i=>i.placeholder==='Select a Data Format'); if(!inp) return 'format input not found'; inp.click(); return 'opened format list';})()"
step $P eval "(()=>{const o=[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='JSON Payload Format'); if(!o) return 'JSON option not found'; (o.querySelector('button,input,label')||o).click(); return 'chose JSON';})()"
TAG="$($P eval "(()=>{const labs=[...document.querySelectorAll('label,span,div')].filter(e=>e.children.length<=2&&(e.innerText||'').trim().replace(/\s*\*\s*\$/,'')==='Post URL'); const cands=[]; labs.forEach(l=>{let b=l; for(let k=0;k<5&&b;k++){b=b.parentElement; const i=b&&b.querySelector('input[type=text],input:not([type])'); if(i){cands.push(i);break;}}}); const empty=[...new Set(cands)].filter(i=>!i.value); if(empty.length!==1) return 'ERR expected 1 empty Post URL input, found '+empty.length; empty[0].setAttribute('data-claude','webhook-url'); return 'tagged';})()" 2>&1 | tail -1)"
echo "post url field: $TAG"
[ "$TAG" = "tagged" ] || { echo "ABORT: could not find the webhook URL field"; $P click 'text=Cancel' >/dev/null 2>&1; exit 1; }
step $P fill '[data-claude="webhook-url"]' "$URL_EQ"

# Dry run: capture what Save would write and check it.
DRY="$($P dryclick 'text=Save & continue' 'pro-campaigns.everquote.com' 2>&1)"
CHECK="$(printf '%s' "$DRY" | EXPECT_URL="$URL_EQ" node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=d.indexOf('[');let arr;try{arr=JSON.parse(d.slice(i,d.lastIndexOf(']')+1));}catch(e){console.log('ERR unparsable dry run');return;}
const patch=arr.filter(r=>r.method==='PATCH');if(patch.length!==1){console.log('ERR expected 1 PATCH, got '+patch.length);return;}
const b=patch[0].body;const keys=Object.keys(b).sort().join(',');const ds=b.deliverySettings||[];const types=ds.map(s=>s.deliveryType);
const g=ds.filter(s=>s.integrationId==='generic_eq');
const problems=[];
if(keys!=='deliverySettings,leadTypes,locationSet')problems.push('unexpected keys '+keys);
if(g.length!==1)problems.push('generic webhook entries: '+g.length);
else{if(g[0].deliveryDetails.data_format!=='JSON')problems.push('format '+g[0].deliveryDetails.data_format);}
for(const need of ['Email','Ricochet','DYL','PL Rater'])if(!types.includes(need))problems.push('missing '+need);
if(ds.length!==5)problems.push('expected 5 delivery entries, got '+ds.length);
console.log(problems.length?'ERR '+problems.join('; '):'OK '+types.join(', '));});")"
echo "dry run: $CHECK"
case "$CHECK" in OK*) ;; *) echo "ABORT: dry run did not look right, cancelling without saving"; $P click 'text=Cancel' >/dev/null 2>&1; exit 1;; esac
# The dry run redacts the URL's key, so confirm the field itself holds the exact URL.
LEN="$($P eval "document.querySelector('[data-claude=\"webhook-url\"]').value === '$URL_EQ'" 2>&1 | tail -1)"
echo "url field exact match: $LEN"
[ "$LEN" = "true" ] || { echo "ABORT: URL field mismatch"; $P click 'text=Cancel' >/dev/null 2>&1; exit 1; }

step $P click 'text=Save & continue'
echo "result: $($P eval "[...document.querySelectorAll('[role=alert],[class*=alert]')].map(a=>a.innerText.trim().replace(/\n+/g,' ')).filter(t=>/success|error|fail/i.test(t)).slice(0,2).join(' / ')||'(no success/error alert visible)'" 2>&1 | tail -1)"
$P click 'text=Summary' >/dev/null 2>&1
echo "AFTER:  $($P eval "(()=>{const t=document.body.innerText.replace(/\n+/g,' | ');const i=t.indexOf('Lead Management System:');const j=t.indexOf('Email Delivery',i);const h=t.indexOf('Hours | ');return t.slice(i,j)+' :: '+t.slice(h,h+70);})()" 2>&1 | tail -1)"
